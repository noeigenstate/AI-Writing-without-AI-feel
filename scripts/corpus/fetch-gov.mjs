import fs from 'node:fs/promises';
import path from 'node:path';
import {original,subset} from './sources.mjs';
import {writeJson,json} from './common.mjs';
import {linksFrom,document,find,attr,plain,paragraphs} from './html.mjs';
const dir=subset('human-zh-gov'),records=[],skips=[];
if(process.argv.includes('--reports-only')||process.argv.includes('--laws-only'))records.push(...await json(path.join(dir,'documents.json')));
async function get(url){return original(dir,url,'html');}
async function doc(url,category,title,extra={}){
 if(records.some(r=>r.source_url===url))return;
 try{let raw=await get(url);let html=raw.bytes.toString('utf8');
 if(html.length<1500){const redirect=linksFrom(html,url).find(l=>l.title==='点击跳转');if(redirect){url=redirect.url;raw=await get(url);html=raw.bytes.toString('utf8');}}
 const tree=document(html);const node=find(tree,n=>attr(n,'id')==='UCAP-CONTENT')||find(tree,n=>attr(n,'id')==='Zoom')||find(tree,n=>/(?:^| )pages_content(?: |$)/.test(attr(n,'class')))||find(tree,n=>/(?:^| )TRS_Editor(?: |$)/.test(attr(n,'class')));
 if(!node)throw Error('No official article body');
 const lines=paragraphs(node);title||=plain(find(tree,n=>n.tagName==='h1')||{}).trim();
 records.push({title,category,source_url:url,raw_file:raw.file,raw_sha256:raw.sha256,retrieved_at:raw.retrieved_at,lines,...extra});
 await writeJson(path.join(dir,'documents.json'),records);console.log('GOV DOC',category,title,lines.length);
 }catch(e){skips.push({url,title,reason:e.message});console.log('GOV SKIP',e.message);}
}
if(!process.argv.includes('--reports-only')&&!process.argv.includes('--laws-only')){
// Existing official catalogue supplies exact report URLs, including historical texts.
const reportIndex=await get('https://www.gov.cn/guoqing/2006-02/16/content_2616810.htm');
for(const l of linksFrom(reportIndex.bytes.toString('utf8'),reportIndex.url).filter(l=>/^20(?:0\d|1[0-6])$/.test(l.title)))await doc(l.url,'government_report',l.title+'年国务院政府工作报告');
for(const [year,url]of [[2017,'https://app.www.gov.cn/govdata/gov/201703/16/400909/article.html'],[2018,'https://app.www.gov.cn/govdata/gov/201803/22/421850/article.html'],[2019,'https://app.www.gov.cn/govdata/gov/201903/17/436689/article.html'],[2020,'https://www.gov.cn/premier/2020-05/29/content_5516072.htm']])await doc(url,'government_report',year+'年国务院政府工作报告');
const catalogRaw=await original(dir,'https://www.gov.cn/gongbao/gbgl.json');const catalog=JSON.parse(catalogRaw.bytes.toString('utf8'))[0].values;
const found=new Map();
for(const year of [2020,2019]){
 const issues=Object.values(catalog[year+'年']);
 for(const issue of issues){
 try{const raw=await get(issue.gname);const tree=document(raw.bytes.toString('utf8'));const box=find(tree,n=>attr(n,'class')==='box');
 if(box)for(const l of linksFrom(raw.bytes.toString('utf8'),issue.gname).filter(l=>/\/gongbao\/content\//.test(l.url))){const title=l.title.split(/[…\.]{2,}/)[0].trim();
 if(/政府工作报告|讲话|名录|名单|目录|任免|统计公报/.test(title))continue;
 if(/条例|国务院令/.test(title))found.set(l.url,{...l,title,category:'law_regulation'});
 else if(/通知|意见|办法|规定|决定|批复|规划|方案|国务院|部令/.test(title))found.set(l.url,{...l,title,category:'state_ministry_document'});
 }
 console.log('GOV ISSUE',year,issue.issue,found.size);
 }catch(e){skips.push({url:issue.gname,reason:e.message});}
 }
}
await writeJson(path.join(dir,'discovered-documents.json'),[...found.values()]);
// Spread acquisition over both years, retain section-level selection for the builder.
let nc=0,pc=0;
for(const d of found.values()){
 if(d.category==='law_regulation'){if(nc++>=32)continue;}else if(pc++>=65)continue;
 await doc(d.url,d.category,d.title);
}
}
if(process.argv.includes('--reports-only')){
 const raw=await original(dir,'https://www.gov.cn/gongbao/gbgl.json');const catalog=JSON.parse(raw.bytes.toString('utf8'))[0].values;
 for(let year=2000;year<=2020;year++){
  if(records.some(r=>r.category==='government_report'&&r.title.startsWith(String(year))))continue;
  for(const number of [9,10,11,8,12]){
   const issue=catalog[year+'年']?.['第'+number+'号'];if(!issue)continue;
   try{const raw=await get(issue.gname);const matches=linksFrom(raw.bytes.toString('utf8'),issue.gname).filter(l=>/^政府工作报告(?:\s|$|——)/.test(l.title)&&/\/gongbao\/content\//.test(l.url));
    for(const l of matches)await doc(l.url,'government_report',year+'年国务院政府工作报告');if(matches.length)break;
   }catch(e){skips.push({url:issue.gname,reason:e.message});}
  }
 }
}
if(process.argv.includes('--laws-only'))await doc('https://www.gov.cn/guoqing/2018-03/22/content_5276318.htm','law_regulation','中华人民共和国宪法（2018年修正）',{issuer:'全国人民代表大会',issued_at:'2018-03-11',effective_at:'2018-03-11',date_basis:'Last amendment date in official constitutional text: 2018年3月11日',body_start:'中国是世界上历史最悠久的国家之一'});
await writeJson(path.join(dir,process.argv.includes('--reports-only')?'report-fetch-skips.json':process.argv.includes('--laws-only')?'law-fetch-skips.json':'fetch-skips.json'),skips);
console.log('GOV COMPLETE',records.length);
