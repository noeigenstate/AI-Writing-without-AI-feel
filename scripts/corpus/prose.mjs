import {clean} from './text.mjs';
import {han} from './common.mjs';
// Never render historical wikitext with present-day transcluded templates.
// Unknown inline templates discard their containing paragraph, avoiding silent gaps.
export function wikiSections(raw){
 let s=raw.replace(/<!--[\s\S]*?-->/g,'').replace(/<ref\b[^>]*>[\s\S]*?<\/ref\s*>|<ref\b[^>]*\/\s*>/gi,'').replace(/<(?:gallery|math|timeline|score|syntaxhighlight|source)\b[^>]*>[\s\S]*?<\/(?:gallery|math|timeline|score|syntaxhighlight|source)>/gi,' OMIT ');
 let out='',table=0;
 for(const line of s.split('\n')){if(/^\s*\{\|/.test(line))table++;if(!table)out+=line+'\n';if(/^\s*\|}/.test(line))table=Math.max(0,table-1);}
 s=out;out='';
 for(let i=0;i<s.length;){
 if(s.slice(i,i+2)!=='{{'){out+=s[i++];continue;}
 let depth=1,j=i+2;for(;j<s.length&&depth;j++){if(s.slice(j,j+2)==='{{'){depth++;j++;}else if(s.slice(j,j+2)==='}}'){depth--;j++;}}
 if(depth)break;
 const body=s.slice(i+2,j-2),name=body.split('|')[0].trim();
 if(/^(?:lang|lang-zh|nowrap|nobr|small|big|color|ruby)$/i.test(name)&&!body.includes('{{')){const ps=body.split('|').slice(1);out+=ps.slice(/^(?:lang|color)$/.test(name)?1:0,1+(/^(?:lang|color)$/.test(name)?1:0)).join('');}
 else if(/^(?:NoteTA|Infobox|taxobox|chembox|pp-|other|about|redirect|main|further|see|commons|ref|cite|citation|navbox|authority|coord|good|featured|stub|hide|article|date|publish|review|source|location|byline|wikipedia|archive|develop|flag|audio|related|DEFAULTSORT|taxonbar)/i.test(name))out+='\n';
 else out+=' OMIT ';
 i=j;
 }
 s=out;
 // Remove balanced media links (captions themselves can contain nested links).
 s=s.replace(/\[\[(?:File|Image|文件|檔案|图像|圖像):/gi,'[[MEDIA:');out='';
 for(let i=0;i<s.length;){if(!s.startsWith('[[MEDIA:',i)){out+=s[i++];continue;}let d=1,j=i+2;for(;j<s.length&&d;j++){if(s.slice(j,j+2)==='[['){d++;j++;}else if(s.slice(j,j+2)===']]'){d--;j++;}}i=j;}
 s=out.replace(/-\{H\|[\s\S]*?\}-/g,'').replace(/-\{([^{}]*)\}-/g,'$1');
 const sections=[];let title='导言',paras=[],excluded=false;
 const flush=()=>{if(paras.length&&!excluded)sections.push({title,text:paras.join('\n\n')});paras=[];};
 for(const line of s.split('\n')){
 const heading=line.match(/^\s*={2,}\s*(.*?)\s*={2,}\s*$/);
 if(heading){flush();title=heading[1];excluded=/參考|参考|注释|註釋|註解|注解|来源|來源|資料|资料|外部|連結|链接|相關|相关|参见|參見|延伸|書目|书目|作品列表|獲獎|获奖|参考书|著作|大事記|年表/.test(title);continue;}
 if(excluded||/^\s*[*#;:|!]|^\s*__|OMIT|https?:\/\/[^\s]+\s*$/.test(line))continue;
 const c=clean(line);if(c.unknown.length||han(c.text)<35||/[{}]|\[\[|\]\]/.test(c.text))continue;
 paras.push(c.text);
 }flush();return sections;
}
// Each new block begins at a printed heading or statutory article boundary.
export function officialSections(lines){
 const flat=lines.flatMap(s=>s.split(/\n+/)).map(s=>s.trim()).filter(Boolean);
 const blocks=[];let current={title:'导言',lines:[]};
 const heading=/^(?:第[一二三四五六七八九十百零〇0-9]+[章节编節章編]|[一二三四五六七八九十]+[、．.]|[（(][一二三四五六七八九十]+[）)]|第[一二三四五六七八九十百零〇0-9]+条\s)/;
 for(const l of flat){if(heading.test(l)&&current.lines.length){blocks.push(current);current={title:l.slice(0,100),lines:[]};}current.lines.push(l);}if(current.lines.length)blocks.push(current);
 const pieces=[];let pending=[],start='';
 for(const b of blocks){const text=b.lines.join('\n\n');if(han(text)>5000){if(pending.length){pieces.push({title:start,text:pending.join('\n\n')});pending=[];}continue;}if(pending.length&&han(pending.join('\n\n')+'\n\n'+text)>5000){pieces.push({title:start,text:pending.join('\n\n')});pending=[];}if(!pending.length)start=b.title;pending.push(text);if(han(pending.join('\n\n'))>=600){pieces.push({title:start,text:pending.join('\n\n')});pending=[];}}
 if(pending.length){const tail=pending.join('\n\n');if(han(tail)>=300)pieces.push({title:start,text:tail});}
 return pieces;
}
