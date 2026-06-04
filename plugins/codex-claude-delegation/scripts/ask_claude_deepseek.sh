#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
METRICS_DIR="${CODEX_DELEGATION_METRICS_DIR:-$HOME/.codex/metrics}"
LEDGER_PATH="${CODEX_DELEGATION_LEDGER:-$METRICS_DIR/delegation-ledger.jsonl}"
RUNS_DIR="$METRICS_DIR/delegation-runs"
MODEL="${CLAUDE_DELEGATION_MODEL:-}"
PRINT_LIMIT="${CLAUDE_DELEGATION_PRINT_LIMIT_CHARS:-12000}"
MAX_BUDGET_USD="${CLAUDE_DELEGATION_MAX_BUDGET_USD:-0.25}"
CLAUDE_BIN="${CLAUDE_DELEGATION_CLAUDE_BIN:-claude}"
TASK_TYPE="ad_hoc"
NOTES=""
CMD=""
FILES=()
GATE_JSON=""

usage() {
  cat <<'USAGE'
Usage:
  ask_claude_deepseek.sh [--task-type TYPE] [--notes TEXT] [--model MODEL] [--file PATH ...] [--cmd READ_ONLY_COMMAND]
  echo "large text" | ask_claude_deepseek.sh --task-type log_summary

Delegates read-only analysis to local Claude CLI, records estimated Codex token savings,
and renders ~/.codex/metrics/delegation-dashboard.html.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task-type)
      TASK_TYPE="${2:-ad_hoc}"
      shift 2
      ;;
    --notes)
      NOTES="${2:-}"
      shift 2
      ;;
    --model)
      MODEL="${2:-$MODEL}"
      shift 2
      ;;
    --file)
      FILES+=("${2:-}")
      shift 2
      ;;
    --cmd)
      CMD="${2:-}"
      shift 2
      ;;
    --print-limit)
      PRINT_LIMIT="${2:-$PRINT_LIMIT}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

mkdir -p "$RUNS_DIR"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
INPUT_FILE="$RUNS_DIR/$RUN_ID.input.txt"
PROMPT_FILE="$RUNS_DIR/$RUN_ID.prompt.txt"
OUTPUT_FILE="$RUNS_DIR/$RUN_ID.output.txt"
ERROR_FILE="$RUNS_DIR/$RUN_ID.error.txt"

append_file() {
  local file="$1"
  if [[ -z "$file" || ! -f "$file" ]]; then
    echo "[missing file] $file" >> "$INPUT_FILE"
    return 1
  fi
  {
    echo
    echo "===== FILE: $file ====="
    cat "$file"
  } >> "$INPUT_FILE"
}

: > "$INPUT_FILE"

if [[ ${#FILES[@]} -gt 0 ]]; then
  for file in "${FILES[@]}"; do
    append_file "$file" || true
  done
fi

if [[ -n "$CMD" ]]; then
  if ! GATE_JSON="$(node "$SCRIPT_DIR/delegation_gate.mjs" --cmd "$CMD" 2>"$ERROR_FILE")"; then
    echo "Delegation gate failed for command." >&2
    cat "$ERROR_FILE" >&2
    exit 2
  fi
  CAPTURED_OUTPUT_PATH="$(GATE_JSON="$GATE_JSON" node -e 'const r=JSON.parse(process.env.GATE_JSON); process.stdout.write(r.captured_output_path || "");')"
  if [[ -z "$CAPTURED_OUTPUT_PATH" || ! -f "$CAPTURED_OUTPUT_PATH" ]]; then
    echo "Gate did not produce a captured command output path." >&2
    echo "$GATE_JSON" >&2
    exit 2
  fi
  append_file "$CAPTURED_OUTPUT_PATH"
fi

if [[ ${#FILES[@]} -eq 0 && -z "$CMD" ]]; then
  cat > "$INPUT_FILE"
fi

cat > "$PROMPT_FILE" <<PROMPT
You are a read-only analysis helper running under Claude CLI.

Task type: $TASK_TYPE
Notes: $NOTES

Rules:
- Do not ask to modify files.
- Do not provide long verbatim copies of the input.
- The input may come from a local delegation artifact; do not infer that no files were created by the delegation wrapper.
- Return concise structured output with these headings:
  - finding
  - confidence
  - evidence
  - caveats
- Keep the answer under 1200 words unless the evidence requires more.

Input follows:

PROMPT
cat "$INPUT_FILE" >> "$PROMPT_FILE"

INPUT_EST="$(node "$SCRIPT_DIR/estimate_tokens.mjs" "$INPUT_FILE" 2>/dev/null || echo 0)"
STATUS="success"

if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
  echo "Claude CLI not found: $CLAUDE_BIN" > "$ERROR_FILE"
  cp "$ERROR_FILE" "$OUTPUT_FILE"
  STATUS="failed"
else
  CLAUDE_ARGS=(-p --max-budget-usd "$MAX_BUDGET_USD")
  if [[ -n "$MODEL" ]]; then
    CLAUDE_ARGS+=(--model "$MODEL")
  fi
  if [[ "${CLAUDE_DELEGATION_DISABLE_TOOLS:-1}" == "1" ]]; then
    CLAUDE_ARGS+=(--tools "")
  fi
  if [[ "${CLAUDE_DELEGATION_NO_SESSION:-1}" == "1" ]]; then
    CLAUDE_ARGS+=(--no-session-persistence)
  fi
  "$CLAUDE_BIN" "${CLAUDE_ARGS[@]}" < "$PROMPT_FILE" > "$OUTPUT_FILE" 2> "$ERROR_FILE"
  code=$?
  if [[ $code -ne 0 ]]; then
    STATUS="failed"
    if [[ ! -s "$OUTPUT_FILE" ]]; then
      cp "$ERROR_FILE" "$OUTPUT_FILE"
    fi
  fi
fi

OUTPUT_EST="$(node "$SCRIPT_DIR/estimate_tokens.mjs" "$OUTPUT_FILE" 2>/dev/null || echo 0)"
GATE_EST="$(GATE_JSON="$GATE_JSON" node -e 'const text=process.env.GATE_JSON||""; let c=0,o=0; for (const ch of text) { if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(ch)) c++; else if (!/\s/u.test(ch)) o++; } console.log(Math.ceil(c/1.6+o/4));' 2>/dev/null || echo 0)"
CODEX_INJECTED=$(( OUTPUT_EST + GATE_EST ))
if [[ "$STATUS" == "success" ]]; then
  SAVED=$(( INPUT_EST > CODEX_INJECTED ? INPUT_EST - CODEX_INJECTED : 0 ))
else
  SAVED=0
fi

if [[ "$INPUT_EST" -gt 0 ]]; then
  SAVED_RATIO="$(node -e "console.log(($SAVED / $INPUT_EST).toFixed(4))")"
else
  SAVED_RATIO="0"
fi

TASK_TYPE="$TASK_TYPE" MODEL="$MODEL" INPUT_EST="$INPUT_EST" OUTPUT_EST="$OUTPUT_EST" GATE_EST="$GATE_EST" CODEX_INJECTED="$CODEX_INJECTED" SAVED="$SAVED" SAVED_RATIO="$SAVED_RATIO" STATUS="$STATUS" NOTES="$NOTES" OUTPUT_FILE="$OUTPUT_FILE" LEDGER_PATH="$LEDGER_PATH" node <<'NODE'
const fs = require('fs');
const path = require('path');
const ledgerPath = process.env.LEDGER_PATH;
const record = {
  timestamp: new Date().toISOString(),
  thread_id: process.env.CODEX_THREAD_ID || 'codex-session',
  cwd: process.cwd(),
  task_type: process.env.TASK_TYPE || 'ad_hoc',
  model: process.env.MODEL || 'claude-default',
  raw_input_est_tokens: Number(process.env.INPUT_EST || 0),
  input_est_tokens: Number(process.env.INPUT_EST || 0),
  gate_json_est_tokens: Number(process.env.GATE_EST || 0),
  output_est_tokens: Number(process.env.OUTPUT_EST || 0),
  codex_injected_est_tokens: Number(process.env.CODEX_INJECTED || 0),
  codex_saved_est_tokens: Number(process.env.SAVED || 0),
  saved_ratio: Number(process.env.SAVED_RATIO || 0),
  status: process.env.STATUS || 'unknown',
  notes: process.env.NOTES || '',
  artifact_path: process.env.OUTPUT_FILE || '',
};
fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
fs.appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);
NODE

node "$SCRIPT_DIR/render_dashboard.mjs" >/dev/null 2>&1 || true

echo "[delegation] model=${MODEL:-claude-default} status=$STATUS input_est=$INPUT_EST codex_injected_est=$CODEX_INJECTED codex_saved_est=$SAVED saved_ratio=$SAVED_RATIO"
echo "[delegation] artifact=$OUTPUT_FILE"
echo

if [[ "$STATUS" != "success" ]]; then
  echo "Delegation failed. Error artifact: $ERROR_FILE"
  head -c "$PRINT_LIMIT" "$OUTPUT_FILE"
  echo
  exit 1
fi

OUTPUT_CHARS="$(wc -c < "$OUTPUT_FILE" | tr -d ' ')"
if [[ "$OUTPUT_CHARS" -gt "$PRINT_LIMIT" ]]; then
  echo "[delegation] claude_output_begin"
  head -c "$PRINT_LIMIT" "$OUTPUT_FILE"
  echo
  echo "[delegation] claude_output_end"
  echo
  echo "[delegation] output truncated at ${PRINT_LIMIT} chars; full output is in $OUTPUT_FILE"
else
  echo "[delegation] claude_output_begin"
  cat "$OUTPUT_FILE"
  echo
  echo "[delegation] claude_output_end"
fi
