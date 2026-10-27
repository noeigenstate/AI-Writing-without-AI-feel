import type { ReactNode } from "react";

type IconProps = {
  className?: string;
};

/** Shared 24×24 decorative SVG frame; every icon is hidden from assistive technology. */
function IconSvg({ className = "", children }: IconProps & { children: ReactNode }) {
  return (
    <svg className={`icon-img ${className}`.trim()} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export function CloudUp({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <path d="M4 16.5v2.25A1.25 1.25 0 0 0 5.25 20h13.5A1.25 1.25 0 0 0 20 18.75V16.5M12 4v11m0-11L7.75 8.25M12 4l4.25 4.25" />
    </IconSvg>
  );
}

export function Sparkle({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <path d="M12 2.75 13.55 8.45 19.25 10 13.55 11.55 12 17.25 10.45 11.55 4.75 10l5.7-1.55L12 2.75Z" />
      <path d="m18.5 15 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" />
    </IconSvg>
  );
}

export function WordIcon({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <path d="M6 2.75h8l4 4v14.5H6zM14 2.75v4h4M8.5 11l1.3 6 2.2-4.25L14.2 17l1.3-6" />
    </IconSvg>
  );
}

export function BookIcon({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <path d="M3.5 4.5c3.4 0 6 .8 8.5 2.6v12.4c-2.5-1.8-5.1-2.6-8.5-2.6zM20.5 4.5c-3.4 0-6 .8-8.5 2.6v12.4c2.5-1.8 5.1-2.6 8.5-2.6z" />
    </IconSvg>
  );
}

export function SamplesIcon({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <path d="M7.5 3.5h10v14h-10zM4.5 6.5v14h10M10 7.5h5M10 11h5M10 14.5h3" />
    </IconSvg>
  );
}

export function ArrowLeft({ className }: IconProps) {
  return (
    <IconSvg className={className}>
      <path d="M20 12H4M10 6l-6 6 6 6" />
    </IconSvg>
  );
}
