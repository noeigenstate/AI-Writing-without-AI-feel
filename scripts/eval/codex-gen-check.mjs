// Isolated, handwritten batch ingestion fixtures. Never writes production AI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OUT, hash, writeJSON, jsonl, expectedAI, loadSample } from './common.mjs';
import { jobsFor, batchPrompt, parseBatch, runGenerator, quotaOrAuth, options } from './codex-gen.mjs';

const root = fs.mkdtempSync(path.join(OUT, 'codex-fixture-'));
const quiet = console.log;
try {
  const sample = [0, 1].map(n => ({ human_id: `fixture-${n}`, title: 'Fixture', genre: '散文', char_count: 500 }));
  const jobs = jobsFor(sample, 'fixture rules');
  const long = '这段文字只用于隔离目录的解析验证。'.repeat(20);
  const item = (id, text) => `<<<ITEM id=${id}>>>\n${text}\n<<<END>>>`;
  // Valid, short, missing, and an otherwise long item with a leaked marker.
  const raw = [item(jobs[0].id, long), item(jobs[1].id, '太短'), item(jobs[3].id, long + '\n<<<garbage>>>')].join('\n');
  const parsed = parseBatch(raw, jobs.map(j => j.id));
  assert.equal(parsed.items.size, 1);
  assert.equal(parsed.invalid.get(jobs[1].id), 'under 200 Han');
  assert.equal(parsed.invalid.get(jobs[2].id), 'missing item');
  assert.equal(parsed.invalid.get(jobs[3].id), 'leaked delimiter');
  assert.equal(parseBatch('outside\n' + item(jobs[0].id, long), [jobs[0].id]).items.size, 0);
  assert.equal(parseBatch(item(jobs[0].id, long).repeat(2), [jobs[0].id]).items.size, 0);
  assert.throws(() => options(['--concurrency=4']));
  assert.throws(() => options(['--limit=1.5']));
  assert.ok(quotaOrAuth('rate limit exceeded'));
  assert.ok(quotaOrAuth('authentication failed'));
  assert.ok(!quotaOrAuth('Output under 200 Han'));
  assert.equal(expectedAI(loadSample()), 2400);
  function batch(name, selected, attempt, output) {
    const dir = path.join(root, 'codex-work', name);
    fs.mkdirSync(dir, { recursive: true });
    writeJSON(path.join(dir, 'batch.json'), { prompt_hash: hash(batchPrompt(selected)), exit_code: 0,
      jobs: selected.map(j => ({ id: j.id, prompt_hash: j.prompt_hash, attempt })) });
    fs.writeFileSync(path.join(dir, 'output.md'), output);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 800, output_tokens: 400 } }) + '\n');
  }
  batch('batch-1', jobs, 1, raw);
  console.log = () => {};
  const run = () => runGenerator({ args: ['--ingest-only'], out: root, sample, rules: 'fixture rules' });
  const first = await run();
  assert.equal(first.outputs_cached, 1);
  assert.deepEqual(first.retry_pending, jobs.slice(1).map(j => j.id));
  const manifest = jsonl(path.join(root, 'ai-manifest.jsonl'));
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].usage.prompt_tokens, 200);
  assert.equal(manifest[0].usage.completion_tokens, 100);
  assert.equal(manifest[0].usage_estimated, true);
  const second = await run();
  assert.equal(second.accepted.length, 0);
  assert.equal(jsonl(path.join(root, 'ai-manifest.jsonl')).length, 1);
  batch('batch-2', jobs.slice(1), 2, jobs.slice(1, 3).map(j => item(j.id, long)).join('\n'));
  const retry = await run();
  assert.equal(retry.outputs_cached, 3);
  assert.deepEqual(retry.retry_pending, [jobs[3].id]);
  const humanized = jsonl(path.join(root, 'ai-manifest.jsonl')).find(m => m.variant === 'humanized');
  assert.equal(humanized.system_in_user_prompt, true);
  batch('batch-3', [jobs[3]], 3, item(jobs[3].id, '仍然太短'));
  const exhausted = await run();
  assert.deepEqual(exhausted.exhausted, [jobs[3].id]);
  assert.deepEqual(exhausted.retry_pending, []);
  // A valid replacement cannot overwrite a completed mismatched cache.
  const file = path.join(root, 'ai/codex-gpt/plain/fixture-0.txt.json');
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  writeJSON(file, { ...meta, prompt_hash: 'changed' });
  await assert.rejects(run, /Cache mismatch/);
} finally {
  console.log = quiet;
  // Verify the absolute temporary target before recursive deletion on Windows.
  const target = path.resolve(root);
  assert.ok(target.startsWith(path.resolve(OUT) + path.sep + 'codex-fixture-'));
  fs.rmSync(target, { recursive: true, force: true });
}
console.log('PASS: isolated ingestion valid/short/missing/delimiter garbage; retry recovery and exhaustion at 3 attempts; idempotence; usage allocation; cache mismatch; fixture deleted.');
