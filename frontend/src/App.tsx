import { useEffect, useState } from "react";
import { useStore } from "./lib/store.js";
import UploadPanel from "./components/upload/UploadPanel.js";
import ArticleGenerator, { type GeneratorView } from "./components/generate/ArticleGenerator.js";
import NovelGenerator from "./components/novel/NovelGenerator.js";
import DocEditor from "./components/editor/DocEditor.js";
import ScoreBar from "./components/editor/ScoreBar.js";
import { BookIcon, Sparkle, WordIcon } from "./components/common/icons.js";
import ProgressBanner from "./components/common/ProgressBanner.js";
import SidebarScene from "./components/common/scenery/SidebarScene.js";
import BackdropScene from "./components/common/scenery/BackdropScene.js";
import HeroScene from "./components/common/scenery/HeroScene.js";
import { messages, type Dict, type Lang } from "./lib/i18n.js";

type Mode = "rewrite" | "generate" | "novel";

const NAV_ITEMS = [
  { mode: "rewrite", index: "01", Icon: WordIcon, label: "modeRewrite" },
  { mode: "generate", index: "02", Icon: Sparkle, label: "modeGenerate" },
  { mode: "novel", index: "03", Icon: BookIcon, label: "modeNovel" },
] as const;

/** Root component: painted sidebar navigation, illustrated hero, and the active view. */
export default function App() {
  const { lang, step, mode, busy, progress, error, styleSummary, workspaces, reset, setMode, setLang } = useStore();
  const [generatorView, setGeneratorView] = useState<GeneratorView>("setup");
  const t = messages[lang];
  const rewriteStep = mode === "rewrite" ? step : workspaces.rewrite.step;
  const generateStep = mode === "generate" ? step : workspaces.generate.step;
  const novelStep = mode === "novel" ? step : workspaces.novel.step;
  const showUploadHero = step === "upload" && (mode !== "generate" || generatorView === "setup");
  const hero = heroCopy(t, mode);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  useEffect(() => {
    if (generateStep !== "upload") setGeneratorView("setup");
  }, [generateStep]);

  return (
    <div className="layout" data-mode={mode}>
      <aside className="sidebar">
        <SidebarScene />
        <div className="side-brand">
          <strong>AI写作</strong>
        </div>

        <nav className="side-nav" aria-label={t.navTools}>
          <span className="side-caption">{t.navTools}</span>
          {NAV_ITEMS.map(({ mode: itemMode, index, Icon, label }) => (
            <button
              key={itemMode}
              className={`side-item${mode === itemMode ? " active" : ""}`}
              onClick={() => setMode(itemMode)}
              aria-current={mode === itemMode ? "page" : undefined}
            >
              <span className="side-index" aria-hidden="true">{index}</span>
              <span className="side-icon">
                <Icon />
              </span>
              {t[label]}
            </button>
          ))}
        </nav>

        <div className="side-foot">
          <span className="side-edition" aria-hidden="true">
            {lang === "zh" ? "林边手帖 · 001" : "FIELD NOTES · 001"}
          </span>
          <button className="side-item side-lang" onClick={() => setLang(lang === "en" ? "zh" : "en")}>
            {t.langToggle}
          </button>
        </div>
      </aside>

      <div className={`main-pane${showUploadHero ? " has-hero" : ""}`}>
        <BackdropScene />
        <div className="workspace-folio" aria-hidden="true">
          <span>{lang === "zh" ? "晴 · 微风" : "SUNNY · LIGHT BREEZE"}</span>
          <span>{deskName(mode, generatorView, lang)}</span>
          <span>{deskMotto(mode, lang)}</span>
        </div>
        {showUploadHero ? (
          <header className="hero">
            <div className="hero-copy">
              <h1 className="hero-title">{hero.title}</h1>
              <p className="hero-sub">{hero.sub}</p>
              {mode === "generate" && <p className="hero-proxy-hint">{t.researchProxyHint}</p>}
            </div>
            <HeroScene mode={mode} />
          </header>
        ) : step !== "upload" ? (
          <header className="page-head">
            <h1>{t.editorTitle}</h1>
            <button className="ghost" onClick={reset}>
              {t.restart}
            </button>
          </header>
        ) : null}

        {error && <div className="error banner" role="alert">{error}</div>}
        {busy && progress ? (
          <ProgressBanner busy={busy} progress={progress} lang={lang} />
        ) : (
          busy && <div className="banner busy" role="status" aria-live="polite">{busy}</div>
        )}

        {step === "ready" && <ScoreBar />}

        {step === "ready" && styleSummary && (
          <details className="style-box">
            <summary>{mode === "novel" ? t.novelSettingsSummary : t.styleProfile}</summary>
            <pre>{styleSummary}</pre>
          </details>
        )}

        <main>
          {/* 三个工作区的编辑器都保持挂载、只用 hidden 切换显隐：卸载会丢掉
              公众号排版等组件本地状态，切回来时进行中的排版就被打断了 */}
          <section hidden={mode !== "rewrite"}>
            {rewriteStep === "upload" ? <UploadPanel /> : <DocEditor />}
          </section>
          <section hidden={mode !== "generate"}>
            {generateStep === "upload" ? <ArticleGenerator onViewChange={setGeneratorView} /> : <DocEditor />}
          </section>
          <section hidden={mode !== "novel"}>
            {novelStep === "upload" ? <NovelGenerator /> : <DocEditor />}
          </section>
        </main>

        {step === "ready" && <footer className="hint">{t.editorHint}</footer>}
      </div>
    </div>
  );
}

function heroCopy(t: Dict, mode: Mode): { title: string; sub: string } {
  if (mode === "rewrite") return { title: t.heroRewriteTitle, sub: t.heroRewriteSub };
  if (mode === "generate") return { title: t.heroGenerateTitle, sub: t.heroGenerateSub };
  return { title: t.heroNovelTitle, sub: t.heroNovelSub };
}

/** Decorative caption naming the current desk. */
function deskName(mode: Mode, generatorView: GeneratorView, lang: Lang): string {
  const zh = lang === "zh";
  if (mode === "rewrite") return zh ? "草坡改写台" : "MEADOW REWRITE DESK";
  if (mode === "novel") return zh ? "林间小说台" : "FOREST FICTION DESK";
  if (generatorView === "results") return zh ? "云端标题台" : "CLOUD TITLE DESK";
  return zh ? "晴空写作台" : "SUNNY WRITING DESK";
}

function deskMotto(mode: Mode, lang: Lang): string {
  if (mode === "novel") return lang === "zh" ? "人物可信 · 情节连贯" : "CONSISTENT VOICE · COHERENT PLOT";
  return lang === "zh" ? "字句清楚 · 依据可查" : "CLEAR COPY · VISIBLE SOURCES";
}
