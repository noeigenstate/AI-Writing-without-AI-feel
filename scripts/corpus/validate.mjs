import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT,json,writeJson,han,hash,content} from './common.mjs';
import {subset,CUTOFF} from './sources.mjs';
import {simplified,identity} from './identity.mjs';
import {classical,garbled,Deduper,residue} from './text.mjs';
import {spawnSync} from 'node:child_process';
const names=['human-zh','human-zh-open','human-zh-gov'];
const defaultRoot=path.join(ROOT,'data/corpus');
const dataRoot=path.resolve(process.argv.find(a=>a.startsWith('--data-root='))?.slice(12)||defaultRoot);
if(dataRoot!==defaultRoot&&!dataRoot.startsWith(defaultRoot+path.sep))throw Error('Validation fixture root must remain inside data/corpus');
const requested=process.argv.find(a=>a.startsWith('--subset='))?.slice(9);
if(requested&&!names.includes(requested))throw Error('Unknown subset '+requested);
const deduper=new Deduper(),ids=new Set(),summaries=[],memo=new Map();
const counts=(rows,fn)=>Object.fromEntries(Object.entries(Object.groupBy(rows,fn)).map(([k,v])=>[k,v.length]));
const before=d=>{if(typeof d!=='string'||!/^(?:18|19|20)\d\d(?:-\d\d(?:-\d\d(?:T.*)?)?)?$/.test(d)||!Number.isFinite(Date.parse(d))||Date.parse(d)>=Date.parse('2021-01-01T00:00:00Z'))return false;if(d.length>=10){const [y,m,day]=d.slice(0,10).split('-').map(Number);if(new Date(Date.UTC(y,m-1,day)).toISOString().slice(0,10)!==d.slice(0,10))return false;}return true;};
async function bytes(dir,file){if(typeof file!=='string')throw Error('Missing file path');const p=path.resolve(dir,file);if(!p.startsWith(dir+path.sep))throw Error('Unsafe file path');if(!memo.has(p))memo.set(p,await fs.readFile(p));return memo.get(p);}
for(const name of requested?[requested]:names){
 const dir=path.join(dataRoot,name),errors=[],fail=s=>errors.push(s);let rows=[],authors=[];
 try{rows=(await fs.readFile(path.join(dir,'manifest.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){fail('Cannot read manifest: '+e.message);}
 const target=name==='human-zh'?1000:name==='human-zh-open'?600:300;
 if(rows.length!==target)fail(`Expected ${target} pieces, got ${rows.length}`);
 for(const folder of name==='human-zh'?['texts','texts-simplified']:['texts'])try{const files=(await fs.readdir(path.join(dir,folder))).filter(f=>f.endsWith('.txt')),expected=new Set(rows.map(r=>r.id+'.txt'));if(files.length!==rows.length||files.some(f=>!expected.has(f)))fail(folder+': file inventory differs from manifest (stale or unlisted text)');}catch(e){fail(folder+': '+e.message);}
 if(name==='human-zh')try{authors=await json(path.join(dir,'authors.json'));}catch{fail('Missing authors.json');}
 let authorPages=[];if(name==='human-zh')authorPages=await json(path.join(dir,'cache/author-pages.json'));
 for(const r of rows){
  const id=r.id||'<missing id>',check=(condition,s)=>{if(!condition)fail(id+': '+s);};
  for(const k of ['id','piece_title','genre','char_count','source','source_url','sha256','retrieved_at','raw_file','date_basis'])check(r[k]!=null&&r[k]!=='','missing '+k);
  check(new RegExp('^'+(name==='human-zh'?'human':name==='human-zh-open'?'open':'gov')+'-[a-f0-9]{20}$').test(id),'invalid ID');
  check(!ids.has(id),'duplicate ID across manifests');ids.add(id);check(Number.isFinite(Date.parse(r.retrieved_at)),'invalid retrieval timestamp');
  let text;try{text=(await bytes(dir,'texts/'+id+'.txt')).toString('utf8');}catch(e){fail(id+': '+e.message);continue;}
  check(hash(text)===r.sha256,'SHA-256 mismatch');const n=han(text);check(n===r.char_count&&n>=300&&n<=5000,'Han count/bounds: '+n);
  check(!residue(text),'markup/entity/invisible/placeholder/page-number/editorial residue');check(!garbled(text),'garbled text');
  const dup=deduper.check(text,name+'/'+id);if(dup)fail(id+': duplicate/near-duplicate of '+dup.other+' ('+dup.kind+')');
  const ds=['published_at','revision_timestamp','issued_at','composition_not_after','date_not_after','effective_at'].filter(k=>r[k]!=null);
  check(ds.length>0,'missing composition/publication/revision date');for(const k of ds)check(before(r[k]),'date not strictly before 2021 or invalid: '+k+'='+r[k]);
  let raw;try{raw=await bytes(dir,r.raw_file);check(raw.length>0,'empty original download');if(r.raw_sha256)check(hash(raw)===r.raw_sha256,'original download hash mismatch');}catch(e){fail(id+': original download '+e.message);}
  let url;try{url=new URL(r.source_url);check(url.protocol==='https:','source must use HTTPS');}catch{check(false,'invalid source URL');}
  if(name==='human-zh'){
   for(const k of ['author','author_original','author_death_year','work','register','license_basis','script','simplified_file'])check(r[k]!=null,'missing '+k);
   check(Number.isInteger(r.author_death_year)&&r.author_death_year>=1800&&r.author_death_year<=1975,'ineligible death year');
   check(r.author===simplified(r.author),'author name not simplified');check(r.register==='vernacular'&&!classical(text),'not vernacular');
   const a=authors.find(a=>a.author===r.author);check(a&&a.death_year===r.author_death_year,'missing/inconsistent author evidence');
   if(a)try{
    if(a.evidence_type==='gutenberg-rdf'){
     const ev=await bytes(dir,a.death_year_evidence_file);check(hash(ev)===a.death_year_evidence_sha256,'Gutenberg death evidence hash');
     const creator=ev.toString().match(/<dcterms:creator>[\s\S]*?<\/dcterms:creator>/)?.[0]||'';check(+creator.match(/<pgterms:deathdate[^>]*>(\d{4})</)?.[1]===a.death_year,'Gutenberg death evidence mismatch');
    }else{
     const p=authorPages.find(p=>p.title===a.author_page);check(p?.revisions?.[0]?.revid===a.death_year_revision,'author revision mismatch');
     let year=+(content(p).match(/deathyear\s*=\s*(\d{4})/i)?.[1]||content(p).match(/(\d{4})年逝世/)?.[1]||content(p).match(/\{\{(?:Author-PD|Not-PD-US-author)\s*\|\s*(\d{4})/i)?.[1]||0);
     if(!year){const rendered=await json(path.join(dir,'cache/author-render-'+p.pageid+'.json'));check(rendered.parse.revid===a.death_year_revision,'rendered author revision mismatch');year=+(rendered.parse.text.replace(/<[^>]*>/g,' ').match(/\d{4}年[—–－-](\d{4})年/)?.[1]||0);}
     check(year===a.death_year,'verified death year mismatch');
    }
   }catch(e){fail(id+': author evidence '+e.message);}
   check(r.script===(simplified(text)===text?'simplified':'traditional'),'script mismatch');
   try{const s=(await bytes(dir,r.simplified_file)).toString('utf8');check(s===simplified(text),'simplified copy differs from OpenCC');check(han(s)>=300&&han(s)<=5000,'simplified copy length bounds');check(!residue(s),'simplified text residue');check(hash(s)===r.simplified_sha256,'simplified SHA-256 mismatch');}catch(e){fail(id+': simplified copy '+e.message);}
   const hosts={wikisource:['zh.wikisource.org'],gutenberg:['www.gutenberg.org','gutenberg.org'],archive:['archive.org']};check(hosts[r.source]?.includes(url?.hostname),'unapproved PD source');
   if(r.source==='wikisource')check(Number.isInteger(r.source_revision)&&r.source_revision>0,'missing source revision');
   if(r.source==='wikisource'&&raw)try{const j=JSON.parse(raw.toString()),title=decodeURIComponent(url.pathname.replace('/wiki/',''));check(j.parse?j.parse.revid===r.source_revision&&j.parse.title===title:j.query?.pages?.some(p=>p.title===title&&p.revisions?.some(v=>v.revid===r.source_revision)),'PD original revision/title mismatch');}catch{check(false,'invalid PD raw response');}
   if(r.book_file)try{const b=await bytes(dir,r.book_file);check(r.book_file.startsWith('books/')&&b.length>0,'invalid book file');if(r.book_file.endsWith('.epub'))check(b.subarray(0,2).toString()==='PK','invalid EPUB');}catch{check(false,'missing original book');}
  }else if(name==='human-zh-open'){
   check(r.script==='simplified'&&text===simplified(text),'open text not simplified');check(r.license&&r.license.name&&/^https:\/\/creativecommons\.org\/licenses\//.test(r.license.url),'licence name/URL required');check(typeof r.attribution==='string'&&r.attribution.includes('https://'),'missing attribution');
   if(['wikipedia','wikinews'].includes(r.source)){
    check(r.snapshot_cutoff===CUTOFF&&before(r.revision_timestamp),'invalid revision cutoff');check(url?.hostname==='zh.'+r.source+'.org'&&Number.isInteger(r.source_revision),'wrong Wikimedia provenance');
    if(raw)try{const j=JSON.parse(raw.toString()),p=j.query.pages.find(p=>p.title===r.work),rev=p?.revisions?.[0];check(rev?.revid===r.source_revision&&rev?.timestamp===r.revision_timestamp,'raw snapshot revision mismatch');const meta=JSON.parse((await bytes(dir,r.raw_file+'.meta.json')).toString()),u=new URL(meta.url);check(meta.sha256===r.raw_sha256&&u.searchParams.get('rvstart')===CUTOFF&&u.searchParams.get('rvdir')==='older'&&u.searchParams.get('rvlimit')==='1','raw API request does not establish cutoff revision');}catch{check(false,'invalid raw snapshot');}
    if(r.source==='wikinews')check(before(r.published_at),'news publication date missing');
   }else if(r.source==='hc3'){
    check(['finance','psychology'].includes(r.hc3_subset),'unverified HC3 subset');check(Number.isInteger(r.dataset_row)&&Number.isInteger(r.answer_index),'missing HC3 coordinates');
    if(raw)try{const row=JSON.parse(raw.toString().trim().split('\n')[r.dataset_row]),answer=row.human_answers[r.answer_index],expected=simplified(answer).replace(/<br\s*\/?\s*>/gi,'\n').replace(/\r/g,'').replace(/[\u200B-\u200F\uFEFF]/g,'').trim()+'\n';check(text===expected,'not the recorded HC3 human answer');}catch{check(false,'invalid HC3 human answer');}
    check(r.date_evidence_files?.length>=2&&before(r.date_not_after),'missing HC3 upstream date evidence');for(const f of r.date_evidence_files||[])try{await bytes(dir,f);}catch{check(false,'missing HC3 date evidence file');}
    if(r.hc3_subset==='psychology'){const proof=await json(path.join(dir,'psychology-date-proof.json'));check(JSON.stringify(proof.matches[r.dataset_row+':'+r.answer_index])===JSON.stringify(r.upstream_answer_proof),'psychology answer date proof mismatch');check(r.date_not_after===proof.commit_timestamp,'psychology source date mismatch');}
   }else check(false,'unapproved open source');
  }else{
   check(r.script==='simplified'&&text===simplified(text),'government text not simplified');check(typeof r.issuer==='string'&&r.issuer.length>0,'missing issuer');check(before(r.issued_at),'invalid issue date');check(r.license_basis==='不适用著作权法：《著作权法》第五条','invalid copyright basis');check(url&&/(^|\.)gov\.cn$/.test(url.hostname),'not an official government source');
  }
 }
 const byAuthor=counts(rows,r=>r.author||r.issuer||r.source),byGenre=counts(rows,r=>r.genre),bySource=counts(rows,r=>r.hc3_subset?'hc3/'+r.hc3_subset:r.source),byYear=counts(rows,r=>(r.published_at||r.issued_at||r.revision_timestamp||r.composition_not_after||'unknown').slice(0,4)),byWork=counts(rows,r=>identity(r.author||r.issuer||'')+' / '+simplified(r.work));
 if(name==='human-zh'){
  const canonical=counts(rows,r=>identity(r.author));if(Object.keys(canonical).length<40)fail('Need >=40 authors');for(const [a,n]of Object.entries(canonical))if(n>60)fail(a+': author cap >60');for(const [w,n]of Object.entries(byWork))if(n>10)fail(w+': work cap >10');for(const a of authors)if(a.piece_count!==byAuthor[a.author])fail(a.author+': authors.json count mismatch');
  if((byGenre['评论/演讲']||0)>rows.length*.25)fail('Commentary/speeches exceed 25%');if((byGenre['小说']||0)<rows.length*.30)fail('Fiction below 30%');if((byGenre['散文']||0)+(byGenre['杂文']||0)<rows.length*.30)fail('Prose/essays below 30%');if((byGenre['现代诗']||0)>rows.length*.10)fail('Poetry above 10%');for(const g of ['小说','散文','杂文','评论/演讲','书信/日记','童话/儿童文学'])if(!byGenre[g])fail('Missing genre '+g);
 }
 if(name==='human-zh-open')for(const s of ['wikinews','wikipedia','hc3'])if(rows.filter(r=>r.source===s).length!==200)fail('Expected 200 pieces from '+s);
 if(name==='human-zh-open'&&rows.some(r=>r.hc3_subset==='psychology')){const proof=spawnSync(process.env.PYTHON||'python',[path.join(ROOT,'scripts/corpus/verify-psychology.py'),'--check'],{encoding:'utf8',windowsHide:true});if(proof.status!==0)fail('Independent psychology original-date verification failed: '+(proof.stderr||proof.error||proof.stdout));}
 if(name==='human-zh-gov')for(const c of ['government_report','law_regulation','state_ministry_document'])if(rows.filter(r=>r.category===c).length!==100)fail('Expected 100 pieces in '+c);
 const summary={subset:name,status:errors.length?'FAIL':'PASS',pieces:rows.length,manifest_sha256:rows.length?hash(await fs.readFile(path.join(dir,'manifest.jsonl'))):null,authors_or_issuers:Object.keys(byAuthor).length,works:Object.keys(byWork).length,han_characters:rows.reduce((s,r)=>s+r.char_count,0),max_per_author_or_issuer:Math.max(0,...Object.values(byAuthor)),max_per_work:Math.max(0,...Object.values(byWork)),genres:byGenre,sources:bySource,years:byYear,errors:errors.length};
 await fs.mkdir(dir,{recursive:true});await writeJson(path.join(dir,'validation-summary.json'),summary);await writeJson(path.join(dir,'validation-errors.json'),errors);await writeJson(path.join(dir,'counts.json'),{by_author_or_issuer:byAuthor,by_source:bySource,by_genre:byGenre,by_year:byYear,by_work:byWork,year_basis:name==='human-zh'?'Composition upper bound (author death year), not publication year':'Recorded source publication, revision or issue year'});
 console.log(JSON.stringify(summary,null,2));for(const e of errors.slice(0,20))console.error('FAIL '+name+': '+e);summaries.push(summary);
}
await writeJson(path.join(dataRoot,'validation-summary.json'),summaries);process.exitCode=summaries.some(s=>s.status!=='PASS')?1:0;
