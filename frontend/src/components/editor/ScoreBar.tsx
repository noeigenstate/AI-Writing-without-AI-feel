import { useStore } from "../../lib/store.js";
import { messages, type Dict } from "../../lib/i18n.js";
import type { AiScoreDTO, DiagnosticReportDTO } from "../../lib/api.js";

/** Map a score level to its localized label. */
function levelText(level: AiScoreDTO["level"], t: Dict): string {
  return level === "high" ? t.scoreLevelHigh : level === "medium" ? t.scoreLevelMedium : t.scoreLevelLow;
}

type DiagnosticIssue = DiagnosticReportDTO["issues"][number];

/** Layer, label and deducted points of one diagnosed issue. */
function IssueHead({ issue, t }: { issue: DiagnosticIssue; t: Dict }) {
  return (
    <div className="diagnosis-item-head">
      <span>{t.diagnosisLayer(issue.layer)}</span>
      <strong>{issue.label}</strong>
      <small>-{issue.points}</small>
    </div>
  );
}

function DiagnosisReport({ report, t }: { report: DiagnosticReportDTO; t: Dict }) {
  return (
    <section className="diagnosis-report">
      <div className="diagnosis-summary">
        <strong>{t.diagnosisSummary}</strong>
        <p>{report.summary}</p>
      </div>
      {report.issues.length === 0 ? (
        <p className="score-clean">{t.scoreClean}</p>
      ) : (
        <div className="diagnosis-list">
          {report.issues.map((issue) => (
            <article className="diagnosis-item" key={issue.id}>
              <IssueHead issue={issue} t={t} />
              <p>
                <strong>{t.diagnosisSuggestion}: </strong>
                {issue.suggestion}
              </p>
              <div className="diagnosis-examples">
                <strong>{t.diagnosisExamples}: </strong>
                {issue.examples.length ? (
                  issue.examples.map((example) => <code key={`${issue.id}-${example.start}`}>{example.text}</code>)
                ) : (
                  <span>{t.diagnosisNoExamples}</span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

/** A single score readout: number + colored progress track. */
function Gauge({ s, label }: { s: AiScoreDTO; label?: string }) {
  return (
    <div className="score-gauge">
      {label && <span className="score-label">{label}</span>}
      <span className={`score-num lvl-${s.level}`}>{s.score}</span>
      <span className="score-track">
        <span className={`score-fill lvl-${s.level}`} style={{ transform: `scaleX(${s.score / 100})` }} />
      </span>
    </div>
  );
}

/** Per-pattern hit statistics: before-vs-after columns, or just current hits when no `after`. */
function Stats({ before, after, t }: { before: AiScoreDTO; after?: AiScoreDTO; t: Dict }) {
  const afterMap = new Map((after?.signals ?? []).map((s) => [s.id, s.hits]));
  const rows = before.signals
    .filter((s) => s.hits > 0)
    .map((s) => ({ id: s.id, label: s.label, before: s.hits, after: after ? afterMap.get(s.id) ?? 0 : undefined }));

  if (rows.length === 0) return <p className="score-clean">{t.scoreClean}</p>;

  return (
    <table className="score-stats">
      <thead>
        <tr>
          <th>{t.scoreColTell}</th>
          {after ? (
            <>
              <th>{t.scoreBefore}</th>
              <th>{t.scoreAfter}</th>
            </>
          ) : (
            <th>{t.scoreFound(0).replace(/\d+\s*/, "")}</th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{r.label}</td>
            {after ? (
              <>
                <td>{r.before}</td>
                <td className={r.after === 0 ? "stat-gone" : ""}>{r.after}</td>
              </>
            ) : (
              <td>{r.before}</td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Issues still flagged after the rewrite, with a hint to keep polishing. */
function RemainingIssues({ issues, t }: { issues: DiagnosticIssue[]; t: Dict }) {
  return (
    <details className="score-details diagnosis-details" open>
      <summary>{t.remainingIssuesTitle}</summary>
      <div className="diagnosis-report">
        <div className="diagnosis-summary">
          <strong>{t.remainingIssuesHint}</strong>
          <p>{t.continuePolishHint}</p>
        </div>
        <div className="diagnosis-list">
          {issues.map((issue) => (
            <article className="diagnosis-item" key={`remaining-${issue.id}`}>
              <IssueHead issue={issue} t={t} />
              <p>{issue.suggestion}</p>
            </article>
          ))}
        </div>
      </div>
    </details>
  );
}

/** Pattern hits the rewrite removed; a pattern that gained hits counts as zero. */
function countRemovedHits(before: AiScoreDTO, after: AiScoreDTO): number {
  return before.signals.reduce((sum, s) => {
    const a = after.signals.find((x) => x.id === s.id)?.hits ?? 0;
    return sum + Math.max(0, s.hits - a);
  }, 0);
}

function issuesOf(score: AiScoreDTO | undefined): DiagnosticReportDTO["issues"] {
  return score && "issues" in score ? (score as DiagnosticReportDTO).issues : [];
}

/** Score panel shown in the editor: before→after gauges plus the stats breakdown. */
export default function ScoreBar() {
  const aiScore = useStore((st) => st.aiScore);
  const currentScore = useStore((st) => st.currentScore);
  const diagnosis = useStore((st) => st.diagnosis);
  const recompute = useStore((st) => st.recomputeScore);
  const diagnoseCurrent = useStore((st) => st.diagnoseCurrent);
  const lang = useStore((st) => st.lang);
  const t = messages[lang];

  // 改写后：用 before/after 对照；否则用当前实时分
  const head = aiScore ?? (currentScore ? { before: currentScore } : null);
  if (!head) return null;

  const before = head.before;
  const after = "after" in head ? head.after : undefined;
  const gain = after ? after.score - before.score : 0;

  const totalRemoved = after ? countRemovedHits(before, after) : 0;
  const remainingIssues = issuesOf(after).slice(0, 4);

  const headline = after ?? before;

  return (
    <section className="score-panel">
      <div className="score-row">
        <div className="score-headline">
          <span className="score-title">{t.scoreTitle}</span>
          {after ? (
            <div className="score-compare">
              <Gauge s={before} label={t.scoreBefore} />
              <span className="score-arrow">→</span>
              <Gauge s={after} label={t.scoreAfter} />
              {gain > 0 && <span className="score-drop">{t.scoreDrop(gain)}</span>}
            </div>
          ) : (
            <Gauge s={before} label={t.scoreCurrent} />
          )}
        </div>
        <div className="score-meta">
          <span className={`score-pill lvl-${headline.level}`}>{levelText(headline.level, t)}</span>
          {after && totalRemoved > 0 && <span className="score-removed">{t.scoreRemoved(totalRemoved)}</span>}
          <button className="link score-rescore" onClick={() => void diagnoseCurrent()}>
            {t.diagnose}
          </button>
          <button className="link score-rescore" onClick={() => void recompute()}>
            {t.rescore}
          </button>
        </div>
      </div>

      <details className="score-details">
        <summary>{t.scoreStatsTitle}</summary>
        <Stats before={before} after={after} t={t} />
      </details>

      {diagnosis && (
        <details className="score-details diagnosis-details" open>
          <summary>{t.diagnosisTitle}</summary>
          <DiagnosisReport report={diagnosis} t={t} />
        </details>
      )}

      {after && remainingIssues.length > 0 && <RemainingIssues issues={remainingIssues} t={t} />}

      <p className="score-foot">{t.scoreHint}</p>
    </section>
  );
}
