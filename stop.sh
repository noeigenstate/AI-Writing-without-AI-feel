#!/usr/bin/env bash
#
# Stop script for AI写作.
# Stops backend/frontend processes started from this checkout. The backend also
# has a port-based fallback for the default API port (8787).
#
# Usage:
#   ./stop.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

to_windows_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf ''
  fi
}

BACKEND_WIN="$(to_windows_path "$BACKEND")"
FRONTEND_WIN="$(to_windows_path "$FRONTEND")"

pids=()

add_pid() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  [[ "$pid" != "$$" ]] || return 0
  pids+=("$pid")
}

ps_output() {
  if ps -eo pid=,args= >/dev/null 2>&1; then
    ps -eo pid=,args=
  else
    ps -ef | awk 'NR > 1 { pid=$2; $1=$2=$3=$4=$5=$6=$7=""; sub(/^[[:space:]]+/, ""); print pid " " $0 }'
  fi
}

collect_project_pids() {
  local dir="$1"
  local win_dir="$2"
  shift 2
  local hints=("$@")

  while read -r pid args; do
    [[ -n "${pid:-}" && -n "${args:-}" ]] || continue
    if [[ "$args" != *"$dir"* && ( -z "$win_dir" || "$args" != *"$win_dir"* ) ]]; then
      continue
    fi
    for hint in "${hints[@]}"; do
      if [[ "$args" == *"$hint"* ]]; then
        add_pid "$pid"
        break
      fi
    done
  done < <(ps_output)
}

collect_port_pids() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    while read -r pid; do add_pid "$pid"; done < <(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)
  elif command -v fuser >/dev/null 2>&1; then
    for pid in $(fuser "$port/tcp" 2>/dev/null || true); do add_pid "$pid"; done
  fi
}

collect_project_pids "$BACKEND" "$BACKEND_WIN" "npm start" "tsx" "src/index.ts" "node_modules/tsx" "node_modules\\tsx"
collect_project_pids "$FRONTEND" "$FRONTEND_WIN" "npm run dev" "vite" "node_modules/vite" "node_modules\\vite"
collect_port_pids 8787

if ((${#pids[@]} == 0)); then
  echo "No matching AI写作 service processes were running."
  exit 0
fi

unique_pids=()
while read -r pid; do
  unique_pids+=("$pid")
done < <(printf '%s\n' "${pids[@]}" | sort -n -u)

echo "Stopping AI写作 services: ${unique_pids[*]}"
kill "${unique_pids[@]}" 2>/dev/null || true
sleep 1

for pid in "${unique_pids[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
done

echo "Done."
