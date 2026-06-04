#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-claude-delegation-preflight.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "[preflight] plugin scripts: $SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "[preflight] failed: node is required" >&2
  exit 1
fi
echo "[preflight] node: $(node --version)"

CLAUDE_BIN="${CLAUDE_DELEGATION_CLAUDE_BIN:-claude}"
if command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
  echo "[preflight] claude: $(command -v "$CLAUDE_BIN")"
else
  echo "[preflight] warning: Claude CLI not found as '$CLAUDE_BIN'; delegation helper will fail until it is installed or CLAUDE_DELEGATION_CLAUDE_BIN is set"
fi

echo "short fixture" > "$TMP_DIR/small.txt"
CODEX_DELEGATION_GATE_DIR="$TMP_DIR/gate-runs" node "$SCRIPT_DIR/delegation_gate.mjs" --file "$TMP_DIR/small.txt" >"$TMP_DIR/small.json"
if ! grep -q '"decision":"local"' "$TMP_DIR/small.json"; then
  echo "[preflight] failed: small file gate did not return local" >&2
  cat "$TMP_DIR/small.json" >&2
  exit 1
fi
echo "[preflight] gate small-file check passed"

python3 - <<'PY' > "$TMP_DIR/large.txt"
print("large fixture " * 12000)
PY
CODEX_DELEGATION_GATE_DIR="$TMP_DIR/gate-runs" node "$SCRIPT_DIR/delegation_gate.mjs" --file "$TMP_DIR/large.txt" >"$TMP_DIR/large.json"
if ! grep -q '"decision":"delegate"' "$TMP_DIR/large.json"; then
  echo "[preflight] failed: large file gate did not return delegate" >&2
  cat "$TMP_DIR/large.json" >&2
  exit 1
fi
echo "[preflight] gate large-file check passed"

CODEX_DELEGATION_STATE_DIR="$TMP_DIR/state" CODEX_DELEGATION_GATE_DIR="$TMP_DIR/gate-runs" CODEX_DELEGATION_METRICS_DIR="$TMP_DIR/metrics" node "$SCRIPT_DIR/context_budget_gate.mjs" --json >"$TMP_DIR/budget.json"
echo "[preflight] context budget gate check passed"

CODEX_DELEGATION_METRICS_DIR="${CODEX_DELEGATION_METRICS_DIR:-$TMP_DIR/metrics}" node "$SCRIPT_DIR/render_dashboard.mjs" >"$TMP_DIR/dashboard-path.txt"
echo "[preflight] dashboard render check passed"

echo "[preflight] ready"
