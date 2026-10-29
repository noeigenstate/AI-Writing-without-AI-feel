import fs from 'node:fs/promises';
import path from 'node:path';
import {DATA,pages,api,content,json,writeJson,hash,han,sourceUrl} from './common.mjs';
import {original} from './sources.mjs';
import {document,find,attr,children} from './html.mjs';
import {simplified} from './identity.mjs';
import {classical,garbled,residue} from './text.mjs';
const candidates=await json(path.join(DATA,'cache/candidate-pages.json'));
const roots=[{author:'許地山',title:'空山霝雨 (1925)',root:'空山靈雨',genre:'散文'}];
const list=[];
for(const root of roots){
 const p=(await pages([root.title]))[0];const rendered=await api({action:'parse',oldid:p.revisions[0].revid,prop:'links'});
 for(const l of rendered.parse.links.filter(l=>l.ns===0&&l.exists&&l.title.startsWith(root.title+'/')))list.push({...root,title:l.title});
}
for(const c of candidates.filter(c=>['廬隱','石评梅','王統照','夏丏尊','陸蠡','郑振铎','郁達夫','徐志摩'].includes(c.author)&&/<pages\b/.test(content(c.page))))list.push(c);
const rows=[],skips=[];const authors=await json(path.join(DATA,'author-evidence.json'));
for(const c of list){
 const p=c.page||(await pages([c.title]))[0];if(!p?.revisions)continue;
 try{const raw=await original(DATA,'https://zh.wikisource.org/w/api.php?'+new URLSearchParams({format:'json',formatversion:'2',maxlag:'5',action:'parse',oldid:String(p.revisions[0].revid),prop:'text|revid|sections'}));
 const parsed=JSON.parse(raw.bytes.toString('utf8')).parse;if(!parsed)throw Error('No parse output');
 const tree=document(parsed.text),node=find(tree,n=>attr(n,'class').split(' ').includes('mw-parser-output'))||tree;
 let text='';function walk(n){const cl=attr(n,'class');if(['table','style','script','sup','figure'].includes(n.tagName)||/header|footer|pagenum|mw-editsection|reference|license|ws-noexport|noprint|catlinks|metadata/.test(cl)||attr(n,'id').startsWith('ws-author'))return;if(n.nodeName==='#text'){text+=n.value;return;}if(n.tagName==='br')text+='\n';if(['p','div','h2','h3','h4'].includes(n.tagName))text+='\n\n';for(const ch of children(n))walk(ch);if(['p','div','h2','h3','h4'].includes(n.tagName))text+='\n\n';}walk(node);
 text=text.replace(/\[編輯\]|\[编辑\]/g,'').replace(/[\u200B-\u200F\uFEFF]/g,'').split(/\n+/).map(l=>l.trim()).filter(l=>l&&!/^\d{1,4}$/.test(l)).join('\n\n').trim()+'\n';
 const n=han(text);if(n<300||n>5000||residue(text)||classical(text)||garbled(text))throw Error('Bounds/residue/register: '+n);
 const author=authors.find(a=>a.author===c.author);if(!author)throw Error('No author evidence');
 const id='human-'+hash('scan\0'+p.title+'\0'+p.revisions[0].revid).slice(0,20),simple=simplified(text);
 rows.push({id,author:simplified(c.author),author_original:c.author,author_death_year:author.death_year,work:p.title,piece_title:p.title,genre:c.genre,register:'vernacular',char_count:n,source:'wikisource',source_url:sourceUrl(p),source_revision:p.revisions[0].revid,book_file:null,raw_file:raw.file,raw_sha256:raw.sha256,license_basis:'Public domain in China: author died '+author.death_year,retrieved_at:raw.retrieved_at,sha256:hash(text),script:simple===text?'simplified':'traditional',simplified_file:'texts-simplified/'+id+'.txt',composition_not_after:author.death_year+'-12-31',date_basis:'Scanned original work by author who died '+author.death_year,collection:c.root,section_index:0,_text:text});
 console.log('SCAN',p.title,n);
 }catch(e){skips.push({title:p.title,reason:e.message});}
}
await writeJson(path.join(DATA,'scan-pieces.json'),rows);await writeJson(path.join(DATA,'scan-skips.json'),skips);
