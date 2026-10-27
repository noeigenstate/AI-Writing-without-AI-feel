import { useEffect, useId, useState } from "react";
import type { Lang } from "../../lib/i18n.js";

export type GifPlaybackState = "idle" | "playing" | "error";
export type GifPlaybackEvent = "toggle" | "error";
export const INITIAL_GIF_PLAYBACK_STATE: GifPlaybackState = "idle";

/** Keep GIF playback deterministic and never mount motion in reduced-motion mode. */
export function transitionGifPlayback(
  state: GifPlaybackState,
  event: GifPlaybackEvent,
  reducedMotion = false
): GifPlaybackState {
  if (event === "error") return "error";
  if (reducedMotion) return "idle";
  return state === "playing" ? "idle" : "playing";
}

export function shouldMountGifMedia(state: GifPlaybackState, reducedMotion = false): boolean {
  return state === "playing" && !reducedMotion;
}

/** What the reader currently sees: a failure, the mounted GIF, or the unloaded placeholder. */
type GifView = "idle" | "playing" | "error";

const GIF_COPY = {
  zh: {
    action: { idle: "播放 GIF", playing: "暂停 GIF", error: "重试 GIF" },
    state: { idle: "GIF，尚未加载", playing: "GIF，播放中", error: "GIF，加载失败" },
    badge: { idle: "GIF · 待播放", playing: "GIF · 播放中", error: "GIF · 失败" },
    idleTitle: "原始 GIF 尚未加载",
    idleMessage: "为避免自动播放，点击后才会加载真实来源动图。",
    reducedMotionMessage: "已按系统的减少动态效果设置不加载 GIF。",
    errorMessage: "GIF 加载失败，真实动图已卸载。你可以稍后重试。",
  },
  en: {
    action: { idle: "Play GIF", playing: "Pause GIF", error: "Retry GIF" },
    state: { idle: "GIF, not loaded", playing: "GIF, playing", error: "GIF, load failed" },
    badge: { idle: "GIF · READY", playing: "GIF · PLAYING", error: "GIF · ERROR" },
    idleTitle: "The original GIF has not been loaded",
    idleMessage: "To prevent autoplay, the genuine source GIF loads only after you choose Play.",
    reducedMotionMessage: "The GIF is not loaded because reduced motion is enabled.",
    errorMessage: "The GIF could not load and has been unloaded. You can try again.",
  },
} as const;

interface ControlledGifMediaProps {
  animatedSrc: string;
  alt: string;
  width: number;
  height: number;
  lang: Lang;
}

/** Consent-first GIF player: no image bytes are mounted until the reader chooses Play. */
export default function ControlledGifMedia({ animatedSrc, alt, width, height, lang }: ControlledGifMediaProps) {
  const [playback, setPlayback] = useState<GifPlaybackState>(INITIAL_GIF_PLAYBACK_STATE);
  const reducedMotion = usePrefersReducedMotion();
  const mediaId = useId();
  const descriptionId = useId();
  const statusId = useId();
  const isPlaying = shouldMountGifMedia(playback, reducedMotion);

  useEffect(() => {
    if (reducedMotion) setPlayback(INITIAL_GIF_PLAYBACK_STATE);
  }, [reducedMotion]);

  const copy = GIF_COPY[lang];
  const view: GifView = playback === "error" ? "error" : isPlaying ? "playing" : "idle";
  const describedBy = { error: `${descriptionId} ${statusId}`, playing: undefined, idle: descriptionId }[view];

  return (
    <>
      <div
        id={mediaId}
        className="doc-figure-media-gif"
        data-gif-state={reducedMotion ? "reduced" : playback}
      >
        <span className="doc-media-kind" aria-label={copy.state[view]} title={copy.state[view]}>
          {copy.badge[view]}
        </span>
        {isPlaying ? (
          <img
            className="doc-figure-source-image doc-figure-gif-animated"
            src={animatedSrc}
            alt={alt}
            width={width}
            height={height}
            decoding="async"
            onError={() => setPlayback((state) => transitionGifPlayback(state, "error"))}
          />
        ) : (
          <div id={descriptionId} className="doc-gif-idle">
            <strong>{copy.idleTitle}</strong>
            <span>{copy.idleMessage}</span>
            {reducedMotion && <span className="doc-gif-motion-note">{copy.reducedMotionMessage}</span>}
          </div>
        )}
        {!reducedMotion && (
          <button
            type="button"
            className="doc-gif-control"
            aria-controls={mediaId}
            aria-describedby={describedBy}
            aria-pressed={isPlaying}
            onClick={() => setPlayback((state) => transitionGifPlayback(state, "toggle"))}
          >
            <GifControlIcon playing={isPlaying} />
            <span>{copy.action[view]}</span>
          </button>
        )}
      </div>
      {playback === "error" && !reducedMotion && (
        <p id={statusId} className="doc-gif-status" role="status" aria-live="polite">
          {copy.errorMessage}
        </p>
      )}
    </>
  );
}

function GifControlIcon({ playing }: { playing: boolean }) {
  return (
    <svg className="doc-gif-control-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {playing ? (
        <path d="M3.5 2.5h3v11h-3zm6 0h3v11h-3z" />
      ) : (
        <path d="M4 2.4 13 8l-9 5.6z" />
      )}
    </svg>
  );
}

function reducedMotionQuery(): MediaQueryList | undefined {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
  return window.matchMedia("(prefers-reduced-motion: reduce)");
}

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(() => reducedMotionQuery()?.matches ?? false);

  useEffect(() => {
    const query = reducedMotionQuery();
    if (!query) return undefined;
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reducedMotion;
}
