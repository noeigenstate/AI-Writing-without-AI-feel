// Identity spelling equivalences only; corpus text is never converted.
const pairs='魯鲁釗钊陳陈獨独適适聞闻達达陸陆蕭萧許许隱隐豐丰愷恺統统劉刘吶呐鷗鸥鄧邓孫孙鄭郑鐸铎錢钱趙赵樹树國国維维呂吕張张勱劢漢汉羅罗蔣蒋馮冯覺觉紓纾淵渊壽寿廣广譚谭楓枫華华鈞钧評评夢梦麟麟雲云吳吴稻稻';
import {Converter} from 'opencc-js';
const toSimplified=Converter({from:'t',to:'cn'});
// Phrase conversion can expose a second dictionary match (e.g. 屬於 -> 属於 -> 属于).
// Keep the original untouched; make each generated copy a stable OpenCC result.
export const simplified=s=>{for(let i=0;i<4;i++){const next=toSimplified(s);if(next===s)return s;s=next;}throw Error('OpenCC conversion did not stabilize');};
export const authorName=s=>simplified(s).replace(/\s*\(清\)$/,'');
export function identity(s){const n=simplified(s.replace(/\[\[|\]\]|Author:|作者:/g,'').trim());return ({'还珠楼主':'李寿民','周树人':'鲁迅','冯文炳':'废名','舒庆春':'老舍','刘复':'刘半农','吴敬恒':'吴稚晖','黄淑仪':'庐隐','黄英':'庐隐','李伯元':'李宝嘉','吴沃尧':'吴趼人','我佛山人':'吴趼人','刘鹗 (清)':'刘鹗'})[n]||n;}
