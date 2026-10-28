export type ProgressTask = "article" | "articleFromTitle" | "articleTopics" | "novel" | "rewrite" | "titleCandidates" | "gzhFormat";

export interface ProgressPhase {
  durationMs: number;
  targetPercent: number;
}

export interface ProgressSnapshot {
  percent: number;
  phaseIndex: number;
}

export interface ProgressLogEntry {
  label: string;
  status: "done" | "active" | "pending";
}

const WAITING_PERCENT = 94;

export const PROGRESS_PLANS: Record<ProgressTask, readonly ProgressPhase[]> = {
  article: [
    { durationMs: 9000, targetPercent: 18 },
    { durationMs: 22000, targetPercent: 52 },
    { durationMs: 14000, targetPercent: 78 },
    { durationMs: 10000, targetPercent: 90 },
    { durationMs: 8000, targetPercent: WAITING_PERCENT },
  ],
  articleFromTitle: [
    { durationMs: 8000, targetPercent: 12 },
    { durationMs: 10000, targetPercent: 26 },
    { durationMs: 23000, targetPercent: 58 },
    { durationMs: 13000, targetPercent: 82 },
    { durationMs: 8000, targetPercent: WAITING_PERCENT },
  ],
  articleTopics: [
    { durationMs: 6000, targetPercent: 20 },
    { durationMs: 14000, targetPercent: 58 },
    { durationMs: 9000, targetPercent: 82 },
    { durationMs: 6000, targetPercent: WAITING_PERCENT },
  ],
  novel: [
    { durationMs: 5000, targetPercent: 14 },
    { durationMs: 9000, targetPercent: 32 },
    { durationMs: 26000, targetPercent: 70 },
    { durationMs: 12000, targetPercent: 86 },
    { durationMs: 8000, targetPercent: WAITING_PERCENT },
  ],
  rewrite: [
    { durationMs: 6000, targetPercent: 16 },
    { durationMs: 22000, targetPercent: 68 },
    { durationMs: 9000, targetPercent: 86 },
    { durationMs: 7000, targetPercent: WAITING_PERCENT },
  ],
  titleCandidates: [
    { durationMs: 3000, targetPercent: 24 },
    { durationMs: 8000, targetPercent: 66 },
    { durationMs: 5000, targetPercent: 88 },
    { durationMs: 4000, targetPercent: WAITING_PERCENT },
  ],
  gzhFormat: [
    { durationMs: 8000, targetPercent: 10 },
    { durationMs: 45000, targetPercent: 42 },
    { durationMs: 60000, targetPercent: 72 },
    { durationMs: 45000, targetPercent: 88 },
    { durationMs: 30000, targetPercent: WAITING_PERCENT },
  ],
};

export function getProgressSnapshot(
  plan: readonly ProgressPhase[],
  elapsedMs: number,
  complete = false
): ProgressSnapshot {
  if (plan.length === 0 || complete) {
    return { percent: 100, phaseIndex: Math.max(0, plan.length - 1) };
  }

  const elapsed = Math.max(0, elapsedMs);
  let elapsedBeforePhase = 0;
  let percentBeforePhase = 0;

  for (let phaseIndex = 0; phaseIndex < plan.length; phaseIndex += 1) {
    const phase = plan[phaseIndex];
    const phaseEnd = elapsedBeforePhase + Math.max(1, phase.durationMs);

    if (elapsed <= phaseEnd) {
      const phaseElapsed = elapsed - elapsedBeforePhase;
      const progressWithinPhase = phaseElapsed / Math.max(1, phase.durationMs);
      const eased = 1 - Math.pow(1 - progressWithinPhase, 3);
      const percent = Math.round(
        percentBeforePhase + (phase.targetPercent - percentBeforePhase) * eased
      );

      return {
        percent: clamp(percent, 1, WAITING_PERCENT),
        phaseIndex,
      };
    }

    elapsedBeforePhase = phaseEnd;
    percentBeforePhase = phase.targetPercent;
  }

  return { percent: WAITING_PERCENT, phaseIndex: plan.length - 1 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getProgressLogEntries(labels: readonly string[], phaseIndex: number): ProgressLogEntry[] {
  return labels.map((label, index) => ({
    label,
    status: index < phaseIndex ? "done" : index === phaseIndex ? "active" : "pending",
  }));
}
