import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT,json,writeJson,hash} from './common.mjs';
const base=path.join(ROOT,'data/corpus'),names=['human-zh','human-zh-open','human-zh-gov'];
const count=(rows,fn)=>Object.fromEntries(Object.entries(Object.groupBy(rows,fn)).map(([k,v])=>[k,v.length]));
const table=(data,label)=>`| ${label} | Pieces |\n|---|---:|\n`+Object.entries(data).map(([k,v])=>`| ${k.replace(/\|/g,'/').replace(/\s+/g,' ')} | ${v} |`).join('\n');
const commands=[
"$env:NODE_USE_ENV_PROXY='1'",
'npm install --prefix scripts/corpus --cache data/corpus/npm-cache --ignore-scripts --no-audit --no-fund',
'npm install --prefix scripts/corpus parse5@8.0.0 --cache data/corpus/npm-cache --ignore-scripts --no-audit --no-fund',
'node scripts/corpus/fetch.mjs --literary',
'node scripts/corpus/fetch.mjs --poetry',
'node scripts/corpus/fetch-pg.mjs',
'node scripts/corpus/archive-mirror.mjs',
'node scripts/corpus/fetch-scans.mjs',
'node scripts/corpus/fetch-open.mjs',
'node scripts/corpus/fetch-open.mjs --hc3-only',
'node scripts/corpus/fetch-psychology.mjs',
'python scripts/corpus/verify-psychology.py',
'node scripts/corpus/fetch-news.mjs',
'node scripts/corpus/fetch-gov.mjs',
'node scripts/corpus/fetch-gov.mjs --reports-only',
'node scripts/corpus/fetch-gov.mjs --laws-only',
'node scripts/corpus/build.mjs',
'node scripts/corpus/build-gov.mjs',
'node scripts/corpus/build-open.mjs',
'node scripts/corpus/check-validator.mjs',
'node scripts/corpus/validate.mjs',
'node scripts/corpus/report.mjs'
];
const policies={
'human-zh':`Public domain in China, evaluated in 2026: verified authors died no later than 1975. No claim of public-domain status elsewhere. The source's original text and script remain in texts/. OpenCC generates a separate texts-simplified/ copy; conversion iterates to stability because some phrases need two passes. Author names and work quota keys use simplified Chinese; author_original/work_original preserve source spellings.\n\nA separately titled complete essay or short story is a work, even when its original download is a collection. For the newly acquired 空山靈雨 essays and the five independently titled stories in Gutenberg 25260, work records that title and collection records the volume. Explicit numbered sections of one novel/story share its ten-piece cap. Alternate traditional/simplified spellings also share a cap. Late-Qing vernacular fiction supplements the twentieth-century works.\n\nThe year table is the verified author's death year, a composition upper bound; it is **not** an invented exact publication year. Each row explains this in date_basis. Raw API response files, author evidence, Gutenberg RDF, and Archive mirror metadata are retained. Internet Archive's 2011 Gutenberg mirror of 豐收 was checked against Gutenberg, including punctuation after whitespace removal. University of Toronto scans were inspected, but their unusable OCR was excluded. The children’s-literature category retains 落花生; the independently checked animal fable 蜜蜂和農人 was below 300 Han characters. Adult parables and romantic prose are not relabelled as children’s literature.`,
'human-zh-open':`Every evaluation text derives from a human source before 2021-01-01. Wikimedia pages use the revision current at 2020-12-31T23:59:59Z, requested with rvstart, rvdir=older and rvlimit=1. Historical revision selection is one title per request; MediaWiki does not permit this parameter combination in a multi-title query. No current template rendering is used for these texts.\n\nWikinews: CC BY 2.5 Generic; article date comes from its historical date template. Wikipedia: CC BY-SA 3.0 Unported, the licence applicable to the 2020 revision. Only running prose is selected; infoboxes, tables, lists, references, navigation, media and paragraphs with unsupported inline templates are omitted. OpenCC conversion and prose/section extraction are changes to the source; attribution and a revision/history URL accompany each row.\n\nHC3-Chinese: CC BY-SA 4.0 International, human_answers only. The finance origin has CC BY 4.0 metadata with a final 2020 update. Psychology's upstream is identified as CC0 by HC3 and the public AI Studio page. All 5,220 HC3 psychology answers match the frozen May 5, 2020 original exactly after whitespace removal. The original ZIP, pre-cutoff Git commit metadata and per-answer coordinates are retained; validate independently recomputes the proof with Python's standard library. No ChatGPT field is accessed for selection. An upstream release date is an upper bound on answer creation, not a claim that each answer was written that day.\n\nSkipped: open_qa (all answers <300 Han; no concatenation), baike (2022 crawl without a pre-2021 revision and no upstream licence), nlpcc_dbqa and law (unknown upstream licences), medicine (CC BY-NC 4.0 is stricter than the requested open licence). The admitted HC3 sample is spread across finance and psychology; their proportions reflect eligible answer lengths.`,
'human-zh-gov':`Official text from gov.cn, based on 《著作权法》第五条: 不适用著作权法：《著作权法》第五条. This applies to the selected legislative/administrative documents, not automatically to all government-hosted writing.\n\nThe set contains 100 State Council government-work-report excerpts from 2000–2020 documents, 100 national-law/administrative-regulation excerpts, and 100 State Council/ministry document excerpts. Source pages and Gazette indexes are frozen under raw/. Issuers, document numbers where printed, issue/signature dates and available effective dates are recorded. Chinese-numeral signature dates are parsed as well as Arabic numerals; references to repealed historical enactments are not used as the current version's issue date. Documents whose stated effective date is in 2021 or later are excluded.\n\nSections begin at printed headings or statutory article boundaries; consecutive short articles can remain together to meet the length minimum. Long unsplittable sections are excluded. Historical gov.cn report links returning 404 are logged; the official Gazette supplied available replacement texts. No court-login/captcha source is used.`
};
const report={generated_at:new Date().toISOString(),cutoff:'2021-01-01',commands_run:commands,subsets:{},dependencies:(await json(path.join(ROOT,'scripts/corpus/package.json'))).dependencies};
for(const name of names){
 const dir=path.join(base,name);let rows,manifest;try{manifest=await fs.readFile(path.join(dir,'manifest.jsonl'));rows=manifest.toString().trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')continue;throw e;}
 let validation=null;try{validation=await json(path.join(dir,'validation-summary.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const current=validation?.manifest_sha256===hash(manifest);
 const data={pieces:rows.length,validation:current?validation.status:'RUN VALIDATE',manifest_sha256:hash(manifest),by_author_or_issuer:count(rows,r=>r.author||r.issuer||r.source),by_source:count(rows,r=>r.hc3_subset?'hc3/'+r.hc3_subset:r.source),by_genre:count(rows,r=>r.genre),by_year:count(rows,r=>(r.published_at||r.issued_at||r.revision_timestamp||r.composition_not_after).slice(0,4)),by_script:count(rows,r=>r.script),han_characters:rows.reduce((s,r)=>s+r.char_count,0)};
 if(name==='human-zh-open')data.wikipedia_topics=count(rows.filter(r=>r.source==='wikipedia'),r=>r.topic);
 const skipCounts={};for(const file of ['fetch-skips.json','report-fetch-skips.json','law-fetch-skips.json','news-fetch-skips.json','build-skips.json','gutenberg-skips.json','scan-skips.json'])try{const skips=await json(path.join(dir,file));skipCounts[file]=count(skips,r=>r.reason?.split(':')[0]||'unspecified');}catch(e){if(e.code!=='ENOENT')throw e;}
 data.skip_counts=skipCounts;report.subsets[name]=data;
 await writeJson(path.join(dir,'report.json'),data);
 await fs.writeFile(path.join(dir,'README.md'),`# ${name}\n\n${data.pieces} pieces; ${data.han_characters.toLocaleString('en-US')} Han characters. Validation: **${data.validation}**. See validation-summary.json, validation-errors.json and counts.json for the complete checks and distributions.\n\n${policies[name]}\n\n${table(data.by_source,'Source')}\n\n${table(data.by_genre,'Genre')}\n\n${table(data.by_author_or_issuer,name==='human-zh'?'Author':'Source/issuer')}\n\n${table(data.by_year,name==='human-zh'?'Composition no later than (death year)':'Source publication/revision/issue year')}\n\nIndividual acquisition, cleaning and exclusion decisions are in the *-skips.json files. Every text has a SHA-256 and a reference to an original download. Cross-subset duplicate screening is performed by the default validator invocation.\n\nReproduction: see ../../../scripts/corpus/README.md. Data, caches and downloaded originals are local and ignored by Git. No application code or scorer is used.\n`);
}
async function size(dir){let n=0;for(const d of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,d.name);if(d.isDirectory())n+=await size(p);else if(d.isFile())n+=(await fs.stat(p)).size;}return n;}
const disk={};for(const name of names)disk[name]=await size(path.join(base,name));disk.npm_cache=await size(path.join(base,'npm-cache'));disk.scripts_including_dependencies=await size(path.join(ROOT,'scripts/corpus'));disk.data_corpus=await size(base);disk.total_file_bytes=disk.data_corpus+disk.scripts_including_dependencies;disk.total_MiB=+(disk.total_file_bytes/1024**2).toFixed(2);report.disk_usage=disk;
// Include the report itself. Fixed-width byte counters stabilize after two writes.
for(let pass=0;pass<2;pass++){await writeJson(path.join(base,'report.json'),report);disk.data_corpus=await size(base);disk.total_file_bytes=disk.data_corpus+disk.scripts_including_dependencies;disk.total_MiB=+(disk.total_file_bytes/1024**2).toFixed(2);}
await writeJson(path.join(base,'report.json'),report);console.log(JSON.stringify({subsets:Object.fromEntries(Object.entries(report.subsets).map(([k,v])=>[k,{pieces:v.pieces,validation:v.validation}])),dependencies:report.dependencies,disk_usage:disk},null,2));
