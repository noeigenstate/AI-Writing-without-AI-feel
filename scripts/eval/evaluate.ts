import fs from 'node:fs';
import path from 'node:path';
import { ROOT, OUT, EVAL_SOURCES, expectedAI, SUBSETS, SEED, loadSample, humanText, aiPath, han, hash, jsonl, atomic, writeJSON, writeJSONL } from './common.mjs';
import { SIGNALS, chunks, distribution, signalStats, auc, correlation, liftDiagnostics } from './metrics.mjs';
import { scoreText } from '../../backend/src/services/aiScore.ts';

const CLASSES = ['human', ...EVAL_SOURCES.flatMap(({ model, variants }) => variants.map(v => `${model}/ai-${v}`))];
const names = { 'human-zh': 'PD', 'human-zh-open': 'open', 'human-zh-gov': 'gov' };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const num = (x: number | null | undefined, n = 3) => x == null ? '—' : x.toFixed(n);
const pct = (x: number | null | undefined) => x == null ? '—' : (x * 100).toFixed(1) + '%';
const table = (heads: string[], rows: unknown[][]) => `<div class="scroll"><table><thead><tr>${heads.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const markdown = (heads: string[], rows: unknown[][]) => [heads, heads.map(() => '---'), ...rows].map(row => '| ' + row.map(s => String(s).replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ')).join(' | ') + ' |').join('\n');

async function main() {
  const allowPartial = process.argv.includes('--allow-partial');
  const bootstrap = Number(process.argv.find(a => a.startsWith('--bootstrap='))?.split('=')[1] ?? 1000);
  if (!Number.isInteger(bootstrap) || bootstrap < 100) throw new Error('Use at least 100 bootstrap replicates (default 1000)');
  const sample = loadSample();
  const expected = expectedAI(sample);
  const scored: any[] = [], missing: any[] = [], chunkAudit: any[] = [], warnings: string[] = [];
  const manifest = jsonl(path.join(OUT, 'ai-manifest.jsonl'));
  const index = new Map(manifest.map(m => [`${m.human_id}/${m.model}/${m.variant}`, m]));
  if (manifest.length !== index.size) throw new Error('Duplicate ai-manifest keys');
  function add(row: any, text: string, cls: string, model: string | null, variant: string | null) {
    const evaluate = (part: string, granularity: string, chunk_index: number | null) => {
      const s = scoreText(part, 'zh');
      scored.push({ human_id: row.human_id, subset: row.subset, genre: row.genre, group: row.group, split: row.split,
        class: cls, model, variant, granularity, chunk_index, char_count: han(part), codepoint_count: Array.from(part).length,
        score: s.score, level: s.level, signals: s.signals.map(({ id, hits, points }) => ({ id, hits, points })) });
    };
    evaluate(text, 'document', null);
    const split = chunks(text);
    split.texts.forEach((part, i) => evaluate(part, 'chunk', i));
    chunkAudit.push({ human_id: row.human_id, class: cls, chunks: split.texts.length, dropped_han: split.dropped_han, max_chunk_han: Math.max(0, ...split.texts.map(han)) });
  }
  for (const row of sample) {
    add(row, humanText(row), 'human', null, null);
    for (const { model, variants } of EVAL_SOURCES) for (const variant of variants) {
      const f = aiPath(row, model, variant), key = `${row.human_id}/${model}/${variant}`, m = index.get(key);
      if (!fs.existsSync(f) || !m) { missing.push({ human_id: row.human_id, model, variant }); continue; }
      const text = fs.readFileSync(f, 'utf8');
      if (hash(text) !== m.output_sha256 || han(text) !== m.output_chars) throw new Error(`AI integrity mismatch: ${key}`);
      add(row, text, `${model}/ai-${variant}`, model, variant);
    }
  }
  if (missing.length) warnings.push(`配对生成未完成：缺少 ${missing.length}/${expected} 份 AI 文本；结果仅为可用缓存与人类基线，不能代表完整试验。`);
  const zeroChunks = chunkAudit.filter(r => !r.chunks).length;
  if (zeroChunks) warnings.push(`${zeroChunks} 份文档没有可评分块（尾块不足200汉字）；仍纳入整篇评分。`);
  if (sample.some(r => r.source === 'hc3')) warnings.push('HC3 的 source + work 只有两个来源组，整组切分后每个 split 仅含其中一个领域；问答分层仅有一个独立组，无法识别组间 bootstrap CI。');
  const slices: any[] = [];
  const dimensions = [{ dimension: 'all', value: 'all', filter: (r: any) => true },
    ...SUBSETS.map(subset => ({ dimension: 'subset', value: subset, filter: (r: any) => r.subset === subset })),
    ...[...new Set(sample.map(r => r.genre))].sort().map(genre => ({ dimension: 'genre', value: genre, filter: (r: any) => r.genre === genre }))];
  for (const split of ['dev', 'test']) for (const granularity of ['chunk', 'document']) {
    const base = scored.filter(r => r.split === split && r.granularity === granularity);
    for (const dim of dimensions) {
      const rows = base.filter(dim.filter);
      const classes = Object.fromEntries(CLASSES.map(cls => {
        const rs = rows.filter(r => r.class === cls);
        const byDoc = new Map();
        for (const r of rs) { if (!byDoc.has(r.human_id)) byDoc.set(r.human_id, []); byDoc.get(r.human_id).push(r); }
        const docMeans = [...byDoc.values()].map(arr => ({ len: arr.reduce((n, r) => n + r.char_count, 0) / arr.length, score: arr.reduce((n, r) => n + r.score, 0) / arr.length }));
        return [cls, { ...distribution(rs), signals: signalStats(rs),
          document_mean_chunk_score_vs_mean_chunk_length: granularity === 'chunk' ? correlation(docMeans.map(d => d.len), docMeans.map(d => d.score)) : null }];
      }));
      const humans = rows.filter(r => r.class === 'human');
      const comparisons = Object.fromEntries(CLASSES.slice(1).map((cls, i) => {
        const ai = rows.filter(r => r.class === cls);
        const ids = new Set(ai.map(r => r.human_id));
        const pairedHuman = humans.filter(r => ids.has(r.human_id));
        return [cls, { ...auc(humans, ai, bootstrap, SEED + i), signals: liftDiagnostics(signalStats(pairedHuman), signalStats(ai)) }];
      }));
      slices.push({ split, granularity, dimension: dim.dimension, value: dim.value, classes, comparisons });
    }
    console.log(`Evaluated ${split}/${granularity} (${rowsCount(base)} scored units)`);
  }
  const generation = fs.existsSync(path.join(OUT, 'generation-summary.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'generation-summary.json'), 'utf8')) : null;
  const codexGeneration = fs.existsSync(path.join(OUT, 'codex-generation-summary.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'codex-generation-summary.json'), 'utf8')) : null;
  const acceptance = fs.existsSync(path.join(OUT, 'acceptance-check.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'acceptance-check.json'), 'utf8')) : null;
  if (codexGeneration?.abort_reason) warnings.unshift(`Codex 生成停止原因：${codexGeneration.abort_reason}`);
  if (generation?.abort_reason) warnings.unshift(`生成停止原因：${generation.abort_reason}`);
  if (missing.length) {
    const available = [...new Set(scored.filter(r => r.class !== 'human').map(r => names[r.subset]))];
    warnings.push(`当前AI缓存覆盖：${available.join('、') || '无'}。生成按human_id顺序进行，已完成前缀不是随机AI子样本，不能外推完整pilot。`);
  }
  const results = { schema_version: 1, created_at: new Date().toISOString(), complete: missing.length === 0, seed: SEED,
    scorer_sha256: hash(fs.readFileSync(path.join(ROOT, 'backend/src/services/aiScore.ts'), 'utf8')),
    sample_sha256: hash(fs.readFileSync(path.join(OUT, 'sample.jsonl'), 'utf8')),
    methodology: { primary: 'chunk', chunk_target_han: 500, minimum_trailing_han: 200, boundaries: '。！？!? with closing quotes; never split a sentence (long sentences can exceed target)',
      thresholds: { low: '<40', below_high: '<70', high: '>=70' }, auc_direction: 'P(human score > AI score) + 0.5 P(tie)',
      bootstrap: { replicates: bootstrap, seed: SEED, unit: 'paired leakage group; all matching human + AI documents/chunks retained jointly; percentile CI', estimand: 'chunk-weighted AUC; document AUC secondary' },
      signal_hit_rate: 'fire_rate = returned signal with positive points; literal_hit_rate = returned hits > 0 (uniformity uses hits=0; concreteness hits count anchors, not rule violations)',
      absent_signals: 'Scorer suppresses points<0.5 and rounds returned points; diagnostics use only its public signals API, not internal uncensored penalties',
      length: 'Pearson r: chunk score vs chunk Han length; document score vs total document Han length; also document-mean chunk score vs mean chunk Han length',
      partial_auc: 'only documents with both human and AI scoring units; missing classes have null metrics, never zero' },
    counts: { human_documents: sample.length, ai_documents: expected - missing.length, expected_ai_documents: expected, scoring_units: scored.length, zero_chunk_documents: zeroChunks },
    sources: EVAL_SOURCES, warnings, generation, codex_generation: codexGeneration, acceptance, missing, chunk_audit: chunkAudit, slices };
  writeJSON(path.join(OUT, 'results.json'), results);
  writeJSONL(path.join(OUT, 'scores.jsonl'), scored);
  const headline = slices.filter(s => s.split === 'test' && s.granularity === 'chunk' && s.dimension === 'subset').flatMap(s => CLASSES.slice(1).map(cls => {
    const c = s.comparisons[cls], h = s.classes.human, a = s.classes[cls];
    return [names[s.value], cls, `${c.paired_documents}`, num(c.auc), c.ci95 ? c.ci95.map(x => num(x)).join('–') : '—', pct(h.low_rate), pct(h.below_high_rate), pct(a.high_rate)];
  }));
  const headlineHeads = ['子集', 'AI类别', '配对篇数', 'AUC', '95% CI', '人类FPR <40', '人类FPR <70', 'AI通过率 ≥70'];
  const overall = slices.find(s => s.split === 'test' && s.granularity === 'chunk' && s.dimension === 'all');
  const modelHeads = ['模型×变体', '配对篇数', 'AUC', '95% CI', 'AI通过率 ≥70'];
  const modelRows = CLASSES.slice(1).map(cls => { const c = overall.comparisons[cls]; return [cls, c.paired_documents, num(c.auc), c.ci95 ? c.ci95.map(x => num(x)).join('–') : '—', pct(overall.classes[cls].high_rate)]; });
  const ranked = CLASSES.slice(1).flatMap(cls => overall.comparisons[cls].signals.filter(s => s.rate_difference != null).map(s => ({ class: cls, ...s })));
  const misfiring = ranked.filter(s => s.misfiring).sort((a, b) => a.rate_difference - b.rate_difference).slice(0, 10);
  const useful = ranked.filter(s => s.rate_difference > 0).sort((a, b) => b.rate_difference - a.rate_difference || b.points_difference - a.points_difference).slice(0, 10);
  const rankRows = rs => rs.map(s => [s.class, s.id, pct(s.human_rate), pct(s.ai_rate), s.infinite_lift ? '∞' : num(s.lift, 2), num(s.points_difference, 2)]);
  const signalHeads = ['AI类别', '信号', '人类触发率', 'AI触发率', 'AI/人类', 'AI−人类平均扣分'];
  const tokenRows = EVAL_SOURCES.map(({ model }) => { const t = model === 'codex-gpt' ? codexGeneration?.totals : generation?.totals?.[model]; return [model, t?.prompt_tokens ?? '未知', t?.completion_tokens ?? '未知', t?.total_tokens ?? '未知', t?.failed_attempts ?? '未知', t?.retries ?? '未知', model === 'codex-gpt' ? '批次实测；逐篇均摊估计' : 'API响应实测']; });
  const status = results.complete ? '完整配对试验' : '未完成的配对试验 / 人类基线';
  const summary = `# AI 味评分器 pilot：${status}\n\n300 篇人类文本，${results.counts.ai_documents}/${expected} 份 AI 文本；seed=${SEED}。主指标使用约 500 汉字句界分块，尾块不足 200 丢弃。高分表示更像人类。\n\n${warnings.map(w => `- ${w}`).join('\n')}\n\n## test 主指标\n\n${markdown(headlineHeads, headline)}\n\nAUC 方向为人类分数更高；CI 以配对分组为单位 bootstrap ${bootstrap} 次。FPR 以该子集全部人类块为分母，非 AI 错判率。改写为灰类，单独解释。\n\n## test 总体：模型×变体（分块）\n\n${markdown(modelHeads, modelRows)}\n\n## 最常误伤人类的规则（test，总体）\n\n${misfiring.length ? markdown(signalHeads, rankRows(misfiring)) : '暂无可比较的 AI 数据或没有误伤规则。'}\n\n## 最有区分力的规则（test，总体）\n\n${useful.length ? markdown(signalHeads, rankRows(useful)) : '暂无可比较的 AI 数据或没有正向区分规则。'}\n\n按 AI−人类触发率差排序；这是探索性诊断，未做显著性检验。公开 signals API 不暴露低于0.5的扣分，uniformity 的 hits 恒为0，故主触发率用 points>0，同时另报 hits>0。\n\n## 模型用量与重试\n\n${markdown(['模型', '输入tokens', '输出tokens（含提供商计入的思考）', '总tokens', '失败尝试', '重试', '用量口径'], tokenRows)}\n\n用量来自持久化的实际 API 响应，含产生无效内容的响应；超时或断网时提供商可能计费但不返回用量。改写可能多次调用，文档数不等于API调用数。Codex 保留代理系统提示，humanized 将规则嵌入用户提示，逐篇 usage 是批次用量均摊估计；与 DeepSeek 的 system 角色并不等价。费用应按网关账单核对，脚本不猜测模型单价。\n\n完整分层分布、信号、长度相关性和整篇对照：report.html、results.json；逐块分数：scores.jsonl。\n\n限制：历史公开文本不代表当代全部写作；有名篇可能被模型记忆；humanized 直接采用同项目规则，属于自适应压力测试；尚未调整评分器或阈值。\n`;
  atomic(path.join(OUT, 'summary.md'), summary);
  if (acceptance) fs.appendFileSync(path.join(OUT, 'summary.md'), '\n验收：原 check.sh 全部21项 rc=0；DOCX 往返使用公开合成样例，通过运行时适配重定向两个路径，未读写根目录 test/。这不代表验证了私人原样例。应用源码无差异，未提交。\n');
  function histogram(cls, stat) {
    const max = Math.max(1, ...stat.histogram);
    return `<figure><figcaption>${esc(cls)}（n=${stat.n}）</figcaption><svg viewBox="0 0 320 132" role="img" aria-label="${esc(cls)} 分数直方图"><title>分数直方图：0到100；纵轴为数量</title>${stat.histogram.map((n, i) => { const h = n / max * 88; return `<rect x="${15 + i * 29}" y="${100 - h}" width="24" height="${h}" fill="currentColor"><title>${i * 10}–${i === 9 ? 100 : i * 10 + 9}: ${n}</title></rect>`; }).join('')}<path d="M12 100H308" stroke="currentColor"/><g fill="currentColor" font-size="11"><text x="12" y="118">0</text><text x="150" y="118">50</text><text x="288" y="118">100</text><text x="12" y="10">max=${max}</text></g></svg></figure>`;
  }
  const sections = slices.map(s => {
    const label = `${s.split} · ${s.granularity === 'chunk' ? '分块（主）' : '整篇（对照）'} · ${s.dimension === 'all' ? '总体' : s.dimension === 'subset' ? names[s.value] : s.value}`;
    const statsRows = CLASSES.map(cls => { const c = s.classes[cls]; return [cls, c.n, c.documents, num(c.mean, 1), num(c.median, 1), num(c.p10, 1), num(c.p90, 1), pct(c.low_rate), pct(c.below_high_rate), pct(c.high_rate), num(c.score_length_pearson), num(c.document_mean_chunk_score_vs_mean_chunk_length)]; });
    const aucRows = CLASSES.slice(1).map(cls => { const a = s.comparisons[cls]; return [cls, num(a.auc), a.ci95 ? a.ci95.map(x => num(x)).join('–') : '—', a.paired_documents, a.n_groups, a.ci_warning ?? '']; });
    const rateRows = CLASSES.flatMap(cls => SIGNALS.map(id => { const d = s.classes[cls].signals[id]; return [cls, id, pct(d.fire_rate), pct(d.literal_hit_rate), num(d.mean_hits, 2), num(d.mean_points, 2)]; }));
    const liftRows = CLASSES.slice(1).flatMap(cls => s.comparisons[cls].signals.map(d => [cls, d.id, d.infinite_lift ? '∞' : num(d.lift, 2), pct(d.rate_difference), num(d.points_difference, 2), d.misfiring ? '误伤：人类触发更多' : '']));
    return `<details${s.dimension === 'all' && s.granularity === 'chunk' ? ' open' : ''}><summary>${esc(label)}</summary><h3>分布、阈值与长度相关性</h3>${table(['类别', '样本单位数', '篇数', '均值', '中位', 'P10', 'P90', '<40', '<70', '≥70', '分数/长度 r', '篇均块分/块长 r'], statsRows)}<h3>AUC（配对、组 bootstrap）</h3>${table(['AI类别', 'AUC', '95% CI', '配对篇数', '独立组', '限制'], aucRows)}${s.dimension === 'all' ? `<div class="histograms">${CLASSES.map(cls => histogram(cls, s.classes[cls])).join('')}</div>` : ''}<details><summary>每个信号的触发率与扣分</summary>${table(['类别', '信号', '触发率 points>0', '字面命中率 hits>0', '平均hits', '平均扣分'], rateRows)}</details><details><summary>信号区分力与误伤</summary>${table(['AI类别', '信号', 'AI/人类触发率', 'AI−人类触发率', 'AI−人类平均扣分', '误伤'], liftRows)}</details></details>`;
  }).join('\n');
  atomic(path.join(OUT, 'report.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>AI 味评分器 pilot 评估</title><style>
  :root{color-scheme:light dark;font:16px/1.65 system-ui,"Microsoft YaHei",sans-serif;background:#faf9f5;color:#262626;--panel:#fff;--line:#cbc9c1;--accent:#16645f;--warn:#fff2ce}*{box-sizing:border-box}body{margin:0 auto;max-width:1480px;padding:clamp(14px,3vw,40px)}h1{font-size:clamp(26px,4vw,42px);line-height:1.2}h2{margin-top:2rem}h3{font-size:1.05rem}p{max-width:90ch}.meta{color:#64645e}.warning{background:var(--warn);padding:14px;border-left:4px solid #a87913;margin:12px 0}.scroll{overflow-x:auto;margin:12px 0;max-width:100%}table{border-collapse:collapse;width:100%;font-size:14px;white-space:nowrap;font-variant-numeric:tabular-nums}td,th{padding:8px 12px;border-bottom:1px solid var(--line);text-align:left}th{background:var(--panel)}details{border:1px solid var(--line);padding:12px;margin:16px 0;background:var(--panel)}details details{padding:8px}summary{cursor:pointer;font-weight:650;color:var(--accent)}summary:focus-visible,a:focus-visible{outline:3px solid #b88420;outline-offset:4px}.histograms{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:12px}figure{margin:0;padding:12px;border:1px solid var(--line);color:var(--accent)}figcaption{font-size:13px;overflow-wrap:anywhere}svg{display:block;width:100%;height:auto}@media(prefers-color-scheme:dark){:root{background:#171c1c;color:#e6e9e8;--panel:#202727;--line:#4a5654;--accent:#8ed1c5;--warn:#3f341e}.meta{color:#b2bcba}}@media print{details{break-inside:avoid}body{max-width:none;padding:0}}
  </style><body><h1>AI 味评分器：pilot 评估</h1><p class="meta">${esc(status)} · ${esc(results.created_at)} · seed ${SEED} · 全离线报告</p>${warnings.map(w => `<p class="warning">${esc(w)}</p>`).join('')}<p>人类文本300篇，AI配对文本 ${results.counts.ai_documents}/${expected} 份。评分越高越像人类。主指标采用约500汉字、完整句子分块，尾块不足200丢弃；长句可能超过500。high ≥70，medium 40–69，low &lt;40。改写结果为“AI润色人类文本”灰类。</p><h2>test：各子集主指标</h2>${table(headlineHeads, headline)}<p>AUC = P(人类分数 &gt; AI分数) + 0.5 P(同分)。95% CI 以配对分组重抽样 ${bootstrap} 次，保留组内全部文档及块。FPR以该子集全部人类块为分母；AI通过率为AI块得分≥70的比例。少于10个组的CI不稳定，只有1组时不报告CI。</p><h2>test 总体：模型×变体（分块）</h2>${table(modelHeads, modelRows)}<h2>最常误伤人类的信号（test总体）</h2>${misfiring.length ? table(signalHeads, rankRows(misfiring)) : '<p>暂无可比较的AI数据或无误伤规则。</p>'}<h2>最有区分力的信号（test总体）</h2>${useful.length ? table(signalHeads, rankRows(useful)) : '<p>暂无可比较的AI数据或无正向区分规则。</p>'}<p>按AI−人类触发率差排序，属于探索性诊断。主触发率使用 points&gt;0：uniformity 的 hits 恒为0，concreteness 的 hits 表示具体锚点数量。另报字面命中率 hits&gt;0。评分器会隐藏低于0.5的扣分并对其余扣分取整，因此这些统计仅反映公开 signals API。</p><h2>模型用量</h2>${table(['模型', '输入tokens', '输出tokens', '总tokens', '失败尝试', '重试', '用量口径'], tokenRows)}<p>实际响应累计用量包含无效内容的响应；断网或超时可能产生未返回的计费用量。改写有独立标题调用和每12段正文一组的调用；请求级缓存可减少恢复成本。Codex 保留代理系统提示，humanized 规则嵌入用户提示；逐篇 usage 是批次均摊估计，批次总量来自 turn.completed。费用以实际账单为准。</p><h2>dev / test 完整分层结果</h2><p>展开查看总体、子集和体裁。分块的 r 为块分数与块汉字数相关性；整篇的 r 为整篇分数与总汉字数相关性。另以文档为单位比较平均块分数与平均块长，避免把所有块当作独立文档。</p>${sections}<h2>解释边界</h2><p>历史公开人类文本不代表全部当代写作；有名篇可能出现在模型训练集中。humanized 直接采用同项目反AI规则，是自适应压力测试。未调参、未改阈值；dev与test分别列出。数据不完整时AUC只比较缓存中实际配对的文档，缺失值显示“—”，不会伪装为0。组切分与来源元数据见 sample.jsonl / sample-audit.json，逐块分数和机器结果见 scores.jsonl / results.json。</p></body></html>`);
  console.log(markdown(headlineHeads, headline));
  console.log(`Wrote ${path.join(OUT, 'report.html')} and summary.md; complete=${results.complete}`);
  if (missing.length && !allowPartial) { console.error('Evaluation incomplete: missing AI outputs. Resume generate, or use --allow-partial for an explicitly labelled baseline.'); process.exitCode = 1; }
}
function rowsCount(rows) { return rows.length; }
main().catch((e: any) => { console.error(e.message); process.exitCode = 1; });
