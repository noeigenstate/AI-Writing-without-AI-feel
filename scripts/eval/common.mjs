import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const OUT = path.join(ROOT, 'data/eval/pilot');
export const SUBSETS = ['human-zh', 'human-zh-open', 'human-zh-gov'];
export const MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
export const VARIANTS = ['plain', 'humanized', 'rewrite'];
// MODELS/VARIANTS remain the DeepSeek generation grid.
export const EVAL_SOURCES = [
  ...MODELS.map(model => ({ model, variants: [...VARIANTS] })),
  { model: 'codex-gpt', variants: ['plain', 'humanized'] },
];
export const expectedAI = sample => sample.length * EVAL_SOURCES.reduce((n, s) => n + s.variants.length, 0);
export function requestFor(r) {
  const n = Math.max(50, Math.round(r.char_count / 50) * 50);
  if (r.source === 'hc3') return `请回答这个问题：${r.title}。约${n}字。`;
  const genre = r.genre.includes('小说') ? '小说的一章' : r.genre.includes('儿童') ? '童话' : r.genre.includes('新闻') ? '新闻报道' : r.genre.includes('百科') ? '百科条目段落' : r.genre.includes('政府工作') ? '政府工作报告段落' : r.genre.includes('法规') ? '法规条文' : r.genre.includes('公文') ? '公文段落' : r.genre.includes('评论') ? '评论文章' : r.genre.includes('书信') ? '书信' : r.genre.includes('诗') ? '现代诗' : r.genre;
  return `请写一篇${genre}，题目是《${r.title}》，约${n}字。`;
}
export const SEED = 20261028;
export const han = text => (text.match(/\p{Script=Han}/gu) ?? []).length;
export const hash = text => createHash('sha256').update(text).digest('hex');
export const jsonl = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
export function atomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
}
export const writeJSON = (file, data) => atomic(file, JSON.stringify(data, null, 2) + '\n');
export const writeJSONL = (file, rows) => atomic(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
export function rng(seed = SEED) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function shuffle(values, random) {
  const a = [...values];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
export function corpusRows(subset) { return jsonl(path.join(ROOT, 'data/corpus', subset, 'manifest.jsonl')); }
export function humanText(row) {
  const base = path.join(ROOT, 'data/corpus', row.subset);
  const file = path.resolve(base, row.simplified_file || `texts/${row.human_id ?? row.id}.txt`);
  if (!file.startsWith(base + path.sep)) throw new Error('Unsafe corpus path');
  return fs.readFileSync(file, 'utf8');
}
export function groupKey(r, subset) {
  const key = subset === 'human-zh' ? r.author : subset === 'human-zh-open' ? `${r.source}\0${r.work}` : r.work;
  if (!key) throw new Error('Missing corpus group');
  return `${subset}:${key}`;
}
export const aiPath = (row, model, variant) => path.join(OUT, 'ai', model, variant, `${row.human_id}.txt`);
export function loadSample() {
  const rows = jsonl(path.join(OUT, 'sample.jsonl'));
  if (rows.length !== 300 || new Set(rows.map(r => r.human_id)).size !== 300) throw new Error('Run sample.mjs first: expected 300 distinct humans');
  for (const sub of SUBSETS) if (rows.filter(r => r.subset === sub).length !== 100) throw new Error('Expected 100 per subset');
  const groups = new Map();
  for (const r of rows) {
    if (groups.has(r.group) && groups.get(r.group) !== r.split) throw new Error('Group crosses splits');
    groups.set(r.group, r.split);
    if (hash(humanText(r)) !== r.text_sha256) throw new Error(`Human text changed: ${r.human_id}`);
  }
  return rows;
}
