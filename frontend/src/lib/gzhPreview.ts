/** Page shells for the 公众号 preview iframe and the downloadable standalone preview. */

/** Minimal same-origin preview shell; `#gzh-content` is what gets copied. */
export function buildPreviewDoc(html: string, lang: "en" | "zh"): string {
  return [
    `<!DOCTYPE html><html lang="${lang === "zh" ? "zh-CN" : "en"}"><head><meta charset="utf-8">`,
    "<style>body{margin:0;background:#eef0f2;padding:18px 10px;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;}",
    "#gzh-stage{max-width:640px;margin:0 auto;}</style></head><body>",
    `<div id="gzh-stage"><div id="gzh-content">${html}</div></div>`,
    "</body></html>",
  ].join("");
}

/**
 * Standalone downloadable preview page with a copy-to-clipboard toolbar
 * (ported from gzh-design-skill's wrap_preview template).
 */
export function buildStandalonePreview(title: string, html: string, copyLabel: string, lang: "en" | "zh"): string {
  return `<!DOCTYPE html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · 公众号排版预览</title>
<style>
  body{margin:0;background:#eef0f2;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;}
  .gzh-toolbar{position:fixed;top:0;left:0;right:0;height:54px;background:#fff;box-shadow:0 1px 10px rgba(0,0,0,.08);display:flex;align-items:center;justify-content:space-between;padding:0 16px;z-index:99;}
  .gzh-hint{font-size:13px;color:#6b7280;}
  .gzh-copy{background:#07C160;color:#fff;border:0;border-radius:9px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;}
  .gzh-toast{position:fixed;top:66px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;padding:11px 20px;border-radius:10px;font-size:14px;opacity:0;pointer-events:none;transition:opacity .25s;z-index:100;}
  .gzh-toast.show{opacity:1;}
  .gzh-stage{max-width:700px;margin:78px auto 64px;padding:0 8px;}
</style>
</head>
<body>
<div class="gzh-toolbar">
  <span class="gzh-hint">排版预览 · 点击右侧按钮复制，随后粘贴到公众号编辑器</span>
  <button class="gzh-copy" onclick="gzhCopy(this)">${escapeHtml(copyLabel)}</button>
</div>
<div class="gzh-toast" id="gzhToast" aria-live="polite" aria-atomic="true"></div>
<div class="gzh-stage"><div id="gzh-content">
${html}
</div></div>
<script>
function gzhCopy(btn){
  var el=document.getElementById('gzh-content');
  var range=document.createRange();range.selectNodeContents(el);
  var sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);
  var ok=false;try{ok=document.execCommand('copy');}catch(e){}
  sel.removeAllRanges();
  var t=document.getElementById('gzhToast');
  t.setAttribute('role',ok?'status':'alert');
  t.setAttribute('aria-live',ok?'polite':'assertive');
  t.textContent=ok?'已复制。请在公众号编辑器中按 Ctrl/⌘+V 粘贴。':'复制失败，请手动全选内容后复制。';
  t.classList.add('show');setTimeout(function(){t.classList.remove('show');},2800);
}
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function sanitizeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "article";
}
