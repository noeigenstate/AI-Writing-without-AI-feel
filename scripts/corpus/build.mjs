import fs from 'node:fs/promises';
import path from 'node:path';
import {DATA,json,writeJson,content,sourceUrl,han,hash,pruneTexts} from './common.mjs';
import {clean,sections,classical,garbled,Deduper,residue} from './text.mjs';
import {identity,simplified,authorName} from './identity.mjs';
import {rawIndex} from './raw-index.mjs';
const originalIndex=await rawIndex();
const candidates=await json(path.join(DATA,'cache/candidate-pages.json'));
const authors=await json(path.join(DATA,'author-evidence.json'));
try{for(const b of await json(path.join(DATA,'gutenberg-books.json')))if(!authors.some(a=>identity(a.author)===identity(b.author)))authors.push({author:b.author,author_original:b.author_original,death_year:b.death_year,death_year_source:b.source_url,death_year_evidence_file:b.death_evidence_file,death_year_evidence_sha256:b.death_evidence_sha256,evidence_type:'gutenberg-rdf'});}catch(e){if(e.code!=='ENOENT')throw e;}
// Rebuild the complete acquisition exclusion audit, including earlier resumed runs.
const authorPages=await json(path.join(DATA,'cache/author-pages.json')),authorSkips=[];
for(const p of authorPages){
 if(p.missing){authorSkips.push({title:p.title,reason:'No Wikisource author page; no verified death-year source'});continue;}
 if(authors.some(a=>a.author_page===p.title))continue;
 if(p.title==='Author:蔣中正'){authorSkips.push({title:p.title,reason:'Author page warns of ghostwritten texts; attribution uncertain'});continue;}
 const raw=content(p);let year=+(raw.match(/deathyear\s*=\s*(\d{4})/)?.[1]||raw.match(/(\d{4})年逝世/)?.[1]||raw.match(/\{\{(?:Author-PD|Not-PD-US-author)\s*\|\s*(\d{4})/i)?.[1]||0);
 if(!year)try{const parsed=await json(path.join(DATA,'cache/author-render-'+p.pageid+'.json'));year=+(parsed.parse.text.replace(/<[^>]*>/g,' ').match(/\d{4}年[—–－-](\d{4})年/)?.[1]||0);}catch(e){if(e.code!=='ENOENT')throw e;}
 authorSkips.push({title:p.title,death_year:year||null,source_url:sourceUrl(p),source_revision:p.revisions[0].revid,reason:year>1975?'Copyright: author died '+year:'Unknown/unverified death year'});
}
await writeJson(path.join(DATA,'fetch-skips.json'),authorSkips);
let overrides={};try{overrides=await json(path.join(DATA,'review.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
let bookRecords=[];try{bookRecords=await json(path.join(DATA,'book-downloads.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
const rows=[],skips=[],authorCount={},workCount={};
await fs.mkdir(path.join(DATA,'texts'),{recursive:true});
for(const c of candidates){
 const author=authors.find(a=>a.author===c.author);if(!author||author.death_year>1975)continue;
 const raw=content(c.page),header=raw.match(/\|\s*author\s*=\s*([^|}\n]+)/i)?.[1]?.trim();
 const reject=reason=>skips.push({author:c.author,title:c.title,reason});
 if(c.author==='林白水'){reject('Biographical metadata uncertainty: source birth year appears unreliable');continue;}
 if(/(?:編者按|编者按)[^\n]{0,30}(?:塗|涂|缺|佚|刪|删)/.test(raw)){reject('Editorial notice of missing/censored manuscript');continue;}
 if(/\{\|/.test(raw)){reject('Tabular source, unsuitable for prose corpus');continue;}
 if(['林紓','王國維','陳毅','陳寅恪','林覺民'].includes(c.author)){reject('Classical author scope or classical verse');continue;}
 const lines=raw.replace(/\{\{[\s\S]*?\}\}/g,'').split('\n').map(x=>x.trim()).filter(x=>han(x)>=3);
 const modernPoet=['戴望舒','劉半農','劉大白','王統照','徐志摩','廢名','聞一多'].includes(c.author);
 const isVerse=/\|\s*type\s*=\s*[^|\n]*(?:詩|诗|詞|词)/.test(raw)||(lines.length>8&&lines.filter(x=>han(x)<30).length/lines.length>0.8);
 if(isVerse&&!modernPoet){reject('Poetry/short-line verse excluded');continue;}
 if(overrides.exclude?.[c.title]){reject(overrides.exclude[c.title]);continue;}
 if(/\|\s*(?:translator|譯者|译者)\s*=\s*[^|}\s]/i.test(raw)||/\|\s*author2\s*=\s*[^|}\s]/i.test(raw)){reject('Translated or multiple-author work');continue;}
 if(header&&identity(header)!==identity(c.author)){reject('Header author mismatch: '+header);continue;}
 if(!header&&c.depth>0&&!c.title.startsWith(c.root+'/')){reject('No explicit author attribution on linked text');continue;}
 if(/\{\{\s*Collection header/i.test(raw)||/\|\s*type\s*=\s*[^\n|]*集/.test(raw)){reject('Collection index');continue;}
 if(/^\s*[*#].*\[\[/m.test(raw)&&raw.length<8000&&(raw.match(/\[\[/g)||[]).length>=4){reject('Index/list page');continue;}
 const result=clean(raw);
 if(result.unknown.length){reject('Unsupported markup: '+result.unknown.join(', '));continue;}
 for(const [i,piece]of sections(result.text).entries()){
  const n=han(piece.text);if(n<300||n>5000){reject('Length outside bounds: '+n);continue;}
  if(classical(piece.text)){reject('Classical register heuristic');continue;}
  if(garbled(piece.text)){reject('OCR garbling >1%');continue;}
  if(residue(piece.text)){reject('Placeholder/editorial/markup residue');continue;}
  // A collection is one work. All its chapters and constituent pieces share its cap.
  const work=overrides.work?.[c.title]||c.root;
  const wk=c.author+'\0'+work;
  const id='human-'+hash(c.author+'\0'+c.title+'\0'+i).slice(0,20);
  const text=piece.text+'\n';
  const book=bookRecords.find(b=>b.author===c.author&&b.work===c.root&&b.status==='downloaded');
  let genre=overrides.genre?.[c.title]||c.genre;
  if(isVerse)genre='现代诗';
  if(/^(?:小二黑結婚|都市風景線|生死場|呼蘭河傳|駱駝祥子|貓城記)/.test(c.root))genre='小说';
  if(c.author==='還珠樓主')genre='小说';
  if(c.author==='廢名'&&c.title==='長日 (廢名)')genre='小说';
  const type=raw.match(/\|\s*type\s*=\s*([^|\n}]+)/i)?.[1]||'';
  if(/小說|小说/.test(type)||/\{\{\s*novel\s*\|/i.test(raw))genre='小说';
  else if(/散文|隨筆|随笔/.test(type))genre='散文';
  if(c.title==='落花生')genre='童话/儿童文学'; // Children's autobiographical prose, not a fairy tale.
  if(/中國小說史略|中國小說的歷史的變遷|論短篇小說|叶圣陶的短篇小说|葉聖陶的短篇小說/.test(c.title))genre='评论/演讲';
  if(c.author==='朱自清'&&c.title==='說話')genre='散文';
  if(c.author==='蕭紅'){
   if(['小黑狗','广告副手','中秋节','烦扰的一日','蹲在洋车上','镀金的学说','祖父死了的时候','初冬','女子装饰的心理','感情的碎片','永久的憧憬和追求','天空的点缀','失眠之夜','一条铁路底完成','一九二九年底愚昧','记鹿地夫妇','我之读世界语','牙粉医病法','滑竿','茶食店','记我们的导师'].includes(c.title))genre='散文';
   if(['致X先生','给流亡异地的东北同胞书','“九一八”致弟弟书'].includes(c.title))genre='书信/日记';
   if(['《大地的女儿》与《动乱时代》','《大地的女儿》'].includes(c.title))genre='评论/演讲';
  }
  // Bibliographies defaulted to commentary. These are explicitly autobiographical/travel prose.
  if(['實庵自傳','多餘的话','漫遊的感想'].includes(c.title))genre='散文';
  // Admit letters by their printed salutation as well as bibliography metadata.
  if(/^(?:答|寄|與|与|獨秀同志來信|独秀同志来信)/.test(c.title)&&/^(?:[^\n]{1,20}(?:先生|學兄|学兄|兄|同志|足下|諸君|诸君)[：:！!]|[^\n]{1,15}同志們[：:])/m.test(result.text))genre='书信/日记';
  rows.push({id,author:authorName(c.author),author_original:c.author,author_death_year:author.death_year,work,piece_title:c.title+(piece.title?' / '+piece.title:''),genre,register:'vernacular',char_count:n,source:'wikisource',source_url:sourceUrl(c.page),source_revision:c.page.revisions[0].revid,book_file:book?.file||null,license_basis:'Public domain in China: author died '+author.death_year,sha256:hash(text),retrieved_at:c.page.retrieved_at,collection:c.root,section_index:i,script:simplified(text)===text?'simplified':'traditional',simplified_file:'texts-simplified/'+id+'.txt',composition_not_after:author.death_year+'-12-31',date_basis:'Original work by the named author; composition no later than verified author death year '+author.death_year,raw_file:'cache/pages/'+hash(c.title)+'.json',_text:text});
  authorCount[c.author]=(authorCount[c.author]||0)+1;workCount[wk]=(workCount[wk]||0)+1;
 }
}
// Keep diversity first when a larger acquisition yields more than the target.
let extra=[];try{extra=await json(path.join(DATA,'cache/extra-pieces.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
rows.push(...extra);
try{rows.push(...await json(path.join(DATA,'scan-pieces.json')));}catch(e){if(e.code!=='ENOENT')throw e;}
// A work's spelling does not create another quota (e.g. 老殘遊記 / 老残游记).
for(const r of rows){r.work_original=r.work;r.work=simplified(r.work);}
const capacity={};for(const r of rows)capacity[r.genre]=(capacity[r.genre]||0)+1;
console.log('ELIGIBLE BEFORE CAPS',JSON.stringify(capacity));
if(process.argv.includes('--capacity')){const cap={};for(const r of rows){const k=r.author+' / '+r.genre;cap[k]||={};cap[k][r.work]=(cap[k][r.work]||0)+1;}console.log(JSON.stringify(Object.fromEntries(Object.entries(cap).map(([k,v])=>[k,{cap:Math.min(60,Object.values(v).reduce((s,n)=>s+Math.min(n,10),0)),works:v}]))));process.exit(0);}
for(const r of rows)if(r.source==='wikisource'&&r.raw_file.startsWith('cache/pages/')){const c=candidates.find(c=>c.page.revisions?.[0]?.revid===r.source_revision&&sourceUrl(c.page)===r.source_url);const raw=c&&originalIndex.get(c.title+'\0'+r.source_revision);if(raw)Object.assign(r,raw);}
const selected=[],chosen=new Set(),dd=new Deduper(),ac={},wc={},gc={};
function take(r){const w=r.author+'\0'+r.work;if(chosen.has(r.id)||(ac[r.author]||0)>=60||(wc[w]||0)>=10||selected.length>=1000||r.genre==='评论/演讲'&&(gc[r.genre]||0)>=250)return false;const dup=dd.check(r._text,r.id);if(dup)return false;selected.push(r);chosen.add(r.id);ac[r.author]=(ac[r.author]||0)+1;wc[w]=(wc[w]||0)+1;gc[r.genre]=(gc[r.genre]||0)+1;return true;}
function rounds(pool,limit){const buckets=Object.values(Object.groupBy(pool,r=>r.author));let count=0;for(let i=0;count<limit;i++){let any=false;for(const b of buckets){if(i<b.length){any=true;if(count<limit&&take(b[i]))count++;}}if(!any)break;}return count;}
// Keep at least one eligible text by each author, then reserve literary quotas.
rounds(rows,80);
rounds(rows.filter(r=>r.genre==='小说'),Math.max(0,330-(gc['小说']||0)));
rounds(rows.filter(r=>['散文','杂文'].includes(r.genre)),Math.max(0,350-(gc['散文']||0)-(gc['杂文']||0)));
rounds(rows.filter(r=>r.genre==='书信/日记'),Math.max(0,35-(gc['书信/日记']||0)));
rounds(rows.filter(r=>r.genre==='童话/儿童文学'),Math.max(0,10-(gc['童话/儿童文学']||0)));
rounds(rows.filter(r=>r.genre!=='评论/演讲'),1000-selected.length);
rounds(rows,1000-selected.length);
await fs.mkdir(path.join(DATA,'texts-simplified'),{recursive:true});
for(const r of selected){const text=r._text;delete r._text;await fs.writeFile(path.join(DATA,'texts',r.id+'.txt'),text);const simple=simplified(text);r.simplified_sha256=hash(simple);await fs.writeFile(path.join(DATA,r.simplified_file),simple);}
await pruneTexts(DATA,selected,['texts','texts-simplified']);
await fs.writeFile(path.join(DATA,'manifest.jsonl'),selected.map(r=>JSON.stringify(r)).join('\n')+'\n');
const used=authors.filter(a=>selected.some(r=>r.author===authorName(a.author))).map(a=>({...a,author_original:a.author,author:authorName(a.author),piece_count:selected.filter(r=>r.author===authorName(a.author)).length}));await writeJson(path.join(DATA,'authors.json'),used);await writeJson(path.join(DATA,'build-skips.json'),skips);
const counts=key=>Object.fromEntries(Object.entries(Object.groupBy(selected,r=>r[key])).map(([k,v])=>[k,v.length]));
const report={pieces:selected.length,authors:used.length,works:new Set(selected.map(r=>r.author+'\0'+r.work)).size,works_with_book_file:new Set(selected.filter(r=>r.book_file).map(r=>r.author+'\0'+r.work)).size,by_author:counts('author'),by_genre:counts('genre'),by_source:counts('source'),skip_reasons:Object.fromEntries(Object.entries(Object.groupBy(skips,s=>s.reason.split(':')[0])).map(([k,v])=>[k,v.length]))};await writeJson(path.join(DATA,'summary.json'),report);
console.log(JSON.stringify(report,null,2));
