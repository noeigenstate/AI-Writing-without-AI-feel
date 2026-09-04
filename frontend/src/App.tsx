import { useEffect, useState } from "react";
import { useStore } from "./lib/store.js";
import UploadPanel from "./components/upload/UploadPanel.js";
import ArticleGenerator from "./components/generate/ArticleGenerator.js";
import DocEditor from "./components/editor/DocEditor.js";
import ScoreBar from "./components/editor/ScoreBar.js";
import { ChatLogo, Sparkle, WordIcon } from "./components/common/icons.js";
import ProgressBanner from "./components/common/ProgressBanner.js";
import { messages } from "./lib/i18n.js";

/** Root component: sidebar navigation, gradient hero, and the active view. */
export default function App() {
  const { lang, step, mode, busy, progress, error, styleSummary, workspaces, reset, setMode, setLang } = useStore();
  const [generatorView, setGeneratorView] = useState<"setup" | "results">("setup");
  const t = messages[lang];
  const rewriteStep = mode === "rewrite" ? step : workspaces.rewrite.step;
  const generateStep = mode === "generate" ? step : workspaces.generate.step;
  const showUploadHero = step === "upload" && (mode === "rewrite" || generatorView === "setup");

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  useEffect(() => {
    if (generateStep !== "upload") setGeneratorView("setup");
  }, [generateStep]);

  function selectMode(next: "rewrite" | "generate") {
    setMode(next);
  }

  return (
    <div className="layout" data-mode={mode}>
      <aside className="sidebar">
        <div className="side-brand">
          <span className="logo">
            <ChatLogo />
          </span>
          <div className="brand-text">
            <strong>AI-Writing-without-AI-feel</strong>
          </div>
        </div>

        <nav className="side-nav" aria-label={t.navTools}>
          <span className="side-caption">{t.navTools}</span>
          <button
            className={`side-item${mode === "rewrite" ? " active" : ""}`}
            onClick={() => selectMode("rewrite")}
            aria-current={mode === "rewrite" ? "page" : undefined}
          >
            <span className="side-index" aria-hidden="true">01</span>
            <span className="side-icon">
              <WordIcon />
            </span>
            {t.modeRewrite}
          </button>
          <button
            className={`side-item${mode === "generate" ? " active" : ""}`}
            onClick={() => selectMode("generate")}
            aria-current={mode === "generate" ? "page" : undefined}
          >
            <span className="side-index" aria-hidden="true">02</span>
            <span className="side-icon">
              <Sparkle />
            </span>
            {t.modeGenerate}
          </button>
        </nav>

        <div className="side-foot">
          <span className="side-edition" aria-hidden="true">
            {lang === "zh" ? "编辑台 · 001" : "COPY DESK · 001"}
          </span>
          <button className="side-item side-lang" onClick={() => setLang(lang === "en" ? "zh" : "en")}>
            {t.langToggle}
          </button>
        </div>
      </aside>

      <div className="main-pane">
        <div className="workspace-folio" aria-hidden="true">
          <span>AIW—001</span>
          <span>
            {mode === "rewrite"
              ? (lang === "zh" ? "改写工作台" : "REWRITE DESK")
              : generatorView === "results"
                ? (lang === "zh" ? "标题提案台" : "TITLE DESK")
                : (lang === "zh" ? "写作工作台" : "WRITING DESK")}
          </span>
          <span>{lang === "zh" ? "字句清楚 · 依据可查" : "CLEAR COPY · VISIBLE SOURCES"}</span>
        </div>
        {showUploadHero ? (
          <header className="hero">
            <h1 className="hero-title">{mode === "rewrite" ? t.heroRewriteTitle : t.heroGenerateTitle}</h1>
            <p className="hero-sub">{mode === "rewrite" ? t.heroRewriteSub : t.heroGenerateSub}</p>
            {mode === "generate" && <p className="hero-proxy-hint">{t.researchProxyHint}</p>}
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
            <summary>{t.styleProfile}</summary>
            <pre>{styleSummary}</pre>
          </details>
        )}

        <main>
          {/* 两个工作区的编辑器都保持挂载、只用 hidden 切换显隐：卸载会丢掉
              公众号排版等组件本地状态，切回来时进行中的排版就被打断了 */}
          <section hidden={mode !== "rewrite"}>
            {rewriteStep === "upload" ? <UploadPanel /> : <DocEditor />}
          </section>
          <section hidden={mode !== "generate"}>
            {generateStep === "upload" ? <ArticleGenerator onViewChange={setGeneratorView} /> : <DocEditor />}
          </section>
        </main>

        {step === "ready" && <footer className="hint">{t.editorHint}</footer>}
      </div>
    </div>
  );
}
