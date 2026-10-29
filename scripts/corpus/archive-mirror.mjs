import fs from 'node:fs/promises';
import path from 'node:path';
import {DATA,json,writeJson,hash} from './common.mjs';
import {normalized} from './text.mjs';
import {original} from './sources.mjs';
const meta=await original(DATA,'https://archive.org/metadata/pgcommunitytexts25260gut');
const j=JSON.parse(meta.bytes.toString());
if(!j.metadata.collection.includes('gutenberg')||!j.metadata.rights.includes('Public domain')||j.metadata.source!=='http://www.gutenberg.org/ebooks/25260')throw Error('Archive source identity/rights require review');
const mirror=await original(DATA,'https://archive.org/download/pgcommunitytexts25260gut/25260-0.txt','txt');
const pg=(await json(path.join(DATA,'gutenberg-books.json'))).find(b=>b.id===25260);
const old=(await fs.readFile(path.join(DATA,pg.raw_file),'utf8')).replace(/\r/g,'');
const mirrored=mirror.bytes.toString('utf8').replace(/\r/g,'');
const body=s=>s.slice(s.indexOf('*** START OF'),s.indexOf('*** END OF')).replace(/^\*\*\*[^\n]+\n/,'');
// Gutenberg's front/back matter changed since the 2011 mirror; the Chinese work must match.
const workBody=s=>{s=body(s).replace(/\nEnd of the Project Gutenberg EBook[\s\S]*$/i,'');return s.slice(s.indexOf('豐收')).replace(/\s+/g,'');};
if(workBody(old)!==workBody(mirrored))throw Error('Archive mirror differs from Gutenberg work (including punctuation)');
const book_file='books/archive/pgcommunitytexts25260gut.txt';await fs.mkdir(path.join(DATA,'books/archive'),{recursive:true});await fs.writeFile(path.join(DATA,book_file),mirror.bytes);
const rows=await json(path.join(DATA,'cache/extra-pieces.json'));
for(const r of rows.filter(r=>r.author==='叶紫')){
 r.source='archive';r.source_url='https://archive.org/details/pgcommunitytexts25260gut';r.raw_file=mirror.file;r.raw_sha256=mirror.sha256;r.book_file=book_file;r.archive_metadata_file=meta.file;r.archive_metadata_sha256=meta.sha256;r.retrieved_at=mirror.retrieved_at;r.mirror_of='https://www.gutenberg.org/ebooks/25260';
}
await writeJson(path.join(DATA,'cache/extra-pieces.json'),rows);
await writeJson(path.join(DATA,'archive-downloads.json'),[{source_url:'https://archive.org/details/pgcommunitytexts25260gut',book_file,sha256:hash(mirror.bytes),raw_file:mirror.file,raw_sha256:mirror.sha256,metadata_file:meta.file,metadata_sha256:meta.sha256,rights:j.metadata.rights,verification:'Chinese body identical to Gutenberg 25260; front/back matter differs',retrieved_at:mirror.retrieved_at}]);
console.log('ARCHIVE VERIFIED',rows.filter(r=>r.source==='archive').length,'eligible sections');
