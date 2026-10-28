import { useEffect, useMemo, useState } from "react";
import {
  getProgressLogEntries,
  getProgressSnapshot,
  PROGRESS_PLANS,
  type ProgressTask,
} from "../../lib/progress.js";
import { messages, type Dict, type Lang } from "../../lib/i18n.js";

interface ProgressBannerProps {
  busy: string;
  lang: Lang;
  progress: {
    task: ProgressTask;
    startedAt: number;
  };
}

export default function ProgressBanner({ busy, lang, progress }: ProgressBannerProps) {
  const [now, setNow] = useState(() => Date.now());
  const t = messages[lang];
  const labels = labelsForTask(t, progress.task);
  const snapshot = useMemo(
    () => getProgressSnapshot(PROGRESS_PLANS[progress.task], now - progress.startedAt),
    [now, progress.startedAt, progress.task]
  );
  const logEntries = getProgressLogEntries(labels, snapshot.phaseIndex);
  const stepLabel = labels[Math.min(snapshot.phaseIndex, labels.length - 1)] ?? busy;
  const percentText = t.progressPercent(snapshot.percent);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 600);
    return () => window.clearInterval(timer);
  }, [progress.startedAt, progress.task]);

  return (
    <div className="banner busy progress-banner">
      <span className="sr-only" role="status" aria-live="polite">
        {busy}: {stepLabel}
      </span>
      <div className="progress-topline">
        <span>{busy}</span>
        <strong>{percentText}</strong>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={busy}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={snapshot.percent}
        aria-valuetext={`${stepLabel} ${percentText}`}
      >
        <span className="progress-fill" style={{ transform: `scaleX(${snapshot.percent / 100})` }} />
      </div>
      <div className="progress-step">{stepLabel}</div>
      <ol className="progress-log">
        {logEntries.map((entry) => (
          <li className={`progress-log-item ${entry.status}`} key={entry.label}>
            <span className="progress-log-dot" />
            <span>{entry.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function labelsForTask(t: Dict, task: ProgressTask): string[] {
  switch (task) {
    case "article":
      return t.progressArticleSteps;
    case "articleFromTitle":
      return t.progressArticleFromTitleSteps;
    case "articleTopics":
      return t.progressArticleTopicSteps;
    case "novel":
      return t.progressNovelSteps;
    case "rewrite":
      return t.progressRewriteSteps;
    case "titleCandidates":
      return t.progressTitleCandidateSteps;
    case "gzhFormat":
      return t.progressGzhSteps;
  }
}
