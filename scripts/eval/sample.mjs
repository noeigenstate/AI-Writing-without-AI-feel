import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, OUT, SUBSETS, SEED, han, hash, rng, shuffle, corpusRows, humanText, groupKey, writeJSONL, writeJSON } from './common.mjs';

const require = createRequire(path.join(ROOT, 'scripts/corpus/package.json'));
const { Converter } = require('opencc-js');
const simplify = Converter({ from: 'tw', to: 'cn' });
const random = rng();
const sample = [], audit = [];
for (const subset of SUBSETS) {
  const strata = new Map();
  for (const r of corpusRows(subset)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(r.id)) throw new Error('Unsafe human id');
    const text = humanText({ ...r, subset });
    const item = { human_id: r.id, subset, genre: simplify(r.genre), title: simplify(r.piece_title || r.work),
      char_count: han(text), source: r.source, work: r.work, group: groupKey(r, subset),
      simplified_file: r.simplified_file, text_sha256: hash(text) };
    const key = `${item.genre}/${item.source}`;
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(item);
  }
  // Largest-remainder allocation, with at least one piece in every observed stratum.
  const entries = [...strata].sort(([a], [b]) => a.localeCompare(b));
  const total = entries.reduce((n, [, v]) => n + v.length, 0);
  const quotas = entries.map(([key, rows]) => ({ key, rows, ideal: rows.length / total * 100, n: Math.max(1, Math.floor(rows.length / total * 100)) }));
  while (quotas.reduce((s, q) => s + q.n, 0) < 100) quotas.filter(q => q.n < q.rows.length).sort((a, b) => (b.ideal - b.n) - (a.ideal - a.n) || a.key.localeCompare(b.key))[0].n++;
  while (quotas.reduce((s, q) => s + q.n, 0) > 100) quotas.filter(q => q.n > 1).sort((a, b) => (b.n - b.ideal) - (a.n - a.ideal) || a.key.localeCompare(b.key))[0].n--;
  const chosen = [];
  for (const q of quotas) {
    const preferred = shuffle(q.rows.filter(r => r.char_count >= 600 && r.char_count <= 3000), random);
    const fallback = shuffle(q.rows.filter(r => r.char_count < 600 || r.char_count > 3000), random);
    chosen.push(...[...preferred, ...fallback].slice(0, q.n));
    audit.push({ subset, stratum: q.key, available: q.rows.length, preferred_available: preferred.length, selected: q.n });
  }
  const groups = new Map();
  for (const r of chosen) { if (!groups.has(r.group)) groups.set(r.group, []); groups.get(r.group).push(r); }
  const keys = quotas.map(q => q.key);
  const vector = rows => [rows.length, ...keys.map(k => rows.filter(r => `${r.genre}/${r.source}` === k).length)];
  const target = vector(chosen).map(n => n / 2);
  const loss = v => v.reduce((s, n, i) => s + (i === 0 ? 8 : 1) * (n - target[i]) ** 2, 0);
  let best, bestLoss = Infinity;
  for (let trial = 0; trial < 2500; trial++) {
    const dev = new Set(), counts = target.map(() => 0);
    for (const [key, rows] of shuffle([...groups], random)) {
      const next = counts.map((n, i) => n + vector(rows)[i]);
      if (loss(next) < loss(counts)) { dev.add(key); counts.splice(0, counts.length, ...next); }
    }
    const l = loss(counts);
    if (l < bestLoss) { bestLoss = l; best = dev; }
  }
  for (const r of chosen) r.split = best.has(r.group) ? 'dev' : 'test';
  const devN = chosen.filter(r => r.split === 'dev').length;
  if (Math.abs(devN - 50) > 5) throw new Error(`Cannot balance ${subset}: ${devN}/100 dev`);
  sample.push(...chosen);
  console.log(`${subset}: 100 pieces, dev=${devN}, test=${100 - devN}, groups=${groups.size}, preferred=${chosen.filter(r => r.char_count >= 600 && r.char_count <= 3000).length}`);
}
sample.sort((a, b) => a.human_id.localeCompare(b.human_id));
writeJSONL(path.join(OUT, 'sample.jsonl'), sample);
writeJSON(path.join(OUT, 'sample-audit.json'), { seed: SEED, stratification: 'proportional genre × source; minimum one per stratum; prefer 600–3000 Han', group_split: 'fixed-seed randomized group allocation minimizing total/stratum imbalance', strata: audit,
  manifest_hashes: Object.fromEntries(SUBSETS.map(s => [s, hash(JSON.stringify(corpusRows(s)))])),
  counts: SUBSETS.map(subset => ({ subset, dev: sample.filter(r => r.subset === subset && r.split === 'dev').length, test: sample.filter(r => r.subset === subset && r.split === 'test').length })) });
