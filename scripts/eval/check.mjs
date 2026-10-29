// Deterministic checks for statistical orientation, clustering and sentence cuts.
import assert from 'node:assert/strict';
import { chunks, auc, distribution, correlation, signalStats, liftDiagnostics } from './metrics.mjs';
import { han, loadSample } from './common.mjs';

const unit = (score, group = 'g1', human_id = group) => ({ score, group, human_id, char_count: 500, signals: [] });
assert.equal(auc([unit(90)], [unit(10)], 100).auc, 1);
assert.equal(auc([unit(10)], [unit(90)], 100).auc, 0);
assert.equal(auc([unit(50)], [unit(50)], 100).auc, .5);
assert.equal(auc([unit(50)], [], 100).auc, null);
assert.equal(auc([unit(50, 'one')], [unit(50, 'other')], 100).paired_documents, 0);
assert.equal(auc([unit(90)], [unit(10)], 100).ci95, null);
const h = [unit(90, 'a'), unit(90, 'a'), unit(20, 'b')], a = [unit(10, 'a'), unit(80, 'b')];
assert.deepEqual(auc(h, a, 200), auc(h, a, 200));
assert.equal(auc(h, a, 200).n_groups, 2);
assert.ok(Math.abs(auc(h, a, 100).auc - 5 / 6) < 1e-12);
assert.equal(correlation([1, 2, 3], [3, 2, 1]), -1);
assert.equal(correlation([1, 1, 1], [1, 2, 3]), null);
const text = ('甲'.repeat(249) + '。').repeat(4) + '尾'.repeat(199) + '。';
const cut = chunks(text);
assert.equal(cut.texts.length, 2);
assert.ok(cut.texts.every(t => han(t) === 498 && t.endsWith('。')));
assert.equal(cut.dropped_han, 199);
assert.equal(cut.texts.join('') + '尾'.repeat(199) + '。', text);
assert.equal(chunks('甲'.repeat(800) + '。').texts.length, 1);
assert.equal(chunks('甲'.repeat(200)).texts.length, 1);
assert.equal(chunks('甲'.repeat(199)).texts.length, 0);
const d = distribution([unit(39), unit(40), unit(69), unit(70), unit(100)]);
assert.equal(d.low_rate, .2); assert.equal(d.below_high_rate, .6); assert.equal(d.high_rate, .4);
const sig = signalStats([{ ...unit(50), signals: [{ id: 'uniformity', hits: 0, points: 8 }] }]);
assert.equal(sig.uniformity.fire_rate, 1); assert.equal(sig.uniformity.literal_hit_rate, 0);
assert.equal(sig.opener.mean_points, 0);
assert.equal(liftDiagnostics(signalStats([unit(50)]), sig).find(s => s.id === 'uniformity').infinite_lift, true);
const sample = loadSample();
assert.equal(sample.length, 300);
for (const subset of new Set(sample.map(r => r.subset))) {
  const rows = sample.filter(r => r.subset === subset);
  assert.equal(rows.length, 100);
  assert.ok(Math.abs(rows.filter(r => r.split === 'dev').length - 50) <= 5);
}
console.log('PASS: AUC orientation/ties/missingness, paired group bootstrap, quantiles/thresholds, sentence chunks, signal semantics, 300-piece split integrity');
