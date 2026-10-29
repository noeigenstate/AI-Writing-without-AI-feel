import fs from 'node:fs/promises';
import path from 'node:path';
import {subset,CUTOFF} from './sources.mjs';
import {json,writeJson,hash,han,content,pruneTexts} from './common.mjs';
import {wikiSections} from './prose.mjs';
import {simplified} from './identity.mjs';
import {Deduper,residue} from './text.mjs';
const dir=subset('human-zh-open'),candidates=[],skips=[];
const licenses={wikinews:{name:'Creative Commons Attribution 2.5 Generic (CC BY 2.5)',url:'https://creativecommons.org/licenses/by/2.5/'},wikipedia:{name:'Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0)',url:'https://creativecommons.org/licenses/by-sa/3.0/'},hc3:{name:'Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)',url:'https://creativecommons.org/licenses/by-sa/4.0/'}};
for(const source of ['wikipedia','wikinews']){
 const ps=await json(path.join(dir,source+'-pages.json'));
 for(const p of ps){
 const revision=p.revisions?.[0],raw=content(p);if(!revision||revision.timestamp>CUTOFF||/^#(?:REDIRECT|重定向|重新導向)/i.test(raw)){skips.push({source,title:p.title,reason:'No pre-cutoff revision, missing page or redirect'});continue;}
 let published_at=null;
 if(source==='wikinews'){
  const d=raw.match(/\{\{(?:date|日期)\s*\|\s*(20\d\d)[年/-](\d{1,2})[月/-](\d{1,2})日?/i)||raw.match(/\{\{(?:date|日期)\s*\|\s*(20\d\d)\s*\|\s*(\d{1,2})\s*\|\s*(\d{1,2})/i);
  if(d)published_at=d[1]+'-'+d[2].padStart(2,'0')+'-'+d[3].padStart(2,'0');
  if(!published_at||published_at>='2021-01-01'||/\{\{(?:develop|copyvio|delete|版权|版權)/i.test(raw)){skips.push({source,title:p.title,reason:'No verified pre-2021 article publication date or unpublished/disputed'});continue;}
 }
 const sections=wikiSections(raw);
 if(source==='wikipedia'&&sections.reduce((s,p)=>s+han(p.text),0)<1000){skips.push({source,title:p.title,reason:'Stub/insufficient running prose'});continue;}
 for(const [i,s]of sections.entries()){
 const text=simplified(s.text).trim()+'\n',n=han(text);if(n<300||n>5000||residue(text)){skips.push({source,title:p.title,section:s.title,reason:'Bounds/residue'});continue;}
 const id='open-'+hash(source+'\0'+p.title+'\0'+revision.revid+'\0'+i).slice(0,20),url='https://zh.'+source+'.org/w/index.php?oldid='+revision.revid;
 candidates.push({id,source,topic:p.topic||'news',genre:source==='wikinews'?'新闻':'百科说明文',work:p.title,piece_title:p.title+' / '+s.title,source_url:url,source_revision:revision.revid,revision_timestamp:revision.timestamp,...(published_at?{published_at}:{}),snapshot_cutoff:CUTOFF,date_basis:'MediaWiki revision current at '+CUTOFF+' (rvstart, rvdir=older, rvlimit=1)'+(published_at?'; article date template in that revision':''),license:licenses[source],attribution:p.title+' — Chinese '+source+' contributors; '+url+'; history: https://zh.'+source+'.org/w/index.php?title='+encodeURIComponent(p.title)+'&action=history',raw_file:p.raw_file,raw_sha256:p.raw_sha256,retrieved_at:p.retrieved_at,char_count:n,sha256:hash(text),script:'simplified',section_index:i,_text:text});
 }
 }
}
const rights=await json(path.join(dir,'hc3-rights-download.json')),origin=await json(path.join(dir,'upstream-openqa-download.json')),finance=await json(path.join(dir,'finance-metadata-download.json'));
const financeMeta=JSON.parse(await fs.readFile(path.join(dir,finance.file),'utf8'));
const psychologyProof=await json(path.join(dir,'psychology-date-proof.json'));
const psychologyOrigin=await json(path.join(dir,'psychology-2020-download.json'));
const psychologyCommit=await json(path.join(dir,'psychology-2020-commits-download.json'));
const psychologyLicense=await json(path.join(dir,'psychology-license-download.json'));
if(financeMeta.UpdateDate>='2021-01-01'||!financeMeta.metaInformation.some(x=>x.Key==='License'&&x.Value.Link.includes('/by/4.0/')))throw Error('Finance origin date/licence evidence changed; review needed');
for(const split of ['open_qa','finance','psychology']){
 const download=await json(path.join(dir,split+'-download.json'));
 const lines=(await fs.readFile(path.join(dir,download.file),'utf8')).trim().split('\n');
 for(const [lineIndex,line]of lines.entries()){
 const r=JSON.parse(line);
 // Only human_answers is accessed. Generated-answer fields are never candidates.
 for(const [answerIndex,answer]of (r.human_answers||[]).entries()){
 if(typeof answer!=='string'){skips.push({source:'hc3',split,line:lineIndex,answer:answerIndex,reason:'Missing/non-string human answer'});continue;}
 if(split==='psychology'&&!psychologyProof.matches[lineIndex+':'+answerIndex]){skips.push({source:'hc3',split,line:lineIndex,answer:answerIndex,reason:'No exact match in dated May 2020 original'});continue;}
 const text=simplified(answer).replace(/<br\s*\/?\s*>/gi,'\n').replace(/\r/g,'').replace(/[\u200B-\u200F\uFEFF]/g,'').trim()+'\n',n=han(text);
 if(n<300||n>5000||residue(text)){skips.push({source:'hc3',split,line:lineIndex,answer:answerIndex,reason:'Bounds/residue'});continue;}
 const id='open-'+hash('hc3\0'+split+'\0'+lineIndex+'\0'+answerIndex).slice(0,20),source_url=download.url;
 const row={id,source:'hc3',hc3_subset:split,genre:'问答',topic:split,work:'HC3-Chinese/'+split,piece_title:r.question,source_url,license:licenses.hc3,upstream_license:split==='finance'?{name:'CC BY 4.0',url:'https://creativecommons.org/licenses/by/4.0/'}:{name:'MIT License',url:'https://github.com/brightmart/nlp_chinese_corpus/blob/master/LICENSE'},attribution:'Guo et al. (2023), How Close is ChatGPT to Human Experts? HC3, arXiv:2301.07597; Hello-SimpleAI/HC3-Chinese, '+split+', row '+lineIndex+', human_answers['+answerIndex+']; '+source_url,published_at:split==='finance'?financeMeta.PublishDate:'2019',date_basis:split==='finance'?'HC3 paper Appendix A.1 identifies FinanceZhidao; upstream public metadata CreateDate='+financeMeta.CreateDate+', final UpdateDate='+financeMeta.UpdateDate+' (before cutoff). This dates the underlying human data, not HC3 packaging.':'HC3 paper Appendix A.1 identifies WebTextQA/BaikeQA; upstream nlp_chinese_corpus documents webtext2019zh data from 2015–2016 and baike2018qa updated in 2018, released/cited in 2019. This is a dataset-level upper bound, not an exact answer date.',date_evidence_files:[rights.file,split==='finance'?finance.file:origin.file],date_not_after:split==='finance'?financeMeta.UpdateDate:'2019-12-31',raw_file:download.file,raw_sha256:download.sha256,retrieved_at:download.retrieved_at,dataset_row:lineIndex,answer_index:answerIndex,char_count:n,sha256:hash(text),script:'simplified',_text:text};
 if(split==='psychology')Object.assign(row,{upstream_license:{name:'CC0 1.0 Universal',url:'https://creativecommons.org/publicdomain/zero/1.0/'},published_at:'2020-05-05',date_not_after:psychologyProof.commit_timestamp,date_basis:'Human answer exactly matches the original Chinese Psychological QA dataset (whitespace ignored), frozen at Git commit '+psychologyProof.commit+' dated '+psychologyProof.commit_timestamp+'. Original answer therefore existed before 2021; HC3 release is later.',date_evidence_files:[rights.file,psychologyOrigin.file,psychologyCommit.file,psychologyLicense.file,'psychology-date-proof.json'],upstream_answer_proof:psychologyProof.matches[lineIndex+':'+answerIndex]});
 candidates.push(row);
 }
 }
}
const rows=[],dd=new Deduper();
for(const other of ['human-zh','human-zh-gov'])try{const rs=(await fs.readFile(path.join(subset(other),'manifest.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);for(const r of rs)dd.check(await fs.readFile(path.join(subset(other),'texts',r.id+'.txt'),'utf8'),r.id);}catch(e){if(e.code!=='ENOENT')throw e;}
function select(pool,target,bucketKey,maxPerBucket=Infinity){let n=0;const bs=Object.values(Object.groupBy(pool,bucketKey));for(let i=0;n<target&&i<maxPerBucket;i++){let any=false;for(const b of bs){if(i>=b.length)continue;any=true;const r=b[i];if(n<target&&!dd.check(r._text,r.id)){rows.push(r);n++;}}if(!any)break;}return n;}
for(const source of ['wikinews','wikipedia','hc3']){
 const pool=candidates.filter(r=>r.source===source);
 let n;
 if(source==='hc3'){n=select(pool.filter(r=>r.hc3_subset==='finance'),30,r=>String(r.dataset_row),3);n+=select(pool.filter(r=>r.hc3_subset==='psychology'),200-n,r=>String(r.dataset_row),1);}
 else n=select(pool,200,r=>r.work,source==='wikipedia'?3:1);
 console.log('OPEN SELECTED',source,n,'eligible',pool.length);
}
await fs.mkdir(path.join(dir,'texts'),{recursive:true});for(const r of rows){await fs.writeFile(path.join(dir,'texts',r.id+'.txt'),r._text);delete r._text;}
await fs.writeFile(path.join(dir,'manifest.jsonl'),rows.map(JSON.stringify).join('\n')+'\n');
await pruneTexts(dir,rows);
for(const [split,reason]of Object.entries({baike:'Descriptions freshly crawled for HC3 in 2022; no pre-2021 revision proof and upstream has no licence',nlpcc_dbqa:'Upstream licence unknown per HC3 maintainers',medicine:'Upstream CC BY-NC 4.0 is stricter than requested open CC BY-SA licence',law:'Upstream licence unknown per HC3 maintainers',open_qa:'All human answers are below 300 Han characters; no answers concatenated'}))skips.push({source:'hc3',split,reason});
await writeJson(path.join(dir,'build-skips.json'),skips);
