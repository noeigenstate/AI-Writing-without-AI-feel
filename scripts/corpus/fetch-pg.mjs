import fs from 'node:fs/promises';
import path from 'node:path';
import {original,subset} from './sources.mjs';
import {writeJson,json,hash,han,DATA} from './common.mjs';
import {simplified} from './identity.mjs';
import {classical,garbled,residue,sections} from './text.mjs';
const books=[23827,23865,24079,24099,24113,24138,24142,24154,24227,25124,25128,25134,25147,25187,25226,25260,25379,25377,25561,26872,27302,27768,56291,57278];
const records=[],skips=[],rows=[];
const catalog=await import('node:zlib');
const gz=await original(DATA,'https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz','gz');
const csv=catalog.gunzipSync(gz.bytes).toString('utf8');
for(const id of books){
 try{
 const rdf=await original(DATA,'https://www.gutenberg.org/ebooks/'+id+'.rdf','rdf'),xml=rdf.bytes.toString('utf8');
 const authorBlock=xml.match(/<dcterms:creator>[\s\S]*?<\/dcterms:creator>/)?.[0]||'';
 const name=authorBlock.match(/<pgterms:name>([^<]+)<\/pgterms:name>/)?.[1],death=+(authorBlock.match(/<pgterms:deathdate[^>]*>(\d{4})</)?.[1]||0);
 const title=xml.match(/<dcterms:title>([^<]+)<\/dcterms:title>/)?.[1];
 if(!death||death>1975||!name||!title)throw Error('No verified eligible death date in Gutenberg RDF');
 const authorNames={'Wu, Jianren, 1866-1910':'吴趼人','Li, Boyuan, 1867-1906':'李宝嘉','Liu, E, 1857-1909':'刘鹗','Zeng, Pu, 1872-1935':'曾朴','Han, Bangqing, 1856-1894':'韩邦庆','Ye, Zi, 1912?-1939':'叶紫','Tianzhuisheng':'朱瘦菊','Quyuan':'欧阳钜源','Tenggu, Guxiang, 1880-1919':'孙景贤'};
 const author=authorNames[name]||{'Wu, Jianren':'吴趼人','Li, Boyuan':'李宝嘉','Liu, E':'刘鹗','Zeng, Pu':'曾朴','Han, Bangqing':'韩邦庆','Ye, Zi':'叶紫','Tenggu, Guxiang':'孙景贤','Li, Ruzhen':'李汝珍','Wei, Zi\'an':'魏子安','Yu, Da':'俞达'}[name];if(!author)throw Error('Author identity requires review: '+name);
 const raw=await original(DATA,'https://www.gutenberg.org/cache/epub/'+id+'/pg'+id+'.txt','txt');
 let text=raw.bytes.toString('utf8').replace(/^\uFEFF/,'').replace(/\r/g,'');
 const start=text.search(/\*\*\* START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\n/i),end=text.search(/\*\*\* END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i);
 if(start<0||end<0)throw Error('Missing Gutenberg boundaries');
 text=text.slice(start,end).replace(/^\*\*\*[^\n]*\n/,'').trim();
 const chunks=text.split(/\n(?=[ \t\u3000]*(?:第[一二三四五六七八九十百零〇0-9]+[回章节章][^\n]{0,80}|[一二三四五六七八九十百]+[、．.]?[ \t\u3000]*)\n)/);
 const work=simplified(title).replace(/\s+/g,' '),source_url='https://www.gutenberg.org/ebooks/'+id;
 const storyStarts=id===25260?[...text.matchAll(/^　　(豐收|電網外|夜哨線|楊七公公過年|嚮導)\s*$/gm)].map(m=>({title:simplified(m[1]),offset:m.index})):[];
 const file='books/gutenberg/pg'+id+'.txt';await fs.mkdir(path.join(DATA,'books/gutenberg'),{recursive:true});await fs.copyFile(path.join(DATA,raw.file),path.join(DATA,file));
 records.push({id,author,author_original:name,death_year:death,work,raw_file:raw.file,raw_sha256:raw.sha256,book_file:file,death_evidence_file:rdf.file,death_evidence_sha256:rdf.sha256,source_url});
 let offset=0;
 for(const [i,chunk]of chunks.entries()){
  const chunkOffset=text.indexOf(chunk,offset);offset=chunkOffset+chunk.length;
  const story=storyStarts.filter(s=>s.offset<=chunkOffset).at(-1)?.title||work;
  const t=chunk.trim().replace(/^[ \t\u3000]+/gm,'').replace(/[（(](?:註|注)[一二三四五六七八九十\d]+[）)]/g,'').replace(/\n{3,}/g,'\n\n')+'\n',n=han(t);
  if(n<300||n>5000||classical(t)||garbled(t)||residue(t))continue;
  if(i===0&&!/^第/.test(t))continue; // title, production credits, and contents never become samples.
  const pieceId='human-'+hash('gutenberg\0'+id+'\0'+i).slice(0,20);
  rows.push({id:pieceId,author,author_original:name,author_death_year:death,work:story,collection:work,piece_title:story+' / '+(t.split('\n')[0].trim()||i),genre:'小说',register:'vernacular',char_count:n,source:'gutenberg',source_url,book_file:file,raw_file:raw.file,raw_sha256:raw.sha256,license_basis:'Public domain in China: author died '+death,sha256:hash(t),retrieved_at:raw.retrieved_at,script:simplified(t)===t?'simplified':'traditional',simplified_file:'texts-simplified/'+pieceId+'.txt',composition_not_after:death+'-12-31',date_basis:'Original Chinese novel; verified Gutenberg creator death date '+death,section_index:i,_text:t});
 }
 console.log('PG',id,author,death,work,'eligible',rows.filter(r=>r.source_url===source_url).length);
 }catch(e){skips.push({id,reason:e.message});console.log('PG SKIP',id,e.message);}
}
await writeJson(path.join(DATA,'gutenberg-books.json'),records);await writeJson(path.join(DATA,'gutenberg-skips.json'),skips);await writeJson(path.join(DATA,'cache/extra-pieces.json'),rows);
