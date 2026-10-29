import fs from 'node:fs/promises';
import path from 'node:path';
import {DATA,json,hash,writeJson} from './common.mjs';
export async function rawIndex(){
 const index=new Map();
 for(const file of await fs.readdir(path.join(DATA,'cache'))){
 if(!file.endsWith('.json.meta'))continue;
 const meta=await json(path.join(DATA,'cache',file));if(!meta.url.includes('revisions'))continue;
 const rel='cache/'+file.slice(0,-5),body=await fs.readFile(path.join(DATA,rel));if(hash(body)!==meta.sha256)throw Error('Cache digest mismatch '+rel);
 const result=JSON.parse(body.toString('utf8'));for(const p of result.query?.pages||[])for(const r of p.revisions||[])index.set(p.title+'\0'+r.revid,{raw_file:rel,raw_sha256:meta.sha256});
 }
 return index;
}
