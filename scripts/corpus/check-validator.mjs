import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import {ROOT,json,writeJson,hash,han} from './common.mjs';
import {Converter} from 'opencc-js';
const base=path.join(ROOT,'data/corpus'),fixture=path.resolve(base,'validation-check-'+crypto.randomUUID()),name='human-zh-gov',source=path.join(base,name),dir=path.join(fixture,name);
if(!fixture.startsWith(base+path.sep))throw Error('Unsafe fixture path');
await fs.mkdir(dir,{recursive:true});
try{
const rows=(await fs.readFile(path.join(source,'manifest.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const linked=new Set();for(const r of rows)for(const file of ['texts/'+r.id+'.txt',r.raw_file]){if(linked.has(file))continue;linked.add(file);await fs.mkdir(path.dirname(path.join(dir,file)),{recursive:true});await fs.link(path.join(source,file),path.join(dir,file));}
const save=()=>fs.writeFile(path.join(dir,'manifest.jsonl'),rows.map(JSON.stringify).join('\n')+'\n');await save();
const run=()=>spawnSync(process.execPath,[path.join(ROOT,'scripts/corpus/validate.mjs'),'--subset='+name,'--data-root='+fixture],{encoding:'utf8',windowsHide:true});
const baseline=run();if(baseline.status!==0)throw Error('Fixture baseline failed: '+baseline.stderr);
rows[0].sha256='0'.repeat(64);rows[1].issued_at='2021-01-01';rows[2].issuer='';
const original=await fs.readFile(path.join(dir,'texts',rows[3].id+'.txt'),'utf8');
// Unlink our hard link before writing; corpus originals are never mutated.
await fs.unlink(path.join(dir,'texts',rows[3].id+'.txt'));await fs.writeFile(path.join(dir,'texts',rows[3].id+'.txt'),original+'\u200B');rows[3].sha256=hash(original+'\u200B');
const twin=Converter({from:'cn',to:'t'})(await fs.readFile(path.join(source,'texts',rows[0].id+'.txt'),'utf8'));
await fs.unlink(path.join(dir,'texts',rows[4].id+'.txt'));await fs.writeFile(path.join(dir,'texts',rows[4].id+'.txt'),twin);rows[4].sha256=hash(twin);rows[4].char_count=han(twin);
await save();const bad=run();if(bad.status===0)throw Error('Validator incorrectly accepted corrupt fixture');
const errors=await json(path.join(dir,'validation-errors.json'));
const checks={sha256:errors.some(e=>e.includes(rows[0].id)&&e.includes('SHA-256 mismatch')),cutoff:errors.some(e=>e.includes(rows[1].id)&&e.includes('not strictly before 2021')),issuer:errors.some(e=>e.includes(rows[2].id)&&e.includes('missing issuer')),invisible:errors.some(e=>e.includes(rows[3].id)&&e.includes('residue')),traditional_duplicate:errors.some(e=>e.includes(rows[4].id)&&e.includes('duplicate/near-duplicate'))};
if(Object.values(checks).some(v=>!v))throw Error('Missing expected rejection: '+JSON.stringify(checks));
await writeJson(path.join(base,'validator-checks.json'),{status:'PASS',baseline_exit:baseline.status,corrupt_exit:bad.status,checks});console.log(JSON.stringify({status:'PASS',checks},null,2));
}finally{
// Resolved absolute target is a freshly created child of the intended corpus root.
if(!fixture.startsWith(base+path.sep)||!path.basename(fixture).startsWith('validation-check-'))throw Error('Unsafe cleanup target');
await fs.rm(fixture,{recursive:true,force:true});
}
