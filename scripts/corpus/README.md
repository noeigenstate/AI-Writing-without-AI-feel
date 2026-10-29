# Pre-2021 human Chinese corpus tools

Extends the original Wikisource downloader, cache, cleaner, builder and validator.
Node 24 ESM, Python 3 standard library, and **local** npm dependencies `opencc-js`
and `parse5` in this directory. Application dependencies and the scorer are unused.
Downloaded data remains ignored under `data/corpus/`; do not commit it.

## Rebuild from the acquired cache

Run from the repository root in PowerShell:

```powershell
$env:NODE_USE_ENV_PROXY='1'
npm ci --prefix scripts/corpus --cache data/corpus/npm-cache --ignore-scripts --no-audit --no-fund
python scripts/corpus/verify-psychology.py
node scripts/corpus/build.mjs
node scripts/corpus/build-gov.mjs
node scripts/corpus/build-open.mjs
node scripts/corpus/check-validator.mjs
node scripts/corpus/validate.mjs
node scripts/corpus/report.mjs
```

`validate` prints one summary per subset and exits nonzero on **any** failure,
including cross-subset duplicates. `report` writes distribution tables to each
subset README and complete counts, acquisition commands and disk usage to
`data/corpus/report.json`. `counts.json`, `report.json`, `validation-summary.json`
and `validation-errors.json` live beside each manifest. Validation summaries bind
to the manifest SHA-256; reports do not present an outdated validation as current.

Optional `--subset=human-zh`, `--subset=human-zh-open` or
`--subset=human-zh-gov` validates only that subset, **without** cross-subset checks.
`--data-root=` is restricted to children of `data/corpus/` and supports the isolated
negative-check fixtures. `check-validator` confirms that bad hashes, cutoff dates,
missing issuers, invisible characters and traditional/simplified duplicates fail.
It never mutates corpus originals.

## Acquisition / resume

Run acquisition modes sequentially; each process owns its host-rate scheduler.
Successful requests are cached by URL and SHA-256. Existing pages, author evidence
and original EPUB files from the previous run are retained and reused.

```powershell
$env:NODE_USE_ENV_PROXY='1'
# Extend existing PD acquisition; do not rerun the original base mode unnecessarily.
node scripts/corpus/fetch.mjs --literary
node scripts/corpus/fetch.mjs --poetry
node scripts/corpus/fetch-pg.mjs
node scripts/corpus/archive-mirror.mjs
node scripts/corpus/fetch-scans.mjs

# Historical Wikipedia/Wikinews revisions and original HC3 files/evidence.
node scripts/corpus/fetch-open.mjs
# Narrow resume modes, if only a component needs more acquisition:
node scripts/corpus/fetch-open.mjs --hc3-only
node scripts/corpus/fetch-news.mjs
node scripts/corpus/fetch-psychology.mjs
python scripts/corpus/verify-psychology.py

# Official Gazette/State Council documents; the narrow modes preserve acquisitions.
node scripts/corpus/fetch-gov.mjs
node scripts/corpus/fetch-gov.mjs --reports-only
node scripts/corpus/fetch-gov.mjs --laws-only
```

Then run the offline build/validation/report commands above. `assemble-open.mjs`
can recover completed historical Wikinews responses after interruption. Its use is
optional: `fetch-news` persists the accumulated page list after every response.

The inherited `fetch.mjs --books` optionally exports missing Wikisource collections
through `https://ws-export.wmcloud.org/tool/book.php`; it excludes the Gutenberg and
Archive rows. EPUBs must have the ZIP signature and EPUB MIME type. The mandatory
original download is recorded in `raw_file`, independently of optional EPUB exports.
`raw-index.mjs` reconnects inherited page records to the original byte-cache response,
rather than inventing missing per-page original files.

All HTTP requests identify `SpeakPlainlyHumanCorpus/2.0`, start at least 1.2 seconds
apart per host and use bounded exponential backoff / Retry-After. MediaWiki has
`maxlag=5`, a 25-second timeout and three attempts; other downloads have a 90-second
timeout and five attempts. Wikinews acquisition uses two workers sharing one host
scheduler, so a slow response does not block every later article. Redirects must
stay on approved HTTPS hosts; login/captcha redirects are rejected. No account,
cookie, CAPTCHA service or court-login source is used. Failed/unusable acquisitions
are logged. The allowlist also permits public upstream dataset and licence evidence.

## Dataset contracts

**`human-zh`**: exactly 1,000 pieces; at least 40 distinct authors; verified death
year <=1975; <=60 pieces per author and <=10 per work; 300–5,000 Han characters;
vernacular prose or modern poetry; no translations or ambiguous coauthorship.
Commentary/speeches <=25%, fiction >=30%, prose/essays >=30%, with letters/diaries
and children's literature; modern poetry <=10%.

Each original stays in `texts/<id>.txt`. OpenCC writes a separate
`texts-simplified/<id>.txt`, with `script`, `simplified_file` and a second digest.
Conversion iterates to stability: the pinned converter can expose another phrase
match on a second pass (`屬於 -> 属於 -> 属于`). Original wording is not converted.
Names are simplified; `author_original` preserves source spelling. Work quota keys
also normalize Chinese script, preventing `老殘遊記` / `老残游记` double allowances.

A separately titled original essay/short story is a work; its containing volume is
`collection`. Newly acquired examples are the individually titled 空山靈雨 essays
and five stories in Gutenberg 25260. Numbered sections within a novel/story share
the ten-piece cap. This distinguishes independent literary works from chapters,
using the original's printed titles, rather than arbitrary paragraph windows.
Historical genre defaults are corrected for obvious literary criticism, memoirs,
letters and mixed prose/fiction bibliographies. Late-Qing vernacular novels are
included; classical-register passages are excluded. This is still a historical
sample, not a balanced sample of present-day informal Chinese.

Death evidence is a frozen Wikisource author revision/rendered header or Gutenberg
creator RDF. PD is evaluated in China as of 2026, with no claim for other countries.
`composition_not_after` is the author's death-year upper bound, not an invented
publication date. The year tables label this distinction explicitly.

The Archive source is its institutional Gutenberg collection's 2011 mirror of
豐收 (`pgcommunitytexts25260gut`). Original text, metadata, rights statement and
checksums are retained. The Chinese work, including punctuation, is identical to
Gutenberg after whitespace removal; front/back matter differs. Other institutional
Archive scans were investigated but excluded for severe OCR corruption.

**`human-zh-open`**: 600 pieces, with 200 Wikinews, 200 Wikipedia and 200 HC3 human
answers. All evaluation files are simplified and 300–5,000 Han characters. Each
row has an exact licence name/URL, attribution, dates, date basis and raw download.
OpenCC conversion, section/prose extraction and markup removal are declared changes.

- Wikinews: CC BY 2.5; pre-2021 publication date from the historical date template.
- Wikipedia: CC BY-SA 3.0 as applicable to the selected 2020 revision; six topic
  groups. Lists, tables, infoboxes, references, navboxes, media and unsupported
  inline-template paragraphs are excluded, and stubs are rejected.
- Both use the revision current at `2020-12-31T23:59:59Z`, via `rvstart`,
  `rvdir=older`, `rvlimit=1`. Historical revision selection requires a single title
  per MediaWiki query. Present-day template rendering is not used for their text.
- HC3: CC BY-SA 4.0, `human_answers` only. Finance's original public metadata has
  CC BY 4.0 and a final November 2020 update. Psychology's upstream is CC0 per HC3
  and AI Studio; all 5,220 human answers exactly match the original frozen at Git
  commit `cef85f0545925948a583d848f72750dd3363fc94`, dated May 5, 2020, ignoring
  whitespace. The original ZIP, commit metadata and per-answer coordinates remain
  local. Validation independently recomputes this proof using Python's standard
  library. The 2023 HC3 release date is never used as an answer's creation date.
- Excluded HC3 splits: `open_qa` (every answer below 300 Han), `baike` (no proven
  pre-2021 revision or upstream licence), `nlpcc_dbqa` and `law` (unknown upstream
  licences), `medicine` (stricter CC BY-NC). No short answers are concatenated.

**`human-zh-gov`**: 300 pieces: 100 State Council work-report excerpts from
2000–2020, 100 national-law/administrative-regulation excerpts, and 100 State
Council/ministry document excerpts. Source is official gov.cn text/Gazette versions.
Every row has an issuer, issue/signature date, document number if printed, raw HTML
and `license_basis="不适用著作权法：《著作权法》第五条"`. The official 2018 Constitution is
included. Chinese-numeral signatures are parsed; historical enactments mentioned in
repeal clauses are not mistaken for the current issue date. Versions with stated
effective dates in 2021 or later are excluded. Archived report-link 404s are logged;
the Gazette supplies available replacements.

## Cleaning, deduplication and limits

The inherited conservative cleaner removes wiki metadata and editorial notes;
unsupported markup is excluded. No invented OCR repair is applied. Longer literary
texts split only at explicit headings. Official sections can combine consecutive
whole statutory articles to reach the minimum; paragraphs are never truncated.
Placeholders, entities, invisible characters, standalone page numbers, bad hashes,
unsafe paths, absent provenance and dates at/after the cutoff fail validation.

The original NFKC/letter-number duplicate check and five-character shingle index
now also apply OpenCC equivalence. Jaccard >=0.8 or smaller-text containment >=0.9
with >=100 shared shingles rejects near-duplicates, within and across all three
subsets. Simplified copies are deliberate companions, not extra corpus pieces.

Genre/register and near-duplicate screening remain partly heuristic. Automated
checks and source samples were reviewed; the corpus has not been exhaustively
proofread. See per-subset exclusions and the report for these limits and counts.
