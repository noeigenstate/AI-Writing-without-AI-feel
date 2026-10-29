import { rng, han } from './common.mjs';

export const SIGNALS = ['opener', 'filler', 'buzz', 'model-catchphrase', 'connective', 'frame', 'parallel', 'markdown', 'uniformity', 'repetition', 'concreteness'];
export function chunks(text, target = 500, minimum = 200) {
  const sentences = text.match(/[\s\S]*?[。！？!?]+[”’」』"]*|[\s\S]+$/gu) ?? [];
  const out = []; let pending = '', n = 0;
  for (const sentence of sentences) {
    const size = han(sentence);
    if (n >= minimum && n + size > target && target - n <= n + size - target) {
      out.push(pending); pending = ''; n = 0;
    }
    pending += sentence; n += size;
    if (n >= target) { out.push(pending); pending = ''; n = 0; }
  }
  const dropped = n < minimum ? n : 0;
  if (n >= minimum) out.push(pending);
  return { texts: out, dropped_han: dropped };
}
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const p = (sorted.length - 1) * q, i = Math.floor(p);
  return sorted[i] + (sorted[Math.ceil(p)] - sorted[i]) * (p - i);
}
export function correlation(xs, ys) {
  if (xs.length < 3) return null;
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
  const a = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const b = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
  return b ? a / b : null;
}
export function distribution(rows) {
  const scores = rows.map(r => r.score).sort((a, b) => a - b);
  const histogram = Array(10).fill(0);
  for (const r of rows) histogram[Math.min(9, Math.floor(r.score / 10))]++;
  return { n: rows.length, documents: new Set(rows.map(r => r.human_id)).size,
    mean: rows.length ? scores.reduce((s, x) => s + x, 0) / rows.length : null,
    median: quantile(scores, .5), p10: quantile(scores, .1), p90: quantile(scores, .9),
    low_rate: rows.length ? rows.filter(r => r.score < 40).length / rows.length : null,
    below_high_rate: rows.length ? rows.filter(r => r.score < 70).length / rows.length : null,
    high_rate: rows.length ? rows.filter(r => r.score >= 70).length / rows.length : null,
    score_length_pearson: correlation(rows.map(r => r.char_count), rows.map(r => r.score)), histogram };
}
export function signalStats(rows) {
  return Object.fromEntries(SIGNALS.map(id => {
    const signals = rows.map(r => r.signals.find(s => s.id === id));
    const n = rows.length;
    return [id, { n, fire_rate: n ? signals.filter(s => s && s.points > 0).length / n : null,
      literal_hit_rate: n ? signals.filter(s => s && s.hits > 0).length / n : null,
      mean_hits: n ? signals.reduce((v, s) => v + (s?.hits ?? 0), 0) / n : null,
      mean_points: n ? signals.reduce((v, s) => v + (s?.points ?? 0), 0) / n : null }];
  }));
}
function aucHist(h, a) {
  const nh = h.reduce((s, x) => s + x, 0), na = a.reduce((s, x) => s + x, 0);
  if (!nh || !na) return null;
  let below = 0, pairs = 0;
  for (let i = 0; i <= 100; i++) { pairs += h[i] * (below + a[i] / 2); below += a[i]; }
  return pairs / (nh * na);
}
export function auc(human, ai, iterations = 1000, seed = 20261028) {
  // Compare only matched documents, then resample whole leakage groups jointly.
  const hs = new Set(human.map(r => r.human_id)), as = new Set(ai.map(r => r.human_id));
  const h = human.filter(r => as.has(r.human_id)), a = ai.filter(r => hs.has(r.human_id));
  if (!h.length || !a.length) return { auc: null, ci95: null, n_groups: 0, paired_documents: 0, human_n: h.length, ai_n: a.length };
  const groups = new Map();
  for (const [rows, side] of [[h, 0], [a, 1]]) for (const r of rows) {
    if (!groups.has(r.group)) groups.set(r.group, [Array(101).fill(0), Array(101).fill(0)]);
    groups.get(r.group)[side][r.score]++;
  }
  const hist = [Array(101).fill(0), Array(101).fill(0)];
  const sparse = [...groups.values()].map(pair => pair.map(v => v.flatMap((n, i) => n ? [[i, n]] : [])));
  for (const pair of sparse) for (let side = 0; side < 2; side++) for (const [i, n] of pair[side]) hist[side][i] += n;
  const estimate = aucHist(...hist), random = rng(seed), samples = [];
  for (let b = 0; b < iterations; b++) {
    const hh = [Array(101).fill(0), Array(101).fill(0)];
    for (let j = 0; j < sparse.length; j++) {
      const pair = sparse[Math.floor(random() * sparse.length)];
      for (let side = 0; side < 2; side++) for (const [i, n] of pair[side]) hh[side][i] += n;
    }
    samples.push(aucHist(...hh));
  }
  samples.sort((x, y) => x - y);
  return { auc: estimate, ci95: [quantile(samples, .025), quantile(samples, .975)], n_groups: groups.size,
    ci_warning: groups.size < 10 ? '少于10个独立组，CI不稳定；单组CI不可识别' : null,
    ...(groups.size === 1 ? { ci95: null } : {}),
    paired_documents: new Set(h.map(r => r.human_id)).size, human_n: h.length, ai_n: a.length };
}
export function liftDiagnostics(human, ai) {
  return SIGNALS.map(id => {
    const h = human[id], a = ai[id];
    const lift = h.fire_rate > 0 && a.fire_rate != null ? a.fire_rate / h.fire_rate : null;
    return { id, human_rate: h.fire_rate, ai_rate: a.fire_rate, human_mean_points: h.mean_points, ai_mean_points: a.mean_points,
      lift, zero_human_rate: h.fire_rate === 0, infinite_lift: h.fire_rate === 0 && a.fire_rate > 0,
      rate_difference: h.fire_rate != null && a.fire_rate != null ? a.fire_rate - h.fire_rate : null,
      points_difference: h.mean_points != null && a.mean_points != null ? a.mean_points - h.mean_points : null,
      misfiring: a.fire_rate != null && h.fire_rate > a.fire_rate };
  });
}
