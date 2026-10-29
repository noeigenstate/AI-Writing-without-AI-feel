"""Prove HC3 human-answer dates by exact matches to the pinned May 2020 corpus.

Reads only public dataset originals. Generated-answer fields are not accessed.
The byte originals stay zipped; the small proof index contains only matched rows.
"""
import hashlib
import json
import pathlib
import re
import zipfile
import sys

BASE = pathlib.Path(__file__).resolve().parents[2] / 'data/corpus/human-zh-open'
def download(name):
    return json.loads((BASE / (name + '-download.json')).read_text(encoding='utf8'))
def compact(s):
    return re.sub(r'\s+', '', s)
hc3 = download('psychology')
answers = {}
for i, line in enumerate((BASE / hc3['file']).read_text(encoding='utf8').splitlines()):
    row = json.loads(line)
    for j, answer in enumerate(row.get('human_answers') or []):
        if isinstance(answer, str):
            answers.setdefault(compact(answer), []).append((i, j))
original = download('psychology-2020')
assert hashlib.sha256((BASE / original['file']).read_bytes()).hexdigest() == original['sha256'], 'Original ZIP digest mismatch'
commit_meta = download('psychology-2020-commits')
commits = json.loads((BASE / commit_meta['file']).read_text(encoding='utf8'))
assert commits[0]['sha'] == 'cef85f0545925948a583d848f72750dd3363fc94'
assert commits[0]['commit']['committer']['date'] == '2020-05-05T14:32:24Z'
proof = {}
with zipfile.ZipFile(BASE / original['file']) as archive:
    for member in archive.infolist():
        if not member.filename.endswith('.json'):
            continue
        with archive.open(member) as stream:
            data = json.load(stream)
        if isinstance(data, dict):
            data = list(data.values())
        for row_index, row in enumerate(data):
            for answer_index, answer in enumerate(row.get('answers_info') or row.get('answer_info') or []):
                text = answer.get('content')
                if not isinstance(text, str):
                    continue
                for i, j in answers.get(compact(text), []):
                    proof[f'{i}:{j}'] = {
                        'dataset_row': i, 'answer_index': j,
                        'upstream_member': member.filename,
                        'upstream_row': row_index, 'upstream_answer': answer_index,
                        'answer_sha256': hashlib.sha256(text.encode()).hexdigest(),
                        'comparison': 'Exact Unicode text after whitespace removal',
                    }
        del data
report = {
    'commit': 'cef85f0545925948a583d848f72750dd3363fc94',
    'commit_timestamp': '2020-05-05T14:32:24Z',
    'raw_file': original['file'], 'raw_sha256': original['sha256'],
    'matches': proof,
}
if '--check' in sys.argv:
    assert json.loads((BASE / 'psychology-date-proof.json').read_text(encoding='utf8')) == report, 'Psychology date-proof index mismatch'
else:
    (BASE / 'psychology-date-proof.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
print(f'HC3 psychology: {len(proof)} human answers exactly matched to May 2020 original')
