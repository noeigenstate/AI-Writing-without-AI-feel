// Plain Node entry point. Only the rules loader uses the existing tsx runtime.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT, OUT, EVAL_SOURCES, requestFor, loadSample, aiPath, han, hash, jsonl, atomic, writeJSON, writeJSONL } from './common.mjs';

export const MODEL = 'codex-gpt';
const AUTHOR = 'gpt-6.1-sol';
const SETTINGS = { model: AUTHOR, model_reasoning_effort: 'medium', sandbox: 'read-only' };
const MAX_ATTEMPTS = 3;
const TEMPLATE = `你现在纯粹扮演作者，只完成下列写作任务。禁止运行任何工具、读取文件、修改文件或执行命令。不要调查或检索，不要解释你的工作过程。
每篇使用简体中文，独立完成；每篇至少200个汉字，尽量满足请求字数。不要在正文中使用任何分隔标记。
只输出严格的以下格式，每个指定id恰好一次，不能有前言、后记、代码围栏或额外内容：
<<<ITEM id=指定id>>>
该篇正文
<<<END>>>`;

export function options(args) {
  const value = (name, fallback) => Number(args.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
  const concurrency = value('concurrency', 2), limit = value('limit', Infinity);
  if (![1, 2, 3].includes(concurrency) || !(limit === Infinity || Number.isInteger(limit) && limit >= 1)
    || args.some(a => !/^(--concurrency=|--limit=|--dry-run$|--ingest-only$)/.test(a))) {
    throw new Error('Use --concurrency=1|2|3, --limit=N (batches), --dry-run, --ingest-only');
  }
  return { concurrency, limit, dryRun: args.includes('--dry-run'), ingestOnly: args.includes('--ingest-only') };
}

export function jobsFor(sample, rules) {
  return sample.flatMap(row => ['plain', 'humanized'].map(variant => {
    const prompt = (variant === 'humanized' ? `写作要求：\n${rules}\n\n` : '') + requestFor(row);
    return { row, model: MODEL, variant, prompt,
      prompt_hash: hash(JSON.stringify({ version: 1, model: MODEL, variant, settings: SETTINGS, template: TEMPLATE, prompt })) };
  })).map((job, i) => ({ ...job, id: `j${String(i).padStart(4, '0')}` }));
}

export const batchPrompt = jobs => `${TEMPLATE}\n\n${jobs.map(j => `任务 id=${j.id}\n${j.prompt}`).join('\n\n')}\n`;
export function validateItem(text) {
  if (/<<<|>>>/.test(text)) return 'leaked delimiter';
  if (han(text) < 200) return 'under 200 Han';
  return null;
}

export function parseBatch(raw, ids) {
  raw = raw.replace(/\r\n?/g, '\n');
  const found = new Map(), invalid = new Map();
  const wanted = new Set(ids);
  const pattern = /^<<<ITEM id=([A-Za-z0-9_-]+)>>>\n([\s\S]*?)^<<<END>>>[ \t]*(?=\n|$)/gm;
  let end = 0, garbage = false;
  for (const m of raw.matchAll(pattern)) {
    if (raw.slice(end, m.index).trim()) garbage = true;
    end = m.index + m[0].length;
    const id = m[1], text = m[2].trim();
    if (!wanted.has(id)) { garbage = true; continue; }
    if (found.has(id)) invalid.set(id, 'duplicate item');
    found.set(id, text);
    const reason = validateItem(text);
    if (reason) invalid.set(id, reason);
  }
  if (raw.slice(end).trim()) garbage = true;
  for (const id of ids) {
    if (!found.has(id)) invalid.set(id, 'missing item');
    else if (garbage) invalid.set(id, 'garbage outside delimiters');
  }
  return { items: new Map([...found].filter(([id]) => !invalid.has(id))), invalid };
}

export function batchUsage(events) {
  const completed = events.filter(e => e.type === 'turn.completed');
  if (!completed.length || completed.some(e => !Number.isFinite(e.usage?.input_tokens) || !Number.isFinite(e.usage?.output_tokens))) return null;
  const prompt_tokens = completed.reduce((n, e) => n + e.usage.input_tokens, 0);
  const completion_tokens = completed.reduce((n, e) => n + e.usage.output_tokens, 0);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

export const quotaOrAuth = text => /rate[ _-]?limit|quota|usage limit|insufficient.{0,20}(credit|balance)|401\b|403\b|429\b|unauthori[sz]ed|authentication|not (?:logged|signed) in|sign.?in required|token.{0,20}expired|refresh.{0,20}token|invalid.{0,10}(?:api.?key|credentials)|auth(?:entication)? (?:failed|required|error)|用量.{0,10}(上限|额度)|余额不足|限流/i.test(text);

async function loadRules() {
  // No config import, .env access, or API key is needed for this source.
  const { tsImport } = await import(pathToFileURL(path.join(ROOT, 'backend/node_modules/tsx/dist/esm/api/index.mjs')).href);
  const { antiAiRules } = await tsImport(pathToFileURL(path.join(ROOT, 'backend/src/prompts/rules.ts')).href, import.meta.url);
  return antiAiRules('zh');
}

function spawnCodex(dir, prompt, running) {
  return new Promise((resolve, reject) => {
    const output = path.join(dir, 'output.md');
    const args = ['exec', '-m', AUTHOR, '-c', 'model_reasoning_effort=medium', '-s', 'read-only', '--skip-git-repo-check', '--json', '-o', output, '-'];
    // Resolve the npm shim to its JS entry point on Windows, avoiding cmd.exe
    // quoting of Unicode/spaced paths. The prompt is sent exclusively on stdin.
    let executable = 'codex', commandArgs = args;
    if (process.platform === 'win32') {
      const entries = (process.env.PATH ?? '').split(path.delimiter);
      const shim = entries.map(p => path.join(p.replace(/^"|"$/g, ''), 'codex.cmd')).find(p => fs.existsSync(p));
      const entry = shim && path.join(path.dirname(shim), 'node_modules/@openai/codex/bin/codex.js');
      if (!entry || !fs.existsSync(entry)) { reject(new Error('Cannot resolve codex.cmd npm entry point on Windows')); return; }
      executable = process.execPath; commandArgs = [entry, ...args];
    }
    const events = fs.openSync(path.join(dir, 'events.jsonl'), 'w');
    const errors = fs.openSync(path.join(dir, 'stderr.log'), 'w');
    const child = spawn(executable, commandArgs, { cwd: dir, windowsHide: true, stdio: ['pipe', events, errors] });
    fs.closeSync(events); fs.closeSync(errors);
    running.add(child);
    child.stdin.on('error', () => {}); // EPIPE is reported through the exit status.
    child.once('error', () => { running.delete(child); reject(new Error('Failed to spawn codex inside the sandbox')); });
    child.once('close', (code, signal) => { running.delete(child); resolve({ code, signal }); });
    child.stdin.end(prompt, 'utf8');
  });
}

// Exported runner permits isolated ingestion fixtures without production AI writes.
export async function runGenerator({ args = process.argv.slice(2), out = OUT, sample, rules } = {}) {
  const opt = options(args);
  sample ??= loadSample();
  if (opt.dryRun) {
    const jobs = sample.length * 2;
    const report = { model: MODEL, jobs, batches: Math.ceil(jobs / 8), batch_size: 8, concurrency: opt.concurrency,
      max_batches_this_run: Math.min(Math.ceil(jobs / 8), opt.limit), note: 'full grid before cache skips; no spawning' };
    console.log(JSON.stringify(report, null, 2)); return report;
  }
  rules ??= await loadRules();
  const jobs = jobsFor(sample, rules), byId = new Map(jobs.map(j => [j.id, j]));
  const work = path.join(out, 'codex-work');
  fs.mkdirSync(work, { recursive: true });
  const lock = path.join(work, 'generator.lock');
  // Lock only this source; README also requires a single pilot generator process.
  const lockFd = fs.openSync(lock, 'wx');
  const started = Date.now(), running = new Set(), accepted = [], records = [];
  const attempts = new Map(jobs.map(j => [j.id, 0]));
  let abortReason = null, spawned = 0, rejected = 0;
  const fileFor = j => path.join(out, path.relative(OUT, aiPath(j.row, MODEL, j.variant)));
  const log = event => fs.appendFileSync(path.join(work, 'ingest-events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  function cached(j) {
    const file = fileFor(j);
    if (!fs.existsSync(file) || !fs.existsSync(file + '.json')) return false;
    const meta = JSON.parse(fs.readFileSync(file + '.json', 'utf8'));
    const text = fs.readFileSync(file, 'utf8');
    if (meta.prompt_hash !== j.prompt_hash || meta.output_sha256 !== hash(text) || validateItem(text)) {
      throw new Error(`Cache mismatch: ${j.id}; refusing overwrite`);
    }
    return true;
  }
  function ingest(record) {
    const dir = path.join(work, record.name), batch = record.batch;
    const compatible = batch.jobs.filter(ref => byId.get(ref.id)?.prompt_hash === ref.prompt_hash);
    for (const ref of compatible) attempts.set(ref.id, Math.max(attempts.get(ref.id), ref.attempt));
    const rawFile = path.join(dir, 'output.md');
    const events = jsonl(path.join(dir, 'events.jsonl'));
    record.usage = batchUsage(events);
    // Do not accept texts from an agent that ignored the no-tools instruction.
    const usedTools = events.some(e => /command_execution|tool_call|file_change|web_search/.test(e.item?.type ?? ''));
    const failed = batch.exit_code != null && batch.exit_code !== 0;
    const parsed = parseBatch(fs.existsSync(rawFile) ? fs.readFileSync(rawFile, 'utf8') : '', batch.jobs.map(j => j.id));
    for (const ref of compatible) {
      const j = byId.get(ref.id);
      if (cached(j)) continue;
      const reason = usedTools ? 'agent used tools' : failed ? 'codex non-zero exit' : parsed.invalid.get(j.id);
      if (reason) { rejected++; log({ batch: record.name, id: j.id, attempt: ref.attempt, reason, retry: ref.attempt < MAX_ATTEMPTS }); continue; }
      const output = parsed.items.get(j.id);
      const usage = record.usage && Object.fromEntries(Object.entries(record.usage).map(([k, v]) => [k, v / batch.jobs.length]));
      const meta = { human_id: j.row.human_id, model: MODEL, variant: j.variant, prompt_hash: j.prompt_hash,
        created_at: new Date().toISOString(), output_chars: han(output), output_codepoints: Array.from(output).length,
        output_sha256: hash(output), usage, request_hashes: [batch.prompt_hash], usage_estimated: true,
        system_in_user_prompt: j.variant === 'humanized', author_model: AUTHOR, settings: SETTINGS,
        batch: record.name, batch_size: batch.jobs.length, agent_system_prompt: true };
      atomic(fileFor(j), output);
      writeJSON(fileFor(j) + '.json', meta);
      fs.appendFileSync(path.join(out, 'ai-manifest.jsonl'), JSON.stringify(meta) + '\n');
      accepted.push({ id: j.id, variant: j.variant, han: meta.output_chars, usage });
      log({ batch: record.name, id: j.id, attempt: ref.attempt, accepted: true, han: meta.output_chars });
    }
  }
  function reconcileManifest() {
    // Rebuild from all source sidecars, including DeepSeek; recover interrupted appends.
    const all = sample.flatMap(row => EVAL_SOURCES.flatMap(({ model, variants }) => variants.flatMap(variant => {
      const file = path.join(out, path.relative(OUT, aiPath(row, model, variant)));
      return fs.existsSync(file) && fs.existsSync(file + '.json') ? [JSON.parse(fs.readFileSync(file + '.json', 'utf8'))] : [];
    })));
    writeJSONL(path.join(out, 'ai-manifest.jsonl'), all);
  }
  let summary;
  try {
    jobs.forEach(cached);
    for (const name of fs.readdirSync(work).sort()) {
      const descriptor = path.join(work, name, 'batch.json');
      if (!fs.existsSync(descriptor)) continue;
      const record = { name, batch: JSON.parse(fs.readFileSync(descriptor, 'utf8')) };
      records.push(record);
      // A terminal previous failure must never silently launch more requests.
      if (record.batch.terminal_error) abortReason ||= record.batch.terminal_error;
      ingest(record);
    }
    const queue = jobs.filter(j => !cached(j) && attempts.get(j.id) < MAX_ATTEMPTS);
    const worker = async () => {
      while (!abortReason && !opt.ingestOnly && queue.length && spawned < opt.limit) {
        const selected = queue.splice(0, 8).filter(j => !cached(j));
        if (!selected.length) continue;
        spawned++;
        const name = `batch-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
        const dir = path.join(work, name), prompt = batchPrompt(selected);
        fs.mkdirSync(dir);
        const batch = { created_at: new Date().toISOString(), settings: SETTINGS, prompt_hash: hash(prompt),
          jobs: selected.map(j => ({ id: j.id, prompt_hash: j.prompt_hash, attempt: attempts.get(j.id) + 1 })) };
        const record = { name, batch };
        records.push(record);
        atomic(path.join(dir, 'prompt.txt'), prompt);
        writeJSON(path.join(dir, 'batch.json'), batch);
        const t0 = Date.now();
        try {
          const result = await spawnCodex(dir, prompt, running);
          batch.exit_code = result.code ?? -1;
          batch.signal = result.signal;
          if (batch.exit_code !== 0) {
            const diagnostics = ['stderr.log', 'events.jsonl'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
            if (quotaOrAuth(diagnostics)) {
              abortReason = 'Codex quota/rate-limit/auth error; stopped without retry (inspect local batch logs)';
              batch.terminal_error = abortReason;
              for (const child of running) child.kill();
            } else {
              // Do not loop on nested sandbox/CLI launch failures either.
              abortReason ||= 'Codex exited non-zero inside the sandbox; stopped (inspect local batch logs)';
              batch.terminal_error = abortReason;
            }
          }
        } catch (e) { abortReason ||= e.message; batch.exit_code = -1; batch.terminal_error = abortReason; }
        batch.wall_ms = Date.now() - t0;
        writeJSON(path.join(dir, 'batch.json'), batch);
        ingest(record);
        for (const j of selected) if (!cached(j) && attempts.get(j.id) < MAX_ATTEMPTS) queue.push(j);
        console.log(`Codex batch ${spawned}: accepted=${selected.filter(cached).length}/${selected.length}, wall_ms=${batch.wall_ms}`);
      }
    };
    const timer = setInterval(() => console.log(`Codex progress: batches=${spawned}, accepted=${accepted.length}, active=${running.size}`), 30_000);
    try { await Promise.all(Array.from({ length: opt.concurrency }, worker)); }
    finally { clearInterval(timer); }
  } finally {
    try {
      reconcileManifest();
      const totals = { responses: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
        usage_missing_responses: 0, failed_attempts: 0, retries: 0 };
      for (const { batch, usage } of records) {
        totals.responses++;
        if (usage) for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens']) totals[k] += usage[k];
        else totals.usage_missing_responses++;
        if (batch.exit_code != null && batch.exit_code !== 0) totals.failed_attempts++;
        totals.retries += batch.jobs.filter(j => j.attempt > 1).length;
      }
      if (totals.usage_missing_responses) for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens']) totals[k] = null;
      summary = { started_at: new Date(started).toISOString(), finished_at: new Date().toISOString(), wall_ms: Date.now() - started,
        model: MODEL, settings: SETTINGS, outputs_expected: jobs.length, outputs_cached: jobs.filter(cached).length,
        abort_reason: abortReason, batches_spawned: spawned, accepted, rejected,
        exhausted: jobs.filter(j => !cached(j) && attempts.get(j.id) >= MAX_ATTEMPTS).map(j => j.id),
        retry_pending: jobs.filter(j => !cached(j) && attempts.get(j.id) > 0 && attempts.get(j.id) < MAX_ATTEMPTS).map(j => j.id),
        usage_estimated: true, totals };
      writeJSON(path.join(out, 'codex-generation-summary.json'), summary);
    } finally { fs.closeSync(lockFd); fs.unlinkSync(lock); }
  }
  console.log(JSON.stringify(summary, null, 2));
  if (abortReason) throw new Error(abortReason);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runGenerator().then(s => { if (s.exhausted?.length || s.retry_pending?.length) process.exitCode = 1; })
    .catch(e => { console.error(e.message); process.exitCode = 1; });
}
