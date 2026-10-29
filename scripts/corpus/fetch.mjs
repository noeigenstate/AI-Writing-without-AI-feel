import fs from 'node:fs/promises';
import path from 'node:path';
import {DATA,pages,content,api,writeJson,links,sourceUrl,json} from './common.mjs';
import {names,supplementNames} from './catalog.mjs';
if(process.argv.includes('--books')){await import('./books.mjs');process.exit(0);}
const literary=process.argv.includes('--literary');
const poetryMode=process.argv.includes('--poetry');
const supplement=process.argv.includes('--supplement')||literary||poetryMode;
const records=supplement?await json(path.join(DATA,'author-evidence.json')):[],skipped=supplement?await json(path.join(DATA,'fetch-skips.json')):[];
const aps=await pages((poetryMode?['徐志摩','聞一多','戴望舒','劉半農','王統照','廢名']:literary?['吳趼人','李寶嘉','劉鶚 (清)','曾樸','韓邦慶','李涵秋','孫玉聲','陳蝶仙','陸士諤','吳沃堯','曹聚仁']:supplement?supplementNames:names).map(n=>'Author:'+n));
const oldAuthors=supplement?await json(path.join(DATA,'cache/author-pages.json')):[];
await writeJson(path.join(DATA,'cache/author-pages.json'),[...new Map([...oldAuthors,...aps].map(p=>[p.title,p])).values()]);
const evidenceYear=s=>+(s.match(/deathyear\s*=\s*(\d{4})/)?.[1]||s.match(/(\d{4})年逝世/)?.[1]||s.match(/\{\{(?:Author-PD|Not-PD-US-author)\s*\|\s*(\d{4})/i)?.[1]||0);
const roots=[];
const bad=/譯作|译作|翻譯|翻译|譯文|译文|译诗|譯詩|詩集|诗集|古詩|古诗|舊詩|旧诗|歌詞|歌词|古籍|輯录|輯錄|辑录|校勘|整理本|輯校|辑校/;
const poetry=/^(?:詩|诗|新詩|新诗|詩歌|诗歌|詞|词|歌曲|歌詞|歌词|譯詩|译诗)(?:集|作|選|选|詞|词)?$/;
for(const p of aps){
 if(p.missing){skipped.push({title:p.title,reason:'No Wikisource author page'});continue;}
 const s=content(p);let death=evidenceYear(s),birth=+(s.match(/birthyear\s*=\s*(\d{4})/)?.[1]||0),render;
 if(!death||!birth){render=await api({action:'parse',page:p.title,prop:'text|revid'});await writeJson(path.join(DATA,'cache/author-render-'+p.pageid+'.json'),render);const text=render.parse.text.replace(/<style\b[\s\S]*?<\/style>/g,'').replace(/<[^>]*>/g,' ');const m=text.match(/(\d{4})年[—–－-](\d{4})年/);birth||=+(m?.[1]||0);death||=+(m?.[2]||0);}
 if(!death||death>1975){skipped.push({title:p.title,reason:death?'Copyright: died '+death:'Unknown death year'});continue;}
 const author=p.title.replace(/^Author:/,'');
 // Chiang explicitly has attributed/ghostwritten texts: do not assume sole human author identity.
 if(author==='蔣中正'){skipped.push({title:p.title,reason:'Author page warns of ghostwritten texts; attribution uncertain'});continue;}
const rec={author,birth_year:birth||null,death_year:death,death_year_source:sourceUrl(p),death_year_revision:p.revisions[0].revid,death_year_evidence:death+'年',death_year_evidence_type:evidenceYear(s)?'wikitext':'rendered author header',death_year_evidence_file:render?'cache/author-render-'+p.pageid+'.json':null,author_page:p.title};if(!records.some(r=>r.author===author))records.push(rec);
 let heading='',n=0;
 for(const line of s.replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi,'').split('\n')){
  if(/^=/.test(line)){heading=line.replace(/=/g,'').trim();continue;}
  if(!/^\s*[*#《]/.test(line)||/譯|译|古詩|古诗|舊詩|旧诗/.test(line+heading)||(!poetryMode&&(bad.test(heading)||poetry.test(heading)||bad.test(line)||/新詩|新诗/.test(line))))continue;
  if(poetryMode&&!/詩|诗/.test(line+heading))continue;
  for(const title of links(line)){
   if(n>=200)break;
   roots.push({author,title,root:title,genre:poetryMode?'现代诗':literary&&author!=='曹聚仁'?'小说':/小說|小说/.test(line+heading)?'小说':/雜文|杂文/.test(line+heading)?'杂文':/童話|童话|兒童|儿童/.test(line+heading)?'童话/儿童文学':/書信|书信|日記|日记|函電|函电|函|致|給|给/.test(line+heading)?'书信/日记':/散文|隨筆|随笔|小品/.test(line+heading)?'散文':'评论/演讲',depth:0});n++;
  }
 }
 console.log('AUTHOR',author,death,n);
}
await writeJson(path.join(DATA,'author-evidence.json'),records);
let queue=[...new Map(roots.map(x=>[x.author+'\0'+x.title,x])).values()],all=supplement?await json(path.join(DATA,'cache/candidate-pages.json')):[],seen=new Set(all.map(c=>c.author+'\0'+c.page.pageid));
for(let depth=0;depth<3&&queue.length;depth++){
 console.log('FETCH LEVEL',depth,queue.length);const next=[];
 for(let offset=0;offset<queue.length;offset+=40){
  const batch=queue.slice(offset,offset+40);const ps=await pages(batch.map(x=>x.title));
  for(const p of ps){
   if(p.missing)continue;
   // Resolve Chinese title conversion and redirects using the query's mappings.
   let entry=batch.find(x=>x.title===p.title||p.requested_titles.includes(x.title));
   if(!entry)entry=batch.find(x=>x.title.replaceAll('_',' ')===p.title);
   if(!entry)continue;
   const key=entry.author+'\0'+p.pageid;if(seen.has(key))continue;seen.add(key);
   const raw=content(p);const record={...entry,title:p.title,page:p};all.push(record);
   const coll=/\{\{\s*Collection header/i.test(raw)||/\|\s*type\s*=\s*[^\n|]*(?:集|长篇|長篇)/.test(raw)||(/目錄|目录/.test(raw)&&links(raw).length>3)||(/^[*#].*\[\[/m.test(raw)&&raw.length<8000&&links(raw).length>=4);
   if(coll&&depth<2&&!/author2\s*=\s*[^\s|}]/.test(raw)){
    // Only list items in the body; header previous/next links are unrelated works.
    for(const line of raw.split('\n'))if(/^\s*[*#]/.test(line)&&!bad.test(line))for(let title of links(line)){
     if(title.startsWith('/'))title=p.title+title;
     next.push({...entry,title,root:entry.root,depth:depth+1});
    }
   }
  }
  await writeJson(path.join(DATA,'cache/candidate-pages.json'),all);
  console.log('PAGES',offset+batch.length,'/',queue.length,'saved',all.length);
 }
 queue=[...new Map(next.map(x=>[x.author+'\0'+x.title,x])).values()].filter(x=>!all.some(a=>a.author===x.author&&a.title===x.title));
}
await writeJson(path.join(DATA,'cache/candidate-pages.json'),all);await writeJson(path.join(DATA,'fetch-skips.json'),skipped);
console.log('FETCH COMPLETE',records.length,'verified authors;',all.length,'pages');
