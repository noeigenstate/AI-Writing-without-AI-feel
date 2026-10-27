import { useEffect, useId, useRef, useState } from "react";
import {
  fetchGzhThemes,
  formatGzhArticle,
  type GzhFormatResponseDTO,
  type GzhThemeDTO,
} from "../../lib/api.js";
import { downloadBlob } from "../../lib/download.js";
import { paragraphsToMarkdown, renderBlocksForGzh } from "../../lib/gzhMarkdown.js";
import { hydrateGzhSourceMedia } from "../../lib/gzhMedia.js";
import { buildPreviewDoc, buildStandalonePreview, sanitizeFileName } from "../../lib/gzhPreview.js";
import { useStore } from "../../lib/store.js";
import { Sparkle } from "../common/icons.js";
import ProgressBanner from "../common/ProgressBanner.js";
import { messages, type Dict, type Lang } from "../../lib/i18n.js";

/** A blocking backend validation error makes both rich-copy and HTML download unavailable. */
export function canExportGzhResult(
  result: Pick<GzhFormatResponseDTO, "validation"> | GzhFormatResponseDTO | null
): result is GzhFormatResponseDTO {
  return Boolean(result && result.validation.errors.length === 0);
}

/**
 * Inline 公众号排版 panel for the current editor document: pick a theme,
 * auto-format the current text, then copy the rich text or download HTML.
 */
export default function GzhExportPanel() {
  const lang = useStore((s) => s.lang);
  const paragraphs = useStore((s) => s.paragraphs);
  const renderBlocks = useStore((s) => s.renderBlocks);
  const titleIndex = useStore((s) => s.titleIndex);
  const globalBusy = useStore((s) => s.busy);
  const t = messages[lang];

  const [themes, setThemes] = useState<GzhThemeDTO[]>([]);
  const [themeId, setThemeId] = useState("");
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<{ task: "gzhFormat"; startedAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GzhFormatResponseDTO | null>(null);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const themeSelectId = useId();

  useEffect(() => {
    void fetchGzhThemes(lang).then((list) => {
      setThemes(list);
      setThemeId((cur) => (list.some((x) => x.id === cur) ? cur : list[0]?.id ?? ""));
    });
  }, [lang]);

  function buildGzhInput() {
    return renderBlocks?.length
      ? renderBlocksForGzh(renderBlocks, paragraphs)
      : { markdown: paragraphsToMarkdown(paragraphs, titleIndex), sourceMedia: [] };
  }

  async function format() {
    setWorking(true);
    setError(null);
    setResult(null);
    setCopied(null);
    setProgress({ task: "gzhFormat", startedAt: Date.now() });
    try {
      const prepared = buildGzhInput();
      const formatted = await formatGzhArticle(prepared.markdown, themeId, "", lang);
      const hydrated = hydrateGzhSourceMedia(formatted.html, prepared.sourceMedia, lang);
      const mediaWarning = missingMediaWarning(hydrated.missingTokens.length, lang);
      setResult({
        ...formatted,
        html: hydrated.html,
        validation: mediaWarning
          ? { ...formatted.validation, warnings: [...formatted.validation.warnings, mediaWarning] }
          : formatted.validation,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
      setProgress(null);
    }
  }

  /** Copy the formatted rich text: ClipboardItem first, iframe selection as fallback. */
  async function copyToClipboard() {
    if (!canExportGzhResult(result)) return;
    // Only await when the Clipboard API exists, so the fallback otherwise runs inside the click itself.
    if (hasRichClipboard() && (await writeRichClipboard(result.html, () => buildGzhInput().markdown))) {
      setCopied("ok");
      return;
    }
    setCopied(copyFrameSelection(frameRef.current) ? "ok" : "fail");
  }

  function downloadHtml() {
    if (!canExportGzhResult(result)) return;
    const page = buildStandalonePreview(result.title, result.html, t.gzhCopyBtn, lang);
    downloadBlob(
      new Blob([page], { type: "text/html;charset=utf-8" }),
      `${sanitizeFileName(result.title)}_${result.themeName}.html`
    );
  }

  const isBusy = working || Boolean(globalBusy);
  const hasBlockingValidation = Boolean(result && !canExportGzhResult(result));
  const selectedTheme = themes.find((x) => x.id === themeId);

  return (
    <section className="gzh-panel">
      <div className="gzh-panel-row">
        <strong className="gzh-panel-title">{t.gzhPanelTitle}</strong>
        <label className="sr-only" htmlFor={themeSelectId}>
          {lang === "zh" ? "排版主题" : "Formatting theme"}
        </label>
        <select
          id={themeSelectId}
          className="styleselect compact"
          value={themeId}
          disabled={isBusy}
          onChange={(e) => setThemeId(e.target.value)}
        >
          {themes.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.name}
            </option>
          ))}
        </select>
        <button className="primary" disabled={isBusy || !paragraphs.length} onClick={() => void format()}>
          <Sparkle />
          {working ? t.gzhFormatting : t.gzhFormatBtn}
        </button>
        {result && (
          <>
            <button
              className="primary"
              disabled={hasBlockingValidation}
              title={hasBlockingValidation ? (lang === "zh" ? "请先解决阻断问题" : "Resolve blocking issues before copying") : undefined}
              onClick={() => void copyToClipboard()}
            >
              {t.gzhCopyBtn}
            </button>
            <button
              className="ghost"
              disabled={hasBlockingValidation}
              title={hasBlockingValidation ? (lang === "zh" ? "请先解决阻断问题" : "Resolve blocking issues before downloading") : undefined}
              onClick={downloadHtml}
            >
              {t.gzhDownloadBtn}
            </button>
          </>
        )}
      </div>
      {selectedTheme && !result && !working && <p className="hint gzh-scene">{selectedTheme.scene}</p>}
      {error && <div className="error topic-error" role="alert">{error}</div>}
      {working && progress && <ProgressBanner busy={t.gzhFormatting} progress={progress} lang={lang} />}
      {copied === "ok" && <div className="banner busy gzh-toast-ok" role="status">{t.gzhCopied}</div>}
      {copied === "fail" && <div className="error topic-error" role="alert">{t.gzhCopyFail}</div>}
      {result && (
        <>
          <GzhValidationReport validation={result.validation} t={t} />
          <iframe
            ref={frameRef}
            className="gzh-preview"
            title={t.gzhPanelTitle}
            sandbox="allow-same-origin"
            srcDoc={buildPreviewDoc(result.html, lang)}
          />
        </>
      )}
    </section>
  );
}

/** Validation status line plus the expandable list of blocking errors and warnings. */
function GzhValidationReport({ validation, t }: { validation: GzhFormatResponseDTO["validation"]; t: Dict }) {
  const level = validation.errors.length ? "bad" : validation.warnings.length ? "warn" : "ok";
  const summary = level === "bad"
    ? t.gzhValidationErr(validation.errors.length)
    : level === "warn"
      ? t.gzhValidationWarn(validation.warnings.length)
      : t.gzhValidationOk;
  return (
    <>
      <div className="gzh-result-bar">
        <span className={`gzh-validation ${level}`} role={level === "bad" ? "alert" : "status"}>
          {summary}
        </span>
        <span className="hint">{t.gzhPreviewNote}</span>
      </div>
      {level !== "ok" && (
        <details className="style-box gzh-issues">
          <summary>{summary}</summary>
          <ul>
            {validation.errors.map((e) => (
              <li key={e} className="gzh-issue-err">
                {e}
              </li>
            ))}
            {validation.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function missingMediaWarning(missingCount: number, lang: Lang): string | undefined {
  if (missingCount === 0) return undefined;
  return lang === "zh"
    ? `有 ${missingCount} 个来源素材未能恢复，已保留为待补素材。`
    : `${missingCount} source media item(s) could not be restored and remain placeholders.`;
}

function hasRichClipboard(): boolean {
  return typeof ClipboardItem !== "undefined" && Boolean(navigator.clipboard?.write);
}

async function writeRichClipboard(html: string, plainText: () => string): Promise<boolean> {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plainText()], { type: "text/plain" }),
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Legacy copy path: select `#gzh-content` inside the preview iframe and run execCommand. */
function copyFrameSelection(frame: HTMLIFrameElement | null): boolean {
  const doc = frame?.contentDocument;
  const win = frame?.contentWindow;
  const el = doc?.getElementById("gzh-content");
  if (!doc || !win || !el) return false;
  const range = doc.createRange();
  range.selectNodeContents(el);
  const sel = win.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  let ok = false;
  try {
    ok = doc.execCommand("copy");
  } catch {
    /* treated as a failed copy */
  }
  sel?.removeAllRanges();
  return ok;
}
