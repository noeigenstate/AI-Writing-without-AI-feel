import path from 'node:path';
import {subset,wiki,snapshots,original} from './sources.mjs';
import {writeJson,json} from './common.mjs';
const dir=subset('human-zh-open');
const topics={
history:'秦朝 汉朝 唐朝 宋朝 元朝 明朝 清朝 中国历史 丝绸之路 工业革命 文艺复兴 法国大革命 第一次世界大战 第二次世界大战 冷战 罗马帝国 古埃及 古希腊 美国独立战争 美国内战 大航海时代 印度历史 日本历史 欧洲历史 十字军东征 英国历史 蒙古帝国 拿破仑战争 古巴比伦 三十年战争 春秋战国 百年战争 新石器时代 中国大运河 科举',
science:'地球 月球 太阳 火星 木星 水星 金星 土星 天王星 海王星 银河系 黑洞 相对论 量子力学 牛顿运动定律 生物学 光合作用 细胞 脱氧核糖核酸 演化论 生态系统 板块构造论 地震 气候变化 水 碳 氧 原子 电子 物理学 化学 数学 概率论 热力学 免疫系统',
geography:'北京 上海 广州 南京 成都 杭州 西安 武汉 苏州 重庆 天津 香港 澳门 台北 长江 黄河 珠穆朗玛峰 喜马拉雅山脉 撒哈拉沙漠 亚马逊河 尼罗河 太平洋 大西洋 印度洋 北冰洋 南极洲 亚洲 欧洲 非洲 北美洲 南美洲 澳大利亚 日本 印度 巴西',
biography:'爱因斯坦 牛顿 达尔文 居里夫人 伽利略 约翰内斯·开普勒 哥白尼 麦克斯韦 尼古拉·特斯拉 爱迪生 莱昂哈德·欧拉 阿基米德 阿兰·图灵 克劳德·香农 路易·巴斯德 孟德尔 孔子 司马迁 李白 杜甫 苏轼 王羲之 李时珍 徐霞客 郑和 莎士比亚 列夫·托尔斯泰 歌德 贝多芬 莫扎特 巴赫 列奥纳多·达·芬奇 米开朗琪罗 文森特·梵高 拉斐尔',
culture:'中国文学 中国书法 中国绘画 京剧 昆曲 中国象棋 围棋 茶 中国陶瓷 汉字 甲骨文 印刷术 造纸术 中秋节 春节 端午节 元宵节 清明节 中国建筑 故宫 颐和园 长城 敦煌莫高窟 龙门石窟 秦始皇陵 苏州园林 中国音乐 古琴 二胡 小提琴 交响乐 歌剧 爵士乐 摄影 电影',
technology:'计算机 互联网 万维网 操作系统 数据库 编程语言 算法 人工智能 机器学习 深度学习 密码学 计算机网络 计算机科学 集成电路 晶体管 半导体 光纤 激光 电动机 发动机 内燃机 蒸汽机 太阳能 风力发电 核能 电池 锂离子电池 电报 电话 无线电 雷达 卫星 航天飞机 高速铁路 航空器'
};
if(!process.argv.includes('--hc3-only')){
 const titleTopic={};for(const [topic,s]of Object.entries(topics))for(const t of s.split(' '))titleTopic[t]=topic;
 const wp=await snapshots(dir,'zh.wikipedia.org',Object.keys(titleTopic));
 await writeJson(path.join(dir,'wikipedia-pages.json'),wp.map(p=>({...p,topic:titleTopic[p.title]||'biography'})));
 await import('./fetch-news.mjs');
}
for(const [label,url,ext]of [
 ['hc3-card','https://huggingface.co/datasets/Hello-SimpleAI/HC3-Chinese/raw/main/README.md','md'],
 ['hc3-rights','https://raw.githubusercontent.com/Hello-SimpleAI/chatgpt-comparison-detection/main/README.md','md'],
 ['upstream-openqa','https://raw.githubusercontent.com/brightmart/nlp_chinese_corpus/master/README.md','md'],
 ['hc3-paper','https://arxiv.org/html/2301.07597','html'],
 ['finance-metadata','https://www.heywhale.com/api/datasets/5e9588f8e7ec38002d0331b1','json'],
 ['open_qa','https://huggingface.co/datasets/Hello-SimpleAI/HC3-Chinese/raw/main/open_qa.jsonl','jsonl'],
 ['finance','https://huggingface.co/datasets/Hello-SimpleAI/HC3-Chinese/raw/main/finance.jsonl','jsonl']
]){const raw=await original(dir,url,ext);await writeJson(path.join(dir,label+'-download.json'),{file:raw.file,sha256:raw.sha256,url:raw.url,retrieved_at:raw.retrieved_at});console.log('OPEN ORIGINAL',label,raw.bytes.length);}
await import('./fetch-psychology.mjs');
