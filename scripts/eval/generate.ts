// Run using backend/node_modules/tsx/dist/cli.mjs; config alone loads credentials.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ROOT, OUT, MODELS, VARIANTS, EVAL_SOURCES, requestFor, han, hash, humanText, aiPath, loadSample, jsonl, atomic, writeJSON, writeJSONL } from './common.mjs';

async function main() {
  const args = process.argv.slice(2);
  const concurrency = Number(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? 4);
  const limit = Number(args.find(a => a.startsWith('--limit='))?.split('=')[1] ?? Infinity);
  if (![3, 4].includes(concurrency) || !(limit >= 1)) throw new Error('Use --concurrency=3|4 and optional --limit=N');
  const sample = loadSample();
  const jobs = sample.flatMap(row => VARIANTS.flatMap(variant => MODELS.map(model => ({ row, variant, model })))).slice(0, limit);
  if (args.includes('--dry-run')) {
    console.log(JSON.stringify({ outputs: jobs.length, models: MODELS, concurrency,
      human_han: sample.reduce((s, r) => s + r.char_count, 0),
      note: '1800 outputs; rewrite uses one title request plus ceil(body paragraphs/12) requests; configured reasoning retained; no network calls' }, null, 2));
    return;
  }
  process.chdir(path.join(ROOT, 'backend'));
  const src = (file: string) => pathToFileURL(path.join(ROOT, 'backend/src', file)).href;
  const { config } = await import(src('core/config.ts'));
  if (!config.llm.apiKey) throw new Error('No configured LLM API key; config imported, no credential values inspected or logged');
  const { antiAiRules } = await import(src('prompts/rules.ts'));
  const { rewriteDocument } = await import(src('services/rewrite.ts'));
  const { parseJson } = await import(src('lib/json.ts'));
  const require = createRequire(path.join(ROOT, 'backend/package.json'));
  const OpenAI = require('openai').default;
  const client = new OpenAI({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey, maxRetries: 0, timeout: 600_000 });
  const omit = new Set(['', 'off', 'none', 'false', '0']);
  const extra: Record<string, unknown> = {};
  const thinking = config.llm.thinkingType.trim().toLowerCase();
  if (config.llm.thinkingType && !omit.has(thinking)) extra.thinking = { type: config.llm.thinkingType };
  if (thinking !== 'disabled' && config.llm.reasoningEffort && !omit.has(config.llm.reasoningEffort.toLowerCase())) extra.reasoning_effort = config.llm.reasoningEffort;
  const settings = { baseURL: config.llm.baseURL, temperature: config.llm.temperature, ...extra };
  const sourceHashes = Object.fromEntries(['prompts/rules.ts', 'prompts/rewrite.prompts.ts', 'services/rewrite.ts', 'lib/json.ts'].map(f => [f, hash(fs.readFileSync(path.join(ROOT, 'backend/src', f), 'utf8'))]));
  const eventsFile = path.join(OUT, 'api-events.jsonl');
  fs.mkdirSync(OUT, { recursive: true });
  const log = (event: any) => fs.appendFileSync(eventsFile, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  const started = new Date().toISOString();
  const runId = started.replace(/[:.]/g, '-');
  let active = 0, attempted = 0, failedRequests = 0, settledRequests = 0, retries = 0, failures = 0, completed = 0, skipped = 0, cursor = 0;
  let abortReason = '';
  const waiters: (() => void)[] = [];
  async function acquire() {
    if (active >= concurrency) await new Promise<void>(resolve => waiters.push(resolve));
    active++;
  }
  function release() { active--; waiters.shift()?.(); }
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const failure = (reason: string) => Object.assign(new Error(reason), { safeReason: reason });
  function safeError(e: any) {
    if (e.safeReason) return e.safeReason;
    const status = Number(e.status);
    return Number.isFinite(status) ? `HTTP ${status}` : e.name === 'APIConnectionTimeoutError' ? 'API timeout' : 'API connection/request failure';
  }
  function checkCircuit() {
    if (settledRequests >= 10 && failedRequests / settledRequests > 0.10) abortReason ||= `Aborted: ${failedRequests}/${settledRequests} logical API calls failed after retries (>10%)`;
  }
  async function ask(model: string, prompt: string, opts: any, validate: (s: string) => void, refs: Set<string>) {
    const request = { model, temperature: opts?.temperature ?? config.llm.temperature,
      messages: [...(opts?.system ? [{ role: 'system', content: opts.system }] : []), { role: 'user', content: prompt }], stream: false, ...extra };
    const key = hash(JSON.stringify({ request, baseURL: settings.baseURL }));
    refs.add(key);
    const cache = path.join(OUT, 'api-cache', model, `${key}.json`);
    if (fs.existsSync(cache)) {
      const saved = JSON.parse(fs.readFileSync(cache, 'utf8'));
      if (saved.prompt_hash === key && hash(saved.content) === saved.content_sha256) { validate(saved.content); return saved.content; }
      throw failure('Corrupt API cache; preserve and inspect cache before resuming');
    }
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (abortReason) throw failure(abortReason);
      await acquire();
      if (abortReason) { release(); throw failure(abortReason); }
      attempted++;
      try {
        log({ type: 'attempt', run_id: runId, model, prompt_hash: key, attempt });
        const res = await client.chat.completions.create(request);
        const usage = res.usage ?? null;
        log({ type: 'response', run_id: runId, model, prompt_hash: key, attempt, usage, finish_reason: res.choices[0]?.finish_reason });
        const content = res.choices[0]?.message?.content ?? '';
        if (res.choices[0]?.finish_reason !== 'stop') throw failure('Non-stop finish (truncation, filtering, or unsupported response)');
        if (!content.trim()) throw failure('Empty completion');
        validate(content);
        writeJSON(cache, { prompt_hash: key, created_at: new Date().toISOString(), content, content_sha256: hash(content), usage });
        settledRequests++;
        return content;
      } catch (e: any) {
        const reason = safeError(e), status = Number(e.status);
        log({ type: 'failure', run_id: runId, model, prompt_hash: key, attempt, reason });
        failures++;
        // Configuration/model errors will not recover by spending more requests.
        const terminal = [400, 401, 402, 403, 404, 422].includes(status);
        if (attempt === 4 || terminal) {
          failedRequests++; settledRequests++;
          if (terminal) abortReason ||= `Aborted: ${model} returned ${reason}; model/configuration/billing request rejected (no credentials logged)`;
          checkCircuit();
          throw failure(reason);
        }
        retries++;
        console.log(`Retry ${model} attempt ${attempt + 1}/4: ${reason}`);
      } finally { release(); }
      await sleep(Math.min(30_000, 1500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400));
    }
    throw failure('Retries exhausted');
  }
  async function runJob(job: any) {
    const { row, model, variant } = job;
    const file = aiPath(row, model, variant), sidecar = file + '.json';
    const human = humanText(row), prompt = requestFor(row);
    const system = variant === 'humanized' ? antiAiRules('zh') : undefined;
    const paragraphs = [{ index: 0, kind: 'heading1', text: row.title }, ...human.split(/\r?\n\s*\r?\n/).filter(s => s.trim()).map((text, i) => ({ index: i + 1, kind: 'body', text }))];
    const promptHash = hash(JSON.stringify({ version: 1, model, variant, settings, sourceHashes,
      input: variant === 'rewrite' ? { style: '', paragraphs, chunkSize: 12, lang: 'zh' } : { prompt, system } }));
    if (fs.existsSync(file) && fs.existsSync(sidecar)) {
      const meta = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      if (meta.prompt_hash !== promptHash || meta.output_sha256 !== hash(fs.readFileSync(file, 'utf8'))) throw failure(`Cache mismatch: ${row.human_id}/${model}/${variant}; refusing overwrite`);
      skipped++; return;
    }
    // If interrupted between text/sidecar writes, reconstruct from request caches.
    // A complete mismatched pair above is never silently overwritten.
    const refs = new Set<string>();
    const validateText = (s: string) => { if (han(s) < 200) throw failure('Output under 200 Han; unusable for chunk evaluation'); };
    let output: string, unchanged = 0;
    if (variant === 'rewrite') {
      let rewriteFailure = false;
      const injectedAsk = async (p: string, opts: any) => {
        try {
          return await ask(model, p, opts, (raw: string) => {
            let arr: any;
            try { arr = parseJson(raw); } catch { throw failure('Invalid rewrite JSON'); }
            if (!Array.isArray(arr) || !arr.length) throw failure('Empty/non-array rewrite JSON');
            if (p.includes('严格只输出 JSON 字符串数组')) {
              if (!arr.every(s => typeof s === 'string' && s.trim())) throw failure('Invalid title JSON');
            } else {
              const wanted = [...p.matchAll(/^\[(\d+)\] \([^)]+\) /gm)].map(m => Number(m[1]));
              if (!wanted.length || arr.length !== wanted.length || new Set(arr.map(it => Number(it.index))).size !== wanted.length || !wanted.every(i => arr.some(it => Number(it.index) === i && typeof it.text === 'string' && it.text.trim()))) throw failure('Missing/duplicate/invalid rewrite paragraphs');
            }
          }, refs);
        } catch (e) { rewriteFailure = true; throw e; }
      };
      const rewritten = await rewriteDocument('', paragraphs, 12, 'zh', injectedAsk);
      if (rewriteFailure) throw failure('Rewrite silently fell back after failed call; output rejected');
      if (paragraphs.some(p => !rewritten.get(p.index)?.trim())) throw failure('Rewrite omitted a paragraph');
      unchanged = paragraphs.slice(1).filter(p => rewritten.get(p.index) === p.text).length / (paragraphs.length - 1);
      output = paragraphs.map(p => rewritten.get(p.index)!).join('\n\n');
      validateText(output);
    } else output = await ask(model, prompt, { system }, validateText, refs);
    const usages = [...refs].map(key => JSON.parse(fs.readFileSync(path.join(OUT, 'api-cache', model, `${key}.json`), 'utf8')).usage);
    const usage = usages.some(u => u == null) ? null : { prompt_tokens: usages.reduce((n, u) => n + u.prompt_tokens, 0), completion_tokens: usages.reduce((n, u) => n + u.completion_tokens, 0), total_tokens: usages.reduce((n, u) => n + u.total_tokens, 0) };
    const meta = { human_id: row.human_id, model, variant, prompt_hash: promptHash, created_at: new Date().toISOString(), output_chars: han(output), output_codepoints: Array.from(output).length, output_sha256: hash(output), usage, request_hashes: [...refs], ...(variant === 'rewrite' ? { unchanged_paragraph_fraction: unchanged } : {}) };
    atomic(file, output);
    writeJSON(sidecar, meta);
    fs.appendFileSync(path.join(OUT, 'ai-manifest.jsonl'), JSON.stringify(meta) + '\n');
    completed++;
  }
  console.log(`Generating ${jobs.length} outputs; global API concurrency=${concurrency}; configured reasoning retained; existing cache reused.`);
  const timer = setInterval(() => console.log(`Progress outputs=${completed}, skipped=${skipped}, calls=${attempted}, retries=${retries}, failed attempts=${failures}, active=${active}`), 30_000);
  let failedOutputs = 0;
  const worker = async () => {
    while (!abortReason && cursor < jobs.length) {
      const job = jobs[cursor++];
      try { await runJob(job); }
      catch (e: any) {
        const reason = safeError(e);
        log({ type: 'output_failure', run_id: runId, human_id: job.row.human_id, model: job.model, variant: job.variant, reason });
        failedOutputs++;
        // Failed API requests already update the >10% circuit. A damaged cache
        // is a local integrity issue and must stop regardless of API failure rate.
        if (/cache|Cache|Corrupt|mismatch/i.test(reason)) abortReason ||= `Stopped: ${reason}`;
      }
    }
  };
  try { await Promise.all(Array.from({ length: concurrency }, worker)); }
  finally {
    clearInterval(timer);
    // Sidecars reconcile interrupted manifest appends without duplicates.
    const allMeta = sample.flatMap(row => EVAL_SOURCES.flatMap(({ model, variants }) => variants.flatMap(variant => {
      const f = aiPath(row, model, variant);
      return fs.existsSync(f) && fs.existsSync(f + '.json') ? [JSON.parse(fs.readFileSync(f + '.json', 'utf8'))] : [];
    })));
    writeJSONL(path.join(OUT, 'ai-manifest.jsonl'), allMeta);
    const events = jsonl(eventsFile);
    const totals = Object.fromEntries(MODELS.map(model => {
      const res = events.filter(e => e.model === model && e.type === 'response');
      return [model, { responses: res.length, prompt_tokens: res.reduce((n, e) => n + (e.usage?.prompt_tokens ?? 0), 0), completion_tokens: res.reduce((n, e) => n + (e.usage?.completion_tokens ?? 0), 0), total_tokens: res.reduce((n, e) => n + (e.usage?.total_tokens ?? 0), 0), usage_missing_responses: res.filter(e => !e.usage).length, failed_attempts: events.filter(e => e.model === model && e.type === 'failure').length, retries: events.filter(e => e.model === model && e.type === 'attempt' && e.attempt > 1).length }];
    }));
    if (failedOutputs) abortReason ||= `Generation incomplete: ${failedOutputs} outputs failed; cached successes retained. Re-run to resume.`;
    const deepseekCached = allMeta.filter(m => MODELS.includes(m.model)).length;
    const expected = sample.length * MODELS.length * VARIANTS.length;
    const summary = { started_at: started, finished_at: new Date().toISOString(), status: abortReason ? 'aborted' : deepseekCached === expected ? 'complete' : 'partial', abort_reason: abortReason || null, settings: { temperature: config.llm.temperature, ...extra }, outputs_expected: expected, outputs_cached: deepseekCached, run: { attempted, retries, failed_attempts: failures, failed_requests: failedRequests, failed_outputs: failedOutputs, completed, skipped }, totals };
    writeJSON(path.join(OUT, 'generation-summary.json'), summary);
    console.log(JSON.stringify(summary, null, 2));
  }
  if (abortReason) throw failure(abortReason);
}
main().catch((e: any) => { console.error(e.safeReason ?? (e.message?.startsWith('No configured') ? e.message : 'Generation stopped; inspect safe local summary/cache (no API error bodies logged).')); process.exitCode = 1; });
