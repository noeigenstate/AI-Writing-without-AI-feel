/** Mode-specific illustrated vignette for the hero. Decorative only: every layer is a painted image set from CSS. */

export type SceneMode = "rewrite" | "generate" | "novel";

/** Paint layers, back to front. Which ones exist depends on the scene; missing ones simply have no image. */
const LAYERS = ["bg", "clouds-far", "clouds-near", "windmill", "kite", "smoke", "light", "grass"] as const;

export default function HeroScene({ mode }: { mode: SceneMode }) {
  return (
    <div className={`hero-art scene scene-${mode}`} aria-hidden="true" key={mode}>
      {LAYERS.map((layer) => (
        <span key={layer} className={`l l-${layer}`} />
      ))}
    </div>
  );
}
