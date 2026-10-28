import { useEffect, useState, type ReactNode } from "react";
import { useStore } from "../../lib/store.js";
import { CloudUp, SamplesIcon, WordIcon } from "../common/icons.js";
import { OptionSelect } from "../common/OptionControls.js";
import { messages } from "../../lib/i18n.js";
import { sceneOptions } from "../../lib/sceneOptions.js";
import type { WritingSceneId } from "../../lib/api.js";

/** "Rewrite Word" entry view: pick a docx + style/samples, then upload & parse. */
export default function UploadPanel() {
  const doUpload = useStore((s) => s.doUpload);
  const styles = useStore((s) => s.styles);
  const loadStyles = useStore((s) => s.loadStyles);
  const lang = useStore((s) => s.lang);
  const t = messages[lang];
  const [target, setTarget] = useState<File | null>(null);
  const [refs, setRefs] = useState<File[]>([]);
  const [styleId, setStyleId] = useState("");
  const [sceneId, setSceneId] = useState<WritingSceneId>("general");

  useEffect(() => {
    loadStyles();
  }, [loadStyles]);

  const picked = styles.find((s) => s.id === styleId);
  const scenes = sceneOptions(t).map((scene) => ({ ...scene, label: `${t.sceneLabel}: ${scene.label}` }));

  return (
    <div className="upload">
      <section className="step upload-source">
        <div className="step-head">
          <h2>
            <span className="badge peach">1</span>
            {t.uploadTitle}
          </h2>
        </div>
        <FilePill
          kind="word"
          icon={<WordIcon />}
          pickLabel={t.chooseFile}
          fileLabel={target ? target.name : t.noFileChosen}
          hasFile={Boolean(target)}
          accept=".docx"
          onFiles={(files) => setTarget(files?.[0] ?? null)}
        />
      </section>

      <section className="step upload-style">
        <div className="step-head">
          <h2>
            <span className="badge mint">2</span>
            {t.chooseStyleTitle}
          </h2>
        </div>
        <p className="hint">{t.styleHint}</p>

        <label className="sr-only" htmlFor="rewrite-style-select">
          {t.chooseStyleTitle}
        </label>
        <OptionSelect
          id="rewrite-style-select"
          className="styleselect"
          value={styleId}
          options={styles.map((s) => ({ id: s.id, label: s.name }))}
          emptyLabel={t.styleNone}
          onChange={setStyleId}
        />
        {picked && <p className="hint pick-desc">{picked.desc}</p>}

        <label className="sr-only" htmlFor="rewrite-scene-select">
          {t.sceneLabel}
        </label>
        <OptionSelect id="rewrite-scene-select" className="styleselect" value={sceneId} options={scenes} onChange={setSceneId} />

        <FilePill
          kind="txt"
          icon={<SamplesIcon />}
          pickLabel={t.uploadSamples}
          fileLabel={refs.length ? t.selectedSamples(refs.length) : t.noSamples}
          hasFile={refs.length > 0}
          accept=".docx,.txt"
          multiple
          onFiles={(files) => setRefs(Array.from(files ?? []))}
        />
      </section>

      <div className="row-end">
        <button
          className="cta"
          disabled={!target}
          onClick={() => target && doUpload(target, refs, styleId, sceneId)}
        >
          <CloudUp />
          {t.uploadAndParse}
        </button>
      </div>
    </div>
  );
}

interface FilePillProps {
  kind: "word" | "txt";
  icon: ReactNode;
  pickLabel: string;
  fileLabel: string;
  hasFile: boolean;
  accept: string;
  multiple?: boolean;
  onFiles: (files: FileList | null) => void;
}

/** A file input styled as a pill: type icon, pick label, chosen file name and upload glyph. */
function FilePill({ kind, icon, pickLabel, fileLabel, hasFile, accept, multiple, onFiles }: FilePillProps) {
  return (
    <label className="filepill">
      <span className={`ftype ${kind}`}>{icon}</span>
      <span className="fpick">{pickLabel}</span>
      <span className="fsep" />
      <span className={`fname${hasFile ? " has" : ""}`}>{fileLabel}</span>
      <span className="fcloud">
        <CloudUp />
      </span>
      <input type="file" accept={accept} multiple={multiple} onChange={(e) => onFiles(e.target.files)} />
    </label>
  );
}
