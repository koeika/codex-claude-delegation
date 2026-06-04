# Codex Claude Delegation

Codex Claude Delegation is a Codex plugin for avoiding unnecessary Codex context growth on large read-only inputs. It adds deterministic local gates for files, directories, URLs, command output, and accumulated task context, then delegates heavy read-only analysis to a local Claude CLI subprocess when the gate says it is worth it.

The plugin is intentionally local-first. Raw evidence stays in local artifacts; Codex sees short JSON decisions, concise Claude summaries, and small task-state files.

## Requirements

- Codex with plugin support.
- Node.js available as `node`.
- Claude CLI available as `claude`, or set `CLAUDE_DELEGATION_CLAUDE_BIN`.

Run:

```bash
plugins/codex-claude-delegation/scripts/preflight.sh
```

## Install From This Marketplace Repo

From a shared Git repository containing this folder layout:

```text
.agents/plugins/marketplace.json
plugins/codex-claude-delegation/
```

install the marketplace:

```bash
codex plugin marketplace add https://git.garena.com/huixia.huang/claude-delegation --ref main
```

In the Codex plugin UI, this marketplace appears as `Sia Claude Delegation`. The CLI marketplace ID remains `claude-delegation-team`.

Then install the plugin:

```bash
codex plugin add codex-claude-delegation@claude-delegation-team
```

Open a new Codex thread after install so Codex can load the new skill instructions.

## Usage

### Explicit Delegation

When you explicitly ask Codex to use this plugin, the preferred entrypoint is:

```bash
node plugins/codex-claude-delegation/scripts/claude_delegate.mjs --file ./prd.md
node plugins/codex-claude-delegation/scripts/claude_delegate.mjs --path ./docs
node plugins/codex-claude-delegation/scripts/claude_delegate.mjs --url https://example.com/prd
node plugins/codex-claude-delegation/scripts/claude_delegate.mjs --cmd "git diff -- src"
echo "content to summarize" | node plugins/codex-claude-delegation/scripts/claude_delegate.mjs
```

This path bypasses size-threshold decisions and sends supported read-only input to Claude CLI. Safety blocks still apply: no secrets, unsafe commands, authenticated pages, unsupported binary formats, or sensitive personal data.

Directory and URL inputs are first copied into a local artifact under `.codex/delegation/force-runs/`; Codex sees only the concise Claude result and local artifact paths.

### What Appears In Codex

The helper prints Claude's final result to stdout between markers:

```text
[delegation] claude_output_begin
...
[delegation] claude_output_end
```

Codex should relay that marked final result back into the conversation as `Claude 处理结果`, along with the output artifact path and useful metrics. The plugin does not expose Claude internal reasoning, and it does not paste raw delegated input back into the conversation by default.

### Automatic Gate

The skill instructs Codex to run a gate before reading suspected large content:

```bash
node plugins/codex-claude-delegation/scripts/delegation_gate.mjs --file ./prd.md
node plugins/codex-claude-delegation/scripts/delegation_gate.mjs --path ./docs
node plugins/codex-claude-delegation/scripts/delegation_gate.mjs --url https://example.com/prd
node plugins/codex-claude-delegation/scripts/delegation_gate.mjs --cmd "git diff -- src"
```

The gate returns short JSON:

```json
{"decision":"delegate","input_type":"file","reason":"estimated_tokens=8200 >= threshold=5000","estimated_tokens":8200,"artifact":".codex/delegation/gate-runs/...json"}
```

If the decision is `delegate`, run:

```bash
plugins/codex-claude-delegation/scripts/ask_claude_deepseek.sh --task-type document_summary --file ./prd.md
```

For long threads, Codex can also run:

```bash
node plugins/codex-claude-delegation/scripts/context_budget_gate.mjs --json
```

## Metrics

The helper writes:

```text
~/.codex/metrics/delegation-ledger.jsonl
~/.codex/metrics/delegation-dashboard.html
~/.codex/metrics/delegation-runs/
```

Important metrics:

- `raw_input_est_tokens`: estimated tokens Codex avoided reading directly.
- `codex_injected_est_tokens`: estimated gate JSON and Claude summary tokens injected back into Codex.
- `codex_saved_est_tokens`: estimated avoided Codex context tokens.
- `saved_ratio`: estimated saved ratio for that delegation.

These are workflow estimates, not official billing records.

## Team AGENTS.md Snippet

Copy `templates/AGENTS.delegation.md` into a project `AGENTS.md` when you want stronger repo-level enforcement.

## Configuration

Environment variables:

- `CLAUDE_DELEGATION_MODEL`
- `CLAUDE_DELEGATION_CLAUDE_BIN`
- `CLAUDE_DELEGATION_MAX_BUDGET_USD`
- `CLAUDE_DELEGATION_PRINT_LIMIT_CHARS`
- `CODEX_DELEGATION_METRICS_DIR`
- `CODEX_DELEGATION_GATE_DIR`
- `CODEX_DELEGATION_TOKEN_THRESHOLD`
- `CODEX_DELEGATION_DIFF_LINE_THRESHOLD`
- `CODEX_DELEGATION_LOG_LINE_THRESHOLD`
- `CODEX_DELEGATION_FILE_COUNT_THRESHOLD`
- `CODEX_DELEGATION_CONTEXT_SUMMARIZE_THRESHOLD`
- `CODEX_DELEGATION_CONTEXT_HANDOFF_THRESHOLD`
- `CODEX_DELEGATION_CONTEXT_BLOCK_THRESHOLD`
- `CODEX_DELEGATION_FORCE_MAX_BYTES`
- `CODEX_DELEGATION_FORCE_DIR`

If `CLAUDE_DELEGATION_MODEL` is unset, the helper lets Claude CLI use the user's configured default model.

## Safety

- The gate must not print raw file, directory, URL, or command output bodies.
- Command delegation only supports a strict read-only allowlist.
- Do not delegate secrets, credentials, personal data, sensitive screenshots, or authenticated pages.
- Claude output is advisory. Codex remains responsible for final verification.

## Memory Boundary

This plugin does not write Codex official Memories under `~/.codex/memories/`.

- Codex Memories: long-term preferences, recurring project facts, stable pitfalls.
- `AGENTS.md`: mandatory team rules.
- `.codex/delegation/context-state.md`: short-term current-task state.
