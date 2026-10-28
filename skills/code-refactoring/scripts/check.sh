#!/usr/bin/env bash
# Usage (from the repo root): bash skills/code-refactoring/scripts/check.sh <label> [log-dir]
# Type-checks and builds both packages and runs every offline test; prints one line per check
# and exits non-zero if any check failed. Logs go to <log-dir> (default: $TMPDIR/speak-plainly-checks-<label>).
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LABEL="${1:-run}"
LOGDIR="${2:-${TMPDIR:-/tmp}/speak-plainly-checks-$LABEL}"
mkdir -p "$LOGDIR"
FAILED=0

run() {
  local name="$1"; shift
  local t0; t0=$(date +%s)
  ( "$@" ) > "$LOGDIR/$name.log" 2>&1
  local rc=$?
  [ "$rc" -eq 0 ] || FAILED=1
  echo "$name rc=$rc $(( $(date +%s) - t0 ))s"
}

cd "$ROOT/backend"
run backend-tsc npx tsc -p tsconfig.json --noEmit
for t in docx splitter protect article less-ai-tone novel research evidence-pipeline research-security \
  licensed-media http-security app-security gzh-security score; do
  run "backend-$t" timeout 600 npx tsx "src/scripts/test-$t.ts"
done

cd "$ROOT/frontend"
run frontend-tsc npx tsc -p tsconfig.json --noEmit
run frontend-vite timeout 300 npx vite build --outDir "$LOGDIR/vite-out" --emptyOutDir
for t in test/*.test.mjs; do run "frontend-$(basename "$t" .mjs)" timeout 300 node "$t"; done

echo "logs: $LOGDIR"
exit "$FAILED"
