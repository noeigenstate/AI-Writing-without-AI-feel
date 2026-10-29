import path from 'node:path';
import {subset,wiki,CUTOFF} from './sources.mjs';
import {json,writeJson,han,content} from './common.mjs';
import {wikiSections} from './prose.mjs';
import {residue} from './text.mjs';
const dir=subset('human-zh-open');
let rows=[];try{rows=await json(path.join(dir,'wikinews-pages.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
const memo=new Map(rows.map(p=>[p.title,p]));
const skips=[];
function eligible(p){const r=content(p);return !!p.revisions?.length&&/\{\{date\s*\|\s*20\d\d[年/-]\d{1,2}[月/-]\d{1,2}/i.test(r)&&!/(?:報紙頭條|报纸头条)/.test(p.title)&&wikiSections(r).some(s=>han(s.text)>=300&&han(s.text)<=5000&&!residue(s.text));}
let good=rows.filter(eligible).length;
for(let offset=0;good<220&&offset<1500;offset+=500){
 const {result}=await wiki(dir,'zh.wikinews.org',{action:'query',list:'search',srsearch:'creationdate:<2021-01-01 -intitle:頭條 -intitle:头条 -intitle:簡訊 -intitle:简讯',srnamespace:'0',srlimit:'500',sroffset:String(offset),srprop:'size|wordcount'});
 const found=result.query.search.filter(p=>p.size>=1800&&!/頭條|头条|簡訊|简讯/.test(p.title));console.log('NEWS SEARCH',offset,found.length,'eligible cached',good);
 let cursor=0,saveQueue=Promise.resolve();
 async function worker(){while(cursor<found.length&&good<220){const {title}=found[cursor++];if(memo.has(title))continue;
 try{const {result,raw}=await wiki(dir,'zh.wikinews.org',{action:'query',titles:title,prop:'revisions',rvprop:'ids|timestamp|content',rvslots:'main',rvstart:CUTOFF,rvdir:'older',rvlimit:'1'});
 for(const p of result.query.pages){const rec={...p,raw_file:raw.file,raw_sha256:raw.sha256,retrieved_at:raw.retrieved_at};memo.set(p.title,rec);if(eligible(rec))good++;}
 saveQueue=saveQueue.then(()=>writeJson(path.join(dir,'wikinews-pages.json'),[...memo.values()]));await saveQueue;if(memo.size%10===0)console.log('NEWS',memo.size,'eligible',good);
 }catch(e){skips.push({title,reason:e.message});console.log('NEWS SKIP',title,e.message);}
 }}
 await Promise.all([worker(),worker()]);
 if(!result.continue)break;
}
console.log('NEWS COMPLETE',memo.size,'eligible',good);
await writeJson(path.join(dir,'news-fetch-skips.json'),skips);
