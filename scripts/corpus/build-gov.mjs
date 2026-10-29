import fs from 'node:fs/promises';
import path from 'node:path';
import {subset} from './sources.mjs';
import {json,writeJson,hash,han,pruneTexts} from './common.mjs';
import {document,all,attr} from './html.mjs';
import {officialSections} from './prose.mjs';
import {simplified} from './identity.mjs';
import {Deduper,residue} from './text.mjs';
const dir=subset('human-zh-gov'),docs=await json(path.join(dir,'documents.json')),candidates=[],skips=[];
function numeral(s){const digits={'〇':0,'○':0,'零':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};if(/^\d+$/.test(s))return +s;if(s.includes('十')){const [a,b]=s.split('十');return (a?digits[a]:1)*10+(b?digits[b]:0);}return +[...s].map(c=>digits[c]).join('');}
function signatureDate(line){const m=line.replace(/\s/g,'').match(/^([12]\d{3}|[〇○零一二三四五六七八九]{4})年([\d一二三四五六七八九十]{1,3})月([\d一二三四五六七八九十]{1,3})日$/);if(!m)return null;return numeral(m[1])+'-'+String(numeral(m[2])).padStart(2,'0')+'-'+String(numeral(m[3])).padStart(2,'0');}
for(const d of docs){
 const html=await fs.readFile(path.join(dir,d.raw_file),'utf8'),tree=document(html),text=d.lines.join('\n');
 const metas=Object.fromEntries(all(tree,n=>n.tagName==='meta').map(n=>[attr(n,'name').toLowerCase(),attr(n,'content')]));
 const dates=[...text.matchAll(/(20\d{2}|19\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日/g)].map(m=>({date:m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0'),offset:m.index})).filter(m=>m.date<'2021-01-01');
 const date=d.category==='government_report'?dates.find(m=>m.offset<1000)?.date:dates.filter(m=>m.offset>text.length-2500).at(-1)?.date||dates.find(m=>m.offset<1200)?.date;
 const signatures=d.lines.flatMap(l=>l.split(/\n+/)).map((line,index)=>({date:signatureDate(line),line,index})).filter(x=>x.date&&x.date<'2021-01-01');
 const order=/令/.test(d.lines.slice(0,3).join(''));
 const signature=order?signatures.find(x=>x.index<18):signatures.at(-1);
 let issued_at=d.issued_at||(d.category==='government_report'?date:signature?.date||date);
 const effective=text.match(/自\s*(20\d\d)年\s*(\d{1,2})月\s*(\d{1,2})日起施行/);
 const effective_at=d.effective_at||(effective?effective[1]+'-'+effective[2].padStart(2,'0')+'-'+effective[3].padStart(2,'0'):null);
 if(effective_at&&effective_at>='2021-01-01'){skips.push({title:d.title,reason:'Version not in force before 2021: '+effective_at});continue;}
 // Official publication metadata is a valid upper bound where no signature date is printed.
 if(!issued_at){const match=(metas.firstpublishedtime||metas.pubdate||'').match(/^((?:19|20)\d\d-\d\d-\d\d)/);if(match&&match[1]<'2021-01-01')issued_at=match[1];}
 if(!issued_at){skips.push({title:d.title,reason:'No verified pre-2021 issue/publication date'});continue;}
 const orderNumber=d.title.match(/^中华人民共和国([^\n]*?)令[（(]([^）)]+)[）)]/);
 const printedNumbers=d.lines.slice(0,20).flatMap(l=>l.split(/\n+/)).map(l=>l.replace(/\s/g,''));
 const number=orderNumber?orderNumber[1]+'令'+orderNumber[2].replace(/\s/g,''):printedNumbers.find(l=>/^[\p{Script=Han}]{1,16}[〔\[（(]20\d\d[〕\]）)]\d+号$/u.test(l))||null;
 let issuer=d.issuer||(d.category==='government_report'?'国务院':(d.title.match(/^中华人民共和国([^\n]+?)令/)?.[1]||''));
 if(!issuer){const tail=d.lines.slice(-20).filter(l=>/^(?:国务院(?:办公厅)?|中华人民共和国[\p{Script=Han}]{2,12}部|[\p{Script=Han}]{2,12}(?:部|总局|委员会|总署))\s*$/u.test(l));issuer=tail.at(-1)||(/国务院办公厅/.test(d.title)?'国务院办公厅':/国务院/.test(d.title)?'国务院':'');}
 if(!issuer){skips.push({title:d.title,reason:'Issuer requires review'});continue;}
 // A departmental rule is administrative documentation, not a national administrative regulation.
 let category=d.category;if(category==='law_regulation'&&!/国务院|人民代表大会/.test(issuer))category='state_ministry_document';
 const begin=d.body_start?d.lines.findIndex(l=>l.startsWith(d.body_start)):0;
 const lines=d.lines.slice(Math.max(0,begin)).filter(l=>!/新华社|记者.*摄|【|扫一扫|责任编辑|点击|图解|解读/.test(l));
 for(const [i,p]of officialSections(lines).entries()){
 const text=simplified(p.text).trim()+'\n',n=han(text);if(n<300||n>5000||residue(text)){skips.push({title:d.title,section:p.title,reason:'Bounds/residue'});continue;}
 const id='gov-'+hash(d.source_url+'\0'+i).slice(0,20);
 candidates.push({id,piece_title:d.title+' / '+p.title,work:d.title,genre:category==='government_report'?'政府工作报告':category==='law_regulation'?'法律/行政法规':'行政公文',source:'gov.cn',category,issuer,doc_number:number,issued_at,effective_at,source_url:d.source_url,license_basis:'不适用著作权法：《著作权法》第五条',date_basis:d.date_basis||((signature&&category!=='government_report')?'Official document signature: '+signature.line:date?'Report-delivery or issue date printed in official text':'Official page publication metadata; upper bound for issuance'),version_basis:'Official historical version at '+d.source_url,raw_file:d.raw_file,raw_sha256:d.raw_sha256,retrieved_at:d.retrieved_at,char_count:n,sha256:hash(text),script:'simplified',section_index:i,_text:text});
 }
}
const rows=[],dd=new Deduper();
for(const cat of ['government_report','law_regulation','state_ministry_document']){
 const buckets=Object.values(Object.groupBy(candidates.filter(r=>r.category===cat),r=>r.work));let n=0;
 for(let i=0;n<100;i++){let any=false;for(const b of buckets){if(i>=b.length)continue;any=true;const r=b[i];if(n<100&&!dd.check(r._text,r.id)){rows.push(r);n++;}}if(!any)break;}
 console.log('GOV SELECTED',cat,n,'eligible',candidates.filter(r=>r.category===cat).length);
}
await fs.mkdir(path.join(dir,'texts'),{recursive:true});for(const r of rows){await fs.writeFile(path.join(dir,'texts',r.id+'.txt'),r._text);delete r._text;}
await fs.writeFile(path.join(dir,'manifest.jsonl'),rows.map(JSON.stringify).join('\n')+'\n');await writeJson(path.join(dir,'build-skips.json'),skips);
await pruneTexts(dir,rows);
