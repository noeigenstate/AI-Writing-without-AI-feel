import { create } from "zustand";
import {
  uploadFiles,
  rewriteDoc,
  exportDoc,
  fetchStyles,
  fetchArticleDomains,
  generateArticle,
  generateArticleFromTitle,
  generateNovel,
  diagnoseText,
  scoreText,
  type ArticleRenderBlockDTO,
  type ArticleLengthDTO,
  type ArticleDomainDTO,
  type AiScoreDTO,
  type DiagnosticReportDTO,
  type NovelGenerationInput,
  type ParagraphDTO,
  type ResearchBundleDTO,
  type StyleDTO,
  type TargetLength,
  type TopicOptionDTO,
  type WritingSceneId,
} from "./api.js";
import { getStoredLang, storeLang, messages, type Lang } from "./i18n.js";
import type { ProgressTask } from "./progress.js";

type Mode = "rewrite" | "generate" | "novel";
type Step = "upload" | "ready";

interface WorkspaceState {
  docId: string | null;
  styleSummary: string;
  paragraphs: ParagraphDTO[];
  renderBlocks: ArticleRenderBlockDTO[] | null;
  length: ArticleLengthDTO | null;
  titleIndex: number;
  step: Step;
  busy: string | null;
  progress: { task: ProgressTask; startedAt: number } | null;
  error: string | null;
  research: ResearchBundleDTO | null;
  aiScore: { before: AiScoreDTO; after: AiScoreDTO } | null;
  currentScore: AiScoreDTO | null;
  diagnosis: DiagnosticReportDTO | null;
}

/** The global app state plus the actions that mutate it (Zustand store shape). */
interface State {
  lang: Lang;
  docId: string | null;
  styleSummary: string;
  paragraphs: ParagraphDTO[];
  renderBlocks: ArticleRenderBlockDTO[] | null;
  length: ArticleLengthDTO | null;
  titleIndex: number;
  step: Step;
  mode: Mode;
  busy: string | null; // 加载提示文案
  progress: { task: ProgressTask; startedAt: number } | null;
  error: string | null;
  styles: StyleDTO[];
  articleDomains: ArticleDomainDTO[];
  research: ResearchBundleDTO | null;
  aiScore: { before: AiScoreDTO; after: AiScoreDTO } | null; // 改写前后对照
  currentScore: AiScoreDTO | null; // 当前文档（含手动编辑）的实时分
  diagnosis: DiagnosticReportDTO | null;
  workspaces: Record<Mode, WorkspaceState>;

  setLang: (lang: Lang) => void;
  recomputeScore: (mode?: Mode) => Promise<void>;
  diagnoseCurrent: () => Promise<void>;
  setMode: (mode: Mode) => void;
  setResearch: (research: ResearchBundleDTO | null, mode?: Mode) => void;
  loadStyles: () => Promise<void>;
  loadArticleDomains: () => Promise<void>;
  doUpload: (target: File, refs: File[], styleId: string, sceneId: WritingSceneId) => Promise<void>;
  doGenerateArticle: (
    domainId: string,
    customDomain: string,
    topic: TopicOptionDTO,
    styleId: string,
    sceneId: WritingSceneId,
    targetLength: TargetLength
  ) => Promise<void>;
  doGenerateArticleFromTitle: (title: string, styleId: string, sceneId: WritingSceneId, targetLength: TargetLength) => Promise<void>;
  doGenerateNovel: (input: NovelGenerationInput) => Promise<void>;
  doRewrite: () => Promise<void>;
  setSentence: (paraIndex: number, sentenceIdx: number, text: string) => void;
  setParagraph: (paraIndex: number, text: string) => void;
  doExport: () => Promise<void>;
  reset: () => void;
}

const emptyWorkspace = (): WorkspaceState => ({
  docId: null,
  styleSummary: "",
  paragraphs: [],
  renderBlocks: null,
  length: null,
  titleIndex: -1,
  step: "upload",
  busy: null,
  progress: null,
  error: null,
  research: null,
  aiScore: null,
  currentScore: null,
  diagnosis: null,
});

function workspaceFromState(s: State): WorkspaceState {
  return {
    docId: s.docId,
    styleSummary: s.styleSummary,
    paragraphs: s.paragraphs,
    renderBlocks: s.renderBlocks,
    length: s.length,
    titleIndex: s.titleIndex,
    step: s.step,
    busy: s.busy,
    progress: s.progress,
    error: s.error,
    research: s.research,
    aiScore: s.aiScore,
    currentScore: s.currentScore,
    diagnosis: s.diagnosis,
  };
}

/** The active workspace lives in the top-level fields; inactive ones live in `workspaces`. */
function workspaceOf(s: State, mode: Mode): WorkspaceState {
  return s.mode === mode ? workspaceFromState(s) : s.workspaces[mode];
}

function workspacePatch(s: State, mode: Mode, patch: Partial<WorkspaceState>) {
  const nextWorkspace = { ...workspaceOf(s, mode), ...patch };
  const workspaces = { ...s.workspaces, [mode]: nextWorkspace };
  return s.mode === mode ? { ...patch, workspaces } : { workspaces };
}

interface LoadedDocument {
  docId: string;
  styleSummary: string;
  titleIndex: number;
  paragraphs: ParagraphDTO[];
}

/** A freshly loaded document replaces the editor content and clears scores, diagnosis and busy state. */
function loadedDocumentPatch(
  doc: LoadedDocument,
  extras: { renderBlocks?: ArticleRenderBlockDTO[]; length?: ArticleLengthDTO; research?: ResearchBundleDTO } = {}
): Partial<WorkspaceState> {
  return {
    docId: doc.docId,
    styleSummary: doc.styleSummary,
    paragraphs: doc.paragraphs,
    renderBlocks: extras.renderBlocks ?? null,
    length: extras.length ?? null,
    titleIndex: doc.titleIndex,
    research: extras.research ?? null,
    aiScore: null,
    currentScore: null,
    diagnosis: null,
    step: "ready",
    busy: null,
    progress: null,
  };
}

function failurePatch(e: unknown): Partial<WorkspaceState> {
  return { error: (e as Error).message, busy: null, progress: null };
}

function documentText(paragraphs: ParagraphDTO[]): string {
  return paragraphs.map((p) => p.sentences.join("")).join("\n");
}

const rewriteWorkspace = emptyWorkspace();

/**
 * The single Zustand store backing the whole UI.
 *
 * Holds the current document/editor state and exposes async actions that call
 * the API client and update state (upload, generate, rewrite, score, export).
 */
export const useStore = create<State>((set, get) => {
  /** Shared flow for actions that load a new document into `mode`'s workspace and then score it. */
  async function loadDocument<T>(
    mode: Mode,
    pending: Partial<WorkspaceState>,
    request: () => Promise<T>,
    loaded: (response: T) => Partial<WorkspaceState>
  ): Promise<void> {
    set((s) => workspacePatch(s, mode, pending));
    try {
      const response = await request();
      set((s) => workspacePatch(s, mode, loaded(response)));
      void get().recomputeScore(mode);
    } catch (e) {
      set((s) => workspacePatch(s, mode, failurePatch(e)));
    }
  }

  return {
    lang: getStoredLang(),
    ...rewriteWorkspace,
    mode: "rewrite",
    styles: [],
    articleDomains: [],
    workspaces: {
      rewrite: rewriteWorkspace,
      generate: emptyWorkspace(),
      novel: emptyWorkspace(),
    },

    async recomputeScore(mode = get().mode) {
      const state = get();
      const { paragraphs, aiScore } = workspaceOf(state, mode);
      const text = documentText(paragraphs);
      if (!text.trim()) return set((s) => workspacePatch(s, mode, { aiScore: null, currentScore: null }));
      try {
        const nextScore = await scoreText(text, state.lang);
        set((s) => workspacePatch(s, mode, {
          aiScore: aiScore ? { before: aiScore.before, after: nextScore } : null,
          currentScore: nextScore,
        }));
      } catch {
        /* 评分失败不阻塞 */
      }
    },

    async diagnoseCurrent() {
      const { mode, paragraphs, lang } = get();
      const text = documentText(paragraphs);
      if (!text.trim()) return set((s) => workspacePatch(s, mode, { diagnosis: null }));
      set((s) => workspacePatch(s, mode, { error: null }));
      try {
        const diagnosis = await diagnoseText(text, lang);
        set((s) => workspacePatch(s, mode, { diagnosis, currentScore: diagnosis }));
      } catch (e) {
        set((s) => workspacePatch(s, mode, { error: (e as Error).message }));
      }
    },

    setLang(lang) {
      storeLang(lang);
      set({ lang });
      // 语言切换后重新拉取本地化的风格/领域列表
      void get().loadStyles();
      void get().loadArticleDomains();
    },

    setMode(mode) {
      set((s) => {
        if (s.mode === mode) return {};
        const workspaces = { ...s.workspaces, [s.mode]: workspaceFromState(s) };
        return {
          ...workspaces[mode],
          mode,
          workspaces,
        };
      });
    },

    setResearch(research, mode = get().mode) {
      set((s) => workspacePatch(s, mode, { research }));
    },

    async loadStyles() {
      set({ styles: await fetchStyles(get().lang) });
    },

    async loadArticleDomains() {
      set({ articleDomains: await fetchArticleDomains(get().lang) });
    },

    doUpload(target, refs, styleId, sceneId) {
      return loadDocument(
        get().mode,
        { busy: messages[get().lang].busyParsing, error: null },
        () => uploadFiles(target, refs, styleId, sceneId, get().lang),
        (r) => loadedDocumentPatch(r)
      );
    },

    doGenerateArticle(domainId, customDomain, topic, styleId, sceneId, targetLength) {
      return loadDocument(
        get().mode,
        { busy: messages[get().lang].busyGenerating, progress: startProgress("article"), error: null },
        () => generateArticle(domainId, customDomain, topic, styleId, sceneId, targetLength, get().lang),
        (r) => loadedDocumentPatch(r, { renderBlocks: r.renderBlocks, length: r.length, research: r.research })
      );
    },

    doGenerateArticleFromTitle(title, styleId, sceneId, targetLength) {
      return loadDocument(
        get().mode,
        { busy: messages[get().lang].busyMatching, progress: startProgress("articleFromTitle"), error: null },
        () => generateArticleFromTitle(title, styleId, sceneId, targetLength, get().lang),
        (r) => loadedDocumentPatch(r, { renderBlocks: r.renderBlocks, length: r.length, research: r.research })
      );
    },

    doGenerateNovel(input) {
      return loadDocument(
        "novel",
        { busy: messages[get().lang].busyNovel, progress: startProgress("novel"), error: null },
        () => generateNovel(input, get().lang),
        (r) => loadedDocumentPatch(r, { renderBlocks: r.renderBlocks, length: r.length })
      );
    },

    async doRewrite() {
      const { mode, docId } = get();
      if (!docId) return;
      set((s) => workspacePatch(s, mode, { busy: messages[get().lang].busyRewriting, progress: startProgress("rewrite"), error: null }));
      try {
        const r = await rewriteDoc(docId, get().lang);
        set((s) => workspacePatch(s, mode, {
          paragraphs: r.paragraphs,
          aiScore: r.score ?? null,
          currentScore: r.score?.after ?? workspaceOf(s, mode).currentScore,
          diagnosis: null,
          busy: null,
          progress: null,
        }));
      } catch (e) {
        set((s) => workspacePatch(s, mode, failurePatch(e)));
      }
    },

    setSentence(paraIndex, sentenceIdx, text) {
      const mode = get().mode;
      set((s) => workspacePatch(s, mode, {
        paragraphs: s.paragraphs.map((p) =>
          p.index === paraIndex
            ? { ...p, sentences: p.sentences.map((x, i) => (i === sentenceIdx ? text : x)) }
            : p
        ),
        diagnosis: null,
      }));
    },

    setParagraph(paraIndex, text) {
      const mode = get().mode;
      set((s) => workspacePatch(s, mode, {
        paragraphs: s.paragraphs.map((p) =>
          p.index === paraIndex ? { ...p, sentences: [text] } : p
        ),
        diagnosis: null,
      }));
    },

    async doExport() {
      const { mode, docId, paragraphs, lang } = get();
      if (!docId) return;
      set((s) => workspacePatch(s, mode, { busy: messages[get().lang].busyExporting, error: null }));
      try {
        // 只发回真正改动过的段落；未改动的段落不传，导出时原样保留（含段内字符级格式）
        const texts: Record<number, string> = {};
        for (const p of paragraphs) {
          const current = p.sentences.join("");
          if (current !== p.original) texts[p.index] = current;
        }
        await exportDoc(docId, texts, lang, mode === "novel" ? "novel.docx" : "rewritten.docx");
        set((s) => workspacePatch(s, mode, { busy: null }));
      } catch (e) {
        set((s) => workspacePatch(s, mode, { error: (e as Error).message, busy: null }));
      }
    },

    reset() {
      set((s) => {
        const nextWorkspace = emptyWorkspace();
        return {
          ...nextWorkspace,
          workspaces: { ...s.workspaces, [s.mode]: nextWorkspace },
        };
      });
    },
  };
});

function startProgress(task: ProgressTask): { task: ProgressTask; startedAt: number } {
  return { task, startedAt: Date.now() };
}
