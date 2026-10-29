import {parse} from 'parse5';
export const attr=(n,key)=>n.attrs?.find(a=>a.name===key)?.value||'';
export const children=n=>n.childNodes||[];
export function find(n,predicate){if(predicate(n))return n;for(const c of children(n)){const hit=find(c,predicate);if(hit)return hit;}return null;}
export function all(n,predicate,out=[]){if(predicate(n))out.push(n);for(const c of children(n))all(c,predicate,out);return out;}
export function plain(n){if(n.nodeName==='#text')return n.value;if(['script','style','noscript','table','figure','sup','img'].includes(n.tagName))return '';if(n.tagName==='br')return '\n';return children(n).map(plain).join('');}
export const document=s=>parse(s);
export function linksFrom(html,url){return all(parse(html),n=>n.tagName==='a'&&attr(n,'href')).map(n=>{try{return{title:plain(n).trim(),url:new URL(attr(n,'href'),url).href};}catch{return null;}}).filter(Boolean);}
export function paragraphs(n){const out=[];function walk(node){if(['script','style','noscript','table','figure'].includes(node.tagName))return;if(node.tagName==='p'||/^h[1-6]$/.test(node.tagName)){const t=plain(node).replace(/[\u200B-\u200F\uFEFF]/g,'').replace(/[ \t\u3000]+/g,' ').trim();if(t)out.push(t);return;}for(const c of children(node))walk(c);}walk(n);return out;}
