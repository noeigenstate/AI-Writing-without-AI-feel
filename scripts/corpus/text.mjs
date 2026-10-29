import {han,hash} from './common.mjs';
import {simplified} from './identity.mjs';
export const normalized=s=>simplified(s).normalize('NFKC').replace(/[^\p{L}\p{N}]/gu,'').toLowerCase();
export const residue=s=>/\{\{|\}\}|\[\[|\]\]|<\/?[a-z][^>]*>|&(?:#\d+|#x[0-9a-f]+|[a-z]+);|[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]|原字未收[錄录][於于]Unicode|[異异][體体]字字典[編编][碼码]|(?:編者|编者)[按註注]|^\s*(?:第\s*\d+\s*[頁页]|[-—]\s*\d{1,4}\s*[-—]|\d{1,4})\s*$/imu.test(s);
export function classical(s){const n=han(s);const old=(s.match(/[之乎者也矣焉]/g)||[]).length/n;const modern=(s.match(/[的了是我你他她們们嗎吗呢著着這这說说]/g)||[]).length/n;return old>=0.04||modern<0.025||(old>=0.02&&modern<0.035);}
export function garbled(s){return (s.match(/[\uFFFD\uE000-\uF8FF□〓▯]/gu)||[]).length/Math.max(1,han(s))>0.01;}
const metadata=/^(?:header|collection header|author|textquality|pd(?:\/.*)?|pd-old.*|license.*|not-pd-us.*|wikipedia|維基百科|维基百科|wikisource|reflist|references|authority control|defaultsort|clear|nop|page break|pagebreak|rule|centered rule|separator|導航|导航|章節|章节|nav.*|vte|版本信息|版本資訊|footer|正體化|正体化|傳統漢字|傳統漢字化|簡轉繁|简转繁|s2t|t2s|-|!|PD-ROC-exempt)$/i;
const spacing=/^(?:gap|em|indent|space|spaces|blank|br|clear|smallgap|大間隔|间隔)$/i;
export function clean(raw){
 let unknown=[];
 let s=raw.replace(/<!--[\s\S]*?-->/g,'').replace(/<ref\b[^>]*>[\s\S]*?<\/ref\s*>/gi,'').replace(/<ref\b[^>]*\/\s*>/gi,'').replace(/<references\b[^>]*(?:\/>|>[\s\S]*?<\/references>)/gi,'');
 s=s.replace(/^={2,}\s*(?:注釋|注释|註釋|註解|注解|編者註|编者注|校注|參考資料|参考资料|参考文献|參考文獻)\s*={2,}[\s\S]*$/m,'');
 s=s.replace(/-\{H\|[\s\S]*?\}-/g,'').replace(/-\{([^{}]*)\}-/g,'$1');
 // Parse balanced templates so metadata removal does not leak nested header text.
 function expand(text){let out='';for(let i=0;i<text.length;){if(text.slice(i,i+2)!=='{{'){out+=text[i++];continue;}let d=1,j=i+2;for(;j<text.length&&d;j++){if(text.slice(j,j+2)==='{{'){d++;j++;}else if(text.slice(j,j+2)==='}}'){d--;j++;}}if(d){unknown.push('unbalanced-template');break;}const body=text.slice(i+2,j-2);let parts=[],start=0,depth=0;for(let k=0;k<body.length;k++){if(body.slice(k,k+2)==='{{'||body.slice(k,k+2)==='[['){depth++;k++;}else if(body.slice(k,k+2)==='}}'||body.slice(k,k+2)===']]'){depth--;k++;}else if(body[k]==='|'&&!depth){parts.push(body.slice(start,k));start=k+1;}}parts.push(body.slice(start));const name=parts.shift().trim();if(name==='*'){}else if(['YL','\u53c3','\u6821','\u53e6'].includes(name)){out+=expand(parts[0]||'');}else if(name==='\u5c08'){out+=expand(parts.join(''));}else if(spacing.test(name))out+=' ';else if(metadata.test(name)||/^(?:header2|novel|novel-f)$/i.test(name))out+='\n';else if(/^(?:right|left|楷体|楷體|署名|zh-em|Zh-em|center|c|small|smaller|larger|large|big|bold|italic|nowrap|block center|quote|blockquote|inset|左右|置中|居中|字體|字体|大小|雙行註|双行注)$/i.test(name)){out+=expand(parts.filter(p=>!/^\w+\s*=/.test(p)).join(''));}else if(/^(?:lang|language)$/i.test(name)){out+=expand(parts.slice(1).join('|'));}else if(/^(?:ruby|注音)$/i.test(name)){out+=expand(parts[0]||'');}else if(/^(?:\\*|注|註|note|ref|footnote|sidenote|margin note|譯註|译注)$/i.test(name)){/* editorial notes excluded */}else{unknown.push(name);}
 i=j;}return out;}
 // These templates are page classification/navigation, never author prose.
 s=s.replace(/\{\{(?:清朝作品|清朝作者|Further|Other versions|Versions)(?=[|}\s])[^{}]*\}\}/gi,'');
 s=expand(s);
 if(/<pages\b|\{\{\s*:/.test(raw))unknown.push('transclusion');
 s=s.replace(/\[\[(?:Category|分类|分類|File|Image|文件|檔案|图像|圖像):[^\]]*\]\]/gi,'').replace(/\[\[([^\]|]*\|)?([^\]]+)\]\]/g,(_,prefix,label)=>label).replace(/\[https?:\/\/[^\s\]]+(?:\s+([^\]]*))?\]/g,'$1');
 s=s.replace(/<\/?(?:p|div|blockquote|poem|section|br)\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/'{2,5}/g,'');
 s=s.replace(/&nbsp;|&#160;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):+n));
 s=s.split('\n').filter(l=>!/^\s*(?:[*#]\s*\[|\{\||\|}|\|-|\|\+|__\w+__)/.test(l)).map(l=>l.replace(/^\s*[:;]+\s*/,'').replace(/^[ \t\u3000]+|[ \t\u3000]+$/g,'')).join('\n');
 s=s.replace(/[\u200B-\u200F\uFEFF]/g,'').replace(/\r/g,'');
 s=s.replace(/[①-⑳]|\[(?:\d{1,3})\]|[〔［]\d{1,3}[〕］]/g,'');
 s=s.replace(/[（(](?:編者按|编者按|編者注|编者注|編者註|原載於|原载于|選自|选自)[^）)\n]*[）)]/g,'');
 s=s.split('\n').filter(l=>!/^\s*(?:[—－-]+\s*)?(?:選自|选自|摘自|原載於|原载于|原載|原载)[《“「（(]/.test(l)).join('\n');
 // Every source paragraph remains intact. Single newlines separate source paragraphs.
 s=s.split(/\n+/).filter(Boolean).join('\n\n').trim();
 if(/[{}]|\[\[|\]\]|-{\||&[a-z]+;/.test(s))unknown.push('residual-markup');
 return{text:s,unknown:[...new Set(unknown)]};
}
export function sections(text){
 text=text.replace(/^(?:[ \t]*)([一二三四五六七八九十百〇○零]+|[（(][一二三四五六七八九十0-9]+[）)]|第[一二三四五六七八九十百0-9]+[章節节回部篇])\s*$/gm,'== $1 ==');
 if(han(text)<=5000)return[{title:'',text:text.replace(/^={2,}\s*(.*?)\s*={2,}$/gm,'$1')}];
 // Split exclusively at explicit chapter/section headings; never arbitrary paragraph windows.
 const blocks=text.split(/\n\n(?=={2,}[^\n]+={2,}(?:\n|$))/),out=[];
 for(const block of blocks){const m=block.match(/^={2,}\s*(.*?)\s*={2,}\s*(?:\n\n|$)/);const body=(m?block.slice(m[0].length):block).trim();if(body)out.push({title:m?.[1]||'',text:body});}return out;
}
export function grams(s){const t=normalized(s),set=new Set();for(let i=0;i<=t.length-5;i++){let h=2166136261;for(let k=0;k<5;k++)h=Math.imul(h^t.charCodeAt(i+k),16777619);set.add(h>>>0);}return set;}
export class Deduper{
 constructor(){this.hashes=new Map();this.index=new Map();this.sizes=[];this.ids=[];}
 check(text,id,{add=true}={}){const n=normalized(text),digest=hash(n);if(this.hashes.has(digest))return{other:this.hashes.get(digest),kind:'normalized-hash'};const g=grams(text),counts=new Map();for(const gram of g)for(const j of this.index.get(gram)||[])counts.set(j,(counts.get(j)||0)+1);for(const [j,count]of counts){const smaller=Math.min(g.size,this.sizes[j]);if(count>=100&&(count/smaller>=0.9||count/(g.size+this.sizes[j]-count)>=0.8))return{other:this.ids[j],kind:'5-gram-high-overlap',overlap:count/smaller};}if(add){const j=this.ids.length;this.hashes.set(digest,id);this.ids.push(id);this.sizes.push(g.size);for(const gram of g){let a=this.index.get(gram);if(!a)this.index.set(gram,a=[]);a.push(j);}}return null;}
}
