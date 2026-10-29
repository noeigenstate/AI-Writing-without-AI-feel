import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const DATA=path.join(ROOT,'data/corpus/human-zh');
export const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
export const han=s=>(s.match(/\p{Script=Han}/gu)||[]).length;
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const json=async p=>JSON.parse(await fs.readFile(p,'utf8'));
export async function writeJson(p,o){await fs.mkdir(path.dirname(p),{recursive:true});const tmp=p+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(o,null,2)+'\n');await fs.rename(tmp,p);}
export async function pruneTexts(dir,rows,folders=['texts']){const ids=new Set(rows.map(r=>r.id));for(const folder of folders){if(!['texts','texts-simplified'].includes(folder))throw Error('Unsafe text folder');const target=path.join(dir,folder);for(const file of await fs.readdir(target)){const m=file.match(/^((?:human|open|gov)-[a-f0-9]{20})\.txt$/);if(m&&!ids.has(m[1]))await fs.unlink(path.join(target,file));}}}
const clocks=new Map();
export async function download(url,{binary=false}={}){
 const u=new URL(url);if(!['zh.wikisource.org','zh.wikinews.org','zh.wikipedia.org','ws-export.wmcloud.org','www.gutenberg.org','gutenberg.org','archive.org','huggingface.co','raw.githubusercontent.com','api.github.com','arxiv.org','aistudio.baidu.com','aistudio-fe-online.cdn.bcebos.com','www.heywhale.com'].includes(u.hostname)&&!/(^|\.)gov\.cn$/.test(u.hostname))throw Error('Unapproved source '+u.hostname);
 const p=path.join(DATA,'cache',hash(url)+(binary?'.bin':'.json'));
 try {const meta=await json(p+'.meta');const bytes=await fs.readFile(p);if(hash(bytes)!==meta.sha256)throw Error('Cache digest mismatch');return {body:binary?bytes:bytes.toString('utf8'),...meta};}catch(e){if(e.code!=='ENOENT')throw e;}
 await fs.mkdir(path.dirname(p),{recursive:true});
 const wikiRequest=['zh.wikisource.org','zh.wikipedia.org','zh.wikinews.org'].includes(u.hostname)&&u.pathname==='/w/api.php';
 const attempts=wikiRequest?3:5;
 for(let attempt=0;attempt<attempts;attempt++){
  const slot=Math.max(Date.now(),(clocks.get(u.hostname)||0)+1200);clocks.set(u.hostname,slot);await sleep(Math.max(0,slot-Date.now()));
  try {
   let response=await fetch(url,{headers:{'User-Agent':'SpeakPlainlyHumanCorpus/2.0 (pre-2021 Chinese human-text evaluation; read-only; cached; <=1 request/second)'},signal:AbortSignal.timeout(wikiRequest?25000:90000),redirect:'manual'});
   for(let redirect=0;response.status>=300&&response.status<400&&redirect<4;redirect++){
    const next=new URL(response.headers.get('location'),response.url);
    if(next.protocol==='http:'&&['www.gutenberg.org','gutenberg.org','archive.org','www.gov.cn'].includes(next.hostname))next.protocol='https:';
    if(next.protocol!=='https:'||next.hostname!==u.hostname&&!['zh.wikisource.org','www.gutenberg.org','gutenberg.org','archive.org','www.gov.cn'].includes(next.hostname)&&!next.hostname.endsWith('.archive.org')||/\/(?:login|captcha|passport)(?:\/|\?|$)/i.test(next.pathname))throw Error('Unapproved redirect '+next.hostname);
    const slot=Math.max(Date.now(),(clocks.get(next.hostname)||0)+1200);clocks.set(next.hostname,slot);await sleep(Math.max(0,slot-Date.now()));
    response=await fetch(next,{headers:{'User-Agent':'SpeakPlainlyHumanCorpus/2.0 (read-only; cached Chinese evaluation corpus; <=1 request/second)'},signal:AbortSignal.timeout(90000),redirect:'manual'});
   }
   if(response.status===429||response.status>=500){await sleep(Math.min(45000,Math.max(Number(response.headers.get('retry-after'))*1000||0,2000*2**attempt)));continue;}
   if(!response.ok)throw Error(`HTTP ${response.status}: ${url}`);
   const bytes=Buffer.from(await response.arrayBuffer());
   if(!binary||['zh.wikisource.org','zh.wikipedia.org','zh.wikinews.org'].includes(u.hostname)&&u.pathname==='/w/api.php'){const data=JSON.parse(bytes.toString('utf8'));if(data.error){if(data.error.code==='maxlag'){await sleep(5000*2**attempt);continue;}throw Error('API '+JSON.stringify(data.error));}}
   const meta={url,retrieved_at:new Date().toISOString(),sha256:hash(bytes),content_type:response.headers.get('content-type')};
   await fs.writeFile(p,bytes);await writeJson(p+'.meta',meta);return{body:binary?bytes:bytes.toString('utf8'),...meta};
  }catch(e){if(attempt===attempts-1||/HTTP 4|Unapproved|API/.test(e.message))throw e;await sleep(2000*2**attempt);}
 }
 throw Error('Retry limit: '+url);
}
export async function api(params){const u=new URL('https://zh.wikisource.org/w/api.php');for(const [k,v]of Object.entries({format:'json',formatversion:'2',maxlag:'5',...params}))u.searchParams.set(k,v);const d=await download(u.href);return{...JSON.parse(d.body),retrieved_at:d.retrieved_at};}
let pageMemo;
export async function pages(titles){
 if(!pageMemo){pageMemo=new Map();for(const file of ['cache/author-pages.json','cache/candidate-pages.json'])try{for(const x of await json(path.join(DATA,file))){const p=x.page||x;for(const title of [p.title,...(p.requested_titles||[])])pageMemo.set(title,p);}}catch(e){if(e.code!=='ENOENT')throw e;}}
 const out=[],pending=[];
 for(const title of [...new Set(titles)]){let p=pageMemo.get(title);if(!p)try{p=await json(path.join(DATA,'cache/pages',hash(title)+'.json'));}catch(e){if(e.code!=='ENOENT')throw e;}if(p){pageMemo.set(title,p);out.push(p);}else pending.push(title);}
 for(let i=0;i<pending.length;i+=40){const batch=pending.slice(i,i+40);const r=await api({action:'query',titles:batch.join('|'),redirects:'1',converttitles:'1',prop:'revisions',rvprop:'ids|content',rvslots:'main'});const mappings=[...(r.query.normalized||[]),...(r.query.converted||[]),...(r.query.redirects||[])];const resolve=t=>{for(let n=0;n<10;n++){const m=mappings.find(m=>m.from===t);if(!m)break;t=m.to;}return t;};for(const p of r.query.pages){const obj={...p,requested_titles:batch.filter(t=>resolve(t)===p.title),retrieved_at:r.retrieved_at};for(const title of [p.title,...obj.requested_titles]){pageMemo.set(title,obj);await writeJson(path.join(DATA,'cache/pages',hash(title)+'.json'),obj);}out.push(obj);}}
 return [...new Map(out.map(p=>[p.title,p])).values()];
}
export const content=p=>p?.revisions?.[0]?.slots?.main?.content||'';
export const sourceUrl=p=>'https://zh.wikisource.org/wiki/'+encodeURIComponent(p.title);
export function links(s){return [...s.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map(m=>m[1].trim()).filter(t=>!t.includes(':')&&!/^(首頁|首页|維基|维基)/.test(t));}
