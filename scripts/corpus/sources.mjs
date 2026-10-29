// Source snapshots are byte-for-byte downloads. The existing URL cache is shared.
import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT,download,hash,writeJson,json} from './common.mjs';
export const CUTOFF='2020-12-31T23:59:59Z';
export const subset=name=>path.join(ROOT,'data/corpus',name);
export async function original(dir,url,extension='json'){
 const d=await download(url,{binary:true});
 const file='raw/'+hash(url)+'.'+extension;
 await fs.mkdir(path.join(dir,'raw'),{recursive:true});
 await fs.writeFile(path.join(dir,file),d.body);
 const meta={url,file,sha256:hash(d.body),bytes:d.body.length,retrieved_at:d.retrieved_at,content_type:d.content_type};
 await writeJson(path.join(dir,file+'.meta.json'),meta);
 return {...meta,bytes:d.body};
}
export async function wiki(dir,host,params){
 const url=new URL('https://'+host+'/w/api.php');
 for(const [k,v] of Object.entries({format:'json',formatversion:'2',maxlag:'5',...params}))url.searchParams.set(k,v);
 const raw=await original(dir,url.href);
 const result=JSON.parse(raw.bytes.toString('utf8'));if(result.error)throw Error(JSON.stringify(result.error));
 return {result,raw};
}
export async function snapshots(dir,host,titles){
 const out=[];
 for(let i=0;i<titles.length;i++){
 const {result,raw}=await wiki(dir,host,{action:'query',titles:titles[i],prop:'revisions',rvprop:'ids|timestamp|content',rvslots:'main',rvstart:CUTOFF,rvdir:'older',rvlimit:'1'});
 for(const p of result.query.pages)out.push({...p,raw_file:raw.file,raw_sha256:raw.sha256,retrieved_at:raw.retrieved_at});
 if((i+1)%10===0)console.log('SNAPSHOTS',host,i+1,'/',titles.length);
 }return out;
}
