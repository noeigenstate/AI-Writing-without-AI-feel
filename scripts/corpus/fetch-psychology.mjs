import path from 'node:path';
import {original,subset} from './sources.mjs';
import {writeJson} from './common.mjs';
const dir=subset('human-zh-open');
for(const [label,url,ext]of [
 ['psychology','https://huggingface.co/datasets/Hello-SimpleAI/HC3-Chinese/raw/main/psychology.jsonl','jsonl'],
 ['psychology-upstream-readme','https://raw.githubusercontent.com/hailiang-wang/Chinese-Psychological-QA-DataSet-/master/README.md','md'],
 ['psychology-upstream-commits','https://api.github.com/repos/hailiang-wang/Chinese-Psychological-QA-DataSet-/commits?path=rec_ans_500.json&until=2020-12-31T23%3A59%3A59Z&per_page=1','json'],
 ['psychology-2020-commits','https://api.github.com/repos/flyrae/Chinese-Psychological-QA-DataSet/commits?until=2020-12-31T23%3A59%3A59Z&per_page=1','json'],
 ['psychology-2020-readme','https://raw.githubusercontent.com/flyrae/Chinese-Psychological-QA-DataSet/cef85f0545925948a583d848f72750dd3363fc94/README.md','md'],
 ['psychology-2020','https://raw.githubusercontent.com/flyrae/Chinese-Psychological-QA-DataSet/cef85f0545925948a583d848f72750dd3363fc94/data/ques_ans.zip','zip'],
 ['psychology-license','https://aistudio.baidu.com/datasetdetail/38489','html']
])try{const raw=await original(dir,url,ext);await writeJson(path.join(dir,label+'-download.json'),{file:raw.file,sha256:raw.sha256,url:raw.url,retrieved_at:raw.retrieved_at});console.log(label,raw.file,raw.bytes.length,raw.bytes.toString('utf8').slice(0,label==='psychology-upstream-commits'?2200:150));}catch(e){console.log(label,e.message);}
