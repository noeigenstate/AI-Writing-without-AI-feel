import type { WritingSceneId } from "./api.js";
import type { Dict } from "./i18n.js";

/** Writing scenes in display order with their localized names. */
export function sceneOptions(t: Dict): { id: WritingSceneId; label: string }[] {
  return [
    { id: "general", label: t.sceneGeneral },
    { id: "wechat", label: t.sceneWechat },
    { id: "business", label: t.sceneBusiness },
    { id: "academic", label: t.sceneAcademic },
    { id: "official", label: t.sceneOfficial },
    { id: "social", label: t.sceneSocial },
    { id: "technical", label: t.sceneTechnical },
  ];
}
