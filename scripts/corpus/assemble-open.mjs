// Resume offline processing from every completed historical API response.
import fs from 'node:fs/promises';
import path from 'node:path';
import {subset} from './sources.mjs';
import {json,writeJson,hash} from './common.mjs';
const dir=subset('human-zh-open'),ps=new Map();
for(const f of await fs.readdir(path.join(dir,'raw'))){
 if(!f.endsWith('.meta.json'))continue;const m=await json(path.join(dir,'raw',f));let u;try{u=new URL(m.url);}catch{continue;}
 if(u.hostname!=='zh.wikinews.org'||!u.searchParams.has('rvstart')||!u.searchParams.has('titles')||u.searchParams.get('titles').includes('|'))continue;
 const bytes=await fs.readFile(path.join(dir,m.file));if(hash(bytes)!==m.sha256)throw Error('Raw checksum mismatch');
 const j=JSON.parse(bytes.toString());for(const p of j.query?.pages||[])ps.set(p.title,{...p,raw_file:m.file,raw_sha256:m.sha256,retrieved_at:m.retrieved_at});
}
await writeJson(path.join(dir,'wikinews-pages.json'),[...ps.values()]);console.log('ASSEMBLED NEWS',ps.size);
