import fs from 'node:fs';
import path from 'node:path';
import { OUT, writeJSON } from './common.mjs';
import { createDocxFromBlocks } from '../../backend/src/services/docx.ts';

async function main() {
  const dir = path.join(OUT, 'check-fixtures');
  fs.mkdirSync(dir, { recursive: true });
  const blocks = [
    { type: 'paragraph' as const, kind: 'heading1' as const, text: '公开合成 DOCX 回归样例' },
    { type: 'paragraph' as const, kind: 'normal' as const, text: '这是一份评估工具生成的公开合成文档。用于检验分句、导出和重新解析。' },
    { type: 'paragraph' as const, kind: 'normal' as const, text: '同一句包含数字2020、引号“测试”与符号&。这段分成两句！最后一句有问号？' },
    { type: 'paragraph' as const, kind: 'list' as const, text: '项目一：段落和样式在往返处理中保留。' },
  ];
  fs.writeFileSync(path.join(dir, 'AI替你炒股_紧凑版.docx'), await createDocxFromBlocks(blocks));
  writeJSON(path.join(OUT, 'check-fixture-note.json'), {
    reason: 'User prohibits touching repository root/test/. Unchanged check.sh DOCX test is redirected by opt-in runtime shim to this synthetic public fixture; all original assertions still run.',
    fixture: 'data/eval/pilot/check-fixtures/AI替你炒股_紧凑版.docx',
    original_private_fixture_accessed: false,
    limitation: 'Round-trip coverage uses the synthetic fixture, not the private original; media and rejection assertions are unchanged.',
  });
  console.log(`Prepared public check fixture under ${dir}; root/test untouched.`);
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
