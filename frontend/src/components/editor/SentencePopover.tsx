import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useStore } from "../../lib/store.js";
import { messages } from "../../lib/i18n.js";
import type { ProgressTask } from "../../lib/progress.js";
import ProgressBanner from "../common/ProgressBanner.js";

interface Props {
  heading: string;
  original: string;
  anchor?: FloatingAnchor;
  /** 加载候选（句子候选或标题候选） */
  loadCandidates: () => Promise<string[]>;
  progressTask?: ProgressTask;
  onAdopt: (text: string) => void;
  onClose: () => void;
}

type FloatingAnchor = Pick<DOMRect, "left" | "top" | "bottom">;

/** Modal that lists alternative phrasings (or titles) and lets the user adopt/edit one. */
export default function RewritePopover({
  heading,
  original,
  anchor,
  loadCandidates,
  progressTask,
  onAdopt,
  onClose,
}: Props) {
  const lang = useStore((s) => s.lang);
  const t = messages[lang];
  const { loading, alts, err } = useCandidates(loadCandidates);
  const [edit, setEdit] = useState(original);
  const [progressStartedAt] = useState(() => Date.now());
  const headingId = useId();
  const originalId = useId();
  const manualEditId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const style = floatingStyle(anchor);
  const showCandidates = !loading && !err;

  return (
    <div className="popover-layer">
      <div
        className="popover floating-popover"
        style={style}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={originalId}
        onKeyDown={keepFocusInside}
      >
        <div className="popover-head">
          <span id={headingId}>{heading}</span>
          <button ref={closeButtonRef} type="button" className="link" onClick={onClose}>
            {t.close}
          </button>
        </div>

        <div id={originalId} className="orig">{t.originalLabel}{original}</div>

        <div className="alts">
          {loading &&
            (progressTask ? (
              <ProgressBanner
                busy={t.loadingCandidates}
                lang={lang}
                progress={{ task: progressTask, startedAt: progressStartedAt }}
              />
            ) : (
              <div className="hint">{t.loadingCandidates}</div>
            ))}
          {err && <div className="error" role="alert">{err}</div>}
          {showCandidates &&
            alts.map((a, i) => (
              <button key={i} type="button" className="alt" onClick={() => onAdopt(a)}>
                {a}
              </button>
            ))}
          {showCandidates && alts.length === 0 && <div className="hint">{t.noCandidates}</div>}
        </div>

        <div className="edit-area">
          <label htmlFor={manualEditId}>{t.manualEdit}</label>
          <textarea id={manualEditId} value={edit} onChange={(e) => setEdit(e.target.value)} rows={3} />
          <div className="row-end">
            <button type="button" className="primary" onClick={() => onAdopt(edit)}>
              {t.adopt}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Load the candidate list once; a new popover is mounted for every selection. */
function useCandidates(loadCandidates: () => Promise<string[]>) {
  const [loading, setLoading] = useState(true);
  const [alts, setAlts] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadCandidates()
      .then((a) => alive && setAlts(a))
      .catch((e) => alive && setErr(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { loading, alts, err };
}

/** Wrap Tab / Shift+Tab focus around the dialog's focusable controls. */
function keepFocusInside(event: React.KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    )
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function floatingStyle(anchor: FloatingAnchor | undefined): CSSProperties {
  if (!anchor || typeof window === "undefined") return {};

  const margin = 16;
  const width = Math.min(560, window.innerWidth - margin * 2);
  const leftBase = anchor.left ?? margin;
  const topBase = (anchor.bottom ?? anchor.top ?? margin) + 10;
  const left = Math.max(margin, Math.min(leftBase, window.innerWidth - width - margin));
  const top = Math.max(margin, Math.min(topBase, window.innerHeight - 240));

  return {
    position: "fixed",
    width,
    left,
    top,
  };
}
