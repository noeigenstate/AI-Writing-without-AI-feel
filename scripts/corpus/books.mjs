import fs from 'node:fs/promises';
import path from 'node:path';
import {DATA,json,writeJson,download,hash} from './common.mjs';
const rows=(await fs.readFile(path.join(DATA,'manifest.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
let records=[];try{records=await json(path.join(DATA,'book-downloads.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
const unique=[...new Map(rows.filter(r=>r.source==='wikisource'&&!r.book_file).map(r=>[(r.author_original||r.author)+'\0'+r.collection,{author:r.author_original||r.author,work:r.collection}])).values()];
const safe=s=>s.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,100);
let saveQueue=Promise.resolve();
async function one(i,w){
 if(records.some(r=>r.author===w.author&&r.work===w.work&&r.status==='downloaded'))return;
 const url='https://ws-export.wmcloud.org/tool/book.php?'+new URLSearchParams({lang:'zh',page:w.work,format:'epub'});
 let rec={...w,url};
 try{const d=await download(url,{binary:true});if(d.body.subarray(0,2).toString()!=='PK'||!d.content_type?.includes('epub'))throw Error('Invalid EPUB response');const file=path.posix.join('books',safe(w.author),safe(w.work)+'.epub');await fs.mkdir(path.dirname(path.join(DATA,file)),{recursive:true});await fs.writeFile(path.join(DATA,file),d.body);rec={...rec,status:'downloaded',file,retrieved_at:d.retrieved_at,sha256:hash(d.body),bytes:d.body.length};}
 catch(e){rec={...rec,status:'unavailable',error:e.message,retrieved_at:new Date().toISOString()};}
 records=records.filter(r=>!(r.author===w.author&&r.work===w.work));records.push(rec);saveQueue=saveQueue.then(()=>writeJson(path.join(DATA,'book-downloads.json'),records));await saveQueue;
 console.log('BOOK',i+1,'/',unique.length,rec.status,w.author,w.work,rec.bytes||rec.error);
}
// Small works first. Two independent workers avoid blocking the next small export
// whenever a large whole-book export takes longer; starts remain >=1.2s apart.
const candidates=await json(path.join(DATA,'cache/candidate-pages.json'));
const sizes=new Map();for(const c of candidates){const key=c.author+'\0'+c.root;sizes.set(key,(sizes.get(key)||0)+(c.page.revisions?.[0]?.slots?.main?.content?.length||0));}
const pending=unique.map((w,i)=>({w,i})).filter(({w})=>!records.some(r=>r.author===w.author&&r.work===w.work&&r.status==='downloaded')).sort((a,b)=>(sizes.get(a.w.author+'\0'+a.w.work)||0)-(sizes.get(b.w.author+'\0'+b.w.work)||0));
let cursor=0;async function worker(){while(cursor<pending.length){const {i,w}=pending[cursor++];await one(i,w);}}
await Promise.all([worker(),worker()]);
console.log('BOOKS COMPLETE',records.filter(r=>r.status==='downloaded').length);
