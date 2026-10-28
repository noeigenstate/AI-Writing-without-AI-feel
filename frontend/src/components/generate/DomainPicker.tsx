import type { ArticleDomainDTO } from "../../lib/api.js";
import { messages, type Lang } from "../../lib/i18n.js";

interface DomainPickerProps {
  lang: Lang;
  domains: ArticleDomainDTO[];
  domainId: string;
  customDomain: string;
  onSelect: (domainId: string) => void;
  onCustomDomainChange: (value: string) => void;
}

/** Numbered domain cards plus a trailing "custom" card that reveals a free-text domain input. */
export default function DomainPicker({
  lang,
  domains,
  domainId,
  customDomain,
  onSelect,
  onCustomDomainChange,
}: DomainPickerProps) {
  const t = messages[lang];
  return (
    <>
      <div
        className="domain-grid"
        role="group"
        aria-label={lang === "zh" ? "文章领域" : "Article domain"}
      >
        {domains.map((d, index) => (
          <button
            key={d.id}
            type="button"
            className={`domain-card${domainId === d.id ? " active" : ""}`}
            aria-pressed={domainId === d.id}
            onClick={() => {
              onSelect(d.id);
            }}
          >
            <span className="domain-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <span className="domain-name">{d.name}</span>
            <small>{d.desc}</small>
          </button>
        ))}
        <button
          type="button"
          className={`domain-card custom${domainId === "custom" ? " active" : ""}`}
          aria-pressed={domainId === "custom"}
          onClick={() => {
            onSelect("custom");
          }}
        >
          <span className="domain-index" aria-hidden="true">{String(domains.length + 1).padStart(2, "0")}</span>
          <span className="domain-name">{t.customDomain}</span>
          <small>{t.customDomainDesc}</small>
        </button>
      </div>
      {domainId === "custom" && (
        <>
          <label className="sr-only" htmlFor="custom-domain-input">
            {t.customDomain}
          </label>
          <input
            id="custom-domain-input"
            className="text-input"
            value={customDomain}
            onChange={(e) => onCustomDomainChange(e.target.value)}
            placeholder={t.customDomainPlaceholder}
          />
        </>
      )}
    </>
  );
}
