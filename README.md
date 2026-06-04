# Codex Claude Delegation Marketplace

This repository is a Codex plugin marketplace source for the `codex-claude-delegation` plugin.

The plugin helps Codex avoid unnecessary context growth on large read-only inputs. It adds deterministic local gates for files, directories, URLs, command output, and accumulated task context, then delegates heavy read-only analysis to a local Claude CLI subprocess when delegation is useful.

Raw evidence stays on the local machine. Codex receives concise gate decisions, Claude summaries, artifact paths, and estimated token-saving metrics.

## Install

Requirements:

- Codex with plugin support.
- Node.js available as `node`.
- Claude CLI available as `claude`, or `CLAUDE_DELEGATION_CLAUDE_BIN` set to the Claude CLI path.
- Access to this GitHub repository.

Install the marketplace:

```bash
codex plugin marketplace add https://github.com/koeika/codex-claude-delegation --ref main
```

In the Codex plugin UI, this marketplace appears as `Sia Claude Delegation`. The CLI marketplace ID remains `claude-delegation-team`.

Install the plugin:

```bash
codex plugin add codex-claude-delegation@claude-delegation-team
```

Open a new Codex thread after installing so Codex can load the plugin skill instructions.

## Verify

From a clone of this repository:

```bash
plugins/codex-claude-delegation/scripts/preflight.sh
```

For local plugin validation:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  plugins/codex-claude-delegation

node plugins/codex-claude-delegation/scripts/test_plugin.mjs
```

## Usage

After installation, ask Codex to use `Codex Claude Delegation` before reading large files, directories, logs, diffs, PRDs, Confluence exports, or broad review inputs.

Typical explicit delegation commands:

```bash
node plugins/codex-claude-delegation/scripts/claude_delegate.mjs --file ./prd.md
node plugins/codex-claude-delegation/scripts/claude_delegate.mjs --path ./docs
node plugins/codex-claude-delegation/scripts/claude_delegate.mjs --url https://example.com/prd
node plugins/codex-claude-delegation/scripts/claude_delegate.mjs --cmd "git diff -- src"
node plugins/codex-claude-delegation/scripts/claude_delegate.mjs --session-id 019e87fa-375e-78f2-bd72-c9475587b34d
echo "content to summarize" | node plugins/codex-claude-delegation/scripts/claude_delegate.mjs
```

Explicit delegation bypasses size thresholds only. It does not bypass safety blocks for secrets, unsafe commands, authenticated pages, unsupported binary formats, or sensitive personal data.

For Codex session history, use `--session-id` or `--session-file`. Do not wrap `jq`, `sed`, or custom extraction commands in `--cmd`; complex command strings are intentionally blocked before Claude delegation. The session path extracts a text-only handoff locally, omits images and encrypted reasoning, then sends that smaller artifact to Claude.

Session extraction can be tuned with:

- `CODEX_SESSIONS_DIR`: override the session search root. Default: `~/.codex/sessions`.
- `CODEX_DELEGATION_SESSION_MAX_TEXT_CHARS`: max chars kept per text field. Default: `4000`.
- `CODEX_DELEGATION_SESSION_MAX_TOOL_CHARS`: max chars kept per tool call/output field. Default: `1200`.
- `CODEX_DELEGATION_SESSION_MAX_TOTAL_CHARS`: max chars kept in the generated session handoff. Default: `900000`.

## What Codex Should Show

The helper prints Claude's final result between markers:

```text
[delegation] claude_output_begin
...
[delegation] claude_output_end
```

Codex should relay that final result in the conversation, plus the output artifact path and useful metrics. Claude internal reasoning is not exposed.

## Automatic Gate

The plugin skill asks Codex to run a lightweight gate before reading suspected large content:

```bash
node plugins/codex-claude-delegation/scripts/delegation_gate.mjs --file ./prd.md
node plugins/codex-claude-delegation/scripts/delegation_gate.mjs --path ./docs
node plugins/codex-claude-delegation/scripts/delegation_gate.mjs --url https://example.com/prd
node plugins/codex-claude-delegation/scripts/delegation_gate.mjs --cmd "git diff -- src"
```

The gate prints short JSON only. It does not print raw file, directory, URL, or command output bodies.

Default delegation thresholds:

- File or sampled input: about 5k estimated tokens.
- Diff output: over about 300 lines.
- Log output: over about 200 lines.
- Review scope: more than 8 files.

## Image Payload Stripping

If a delegated input is estimated to exceed the Claude context limit, the helper first creates a no-image copy of the input and sends that smaller copy to Claude.

This is mainly for Codex session JSONL and browser/tool logs where screenshots may be stored as `data:image/*;base64,...`. Those payloads can be millions of tokenizer tokens even when the file is only a few megabytes. They are also not useful when the selected Claude CLI model is DeepSeek, because that path does not read images.

The helper also strips image payloads automatically when `--model` or `CLAUDE_DELEGATION_MODEL` contains `deepseek`.

Related environment variables:

- `CLAUDE_DELEGATION_CONTEXT_TOKEN_LIMIT`: context-size trigger for image stripping. Default: `1000000`.
- `CLAUDE_DELEGATION_STRIP_IMAGES`: `auto` by default. Use `always`/`1` to force stripping, or `never`/`0` to disable it.

## Metrics

Successful delegations append records to:

```text
~/.codex/metrics/delegation-ledger.jsonl
~/.codex/metrics/delegation-dashboard.html
~/.codex/metrics/delegation-runs/
```

Useful fields:

- `raw_input_est_tokens`: estimated tokens Codex avoided reading directly.
- `codex_injected_est_tokens`: estimated gate JSON and Claude summary tokens returned to Codex.
- `codex_saved_est_tokens`: estimated avoided Codex context tokens.
- `saved_ratio`: estimated saved ratio for that delegation.

These are workflow estimates, not official billing records.

The Claude CLI subprocess has a per-delegation budget cap. Default:

```text
CLAUDE_DELEGATION_MAX_BUDGET_USD=0.5
```

Override it per run when needed:

```bash
CLAUDE_DELEGATION_MAX_BUDGET_USD=1.0 \
  node plugins/codex-claude-delegation/scripts/claude_delegate.mjs --session-id <id>
```

## Update This Plugin

After changing plugin files, update the Codex cachebuster before publishing:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py \
  plugins/codex-claude-delegation
```

Validate:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  plugins/codex-claude-delegation

node plugins/codex-claude-delegation/scripts/test_plugin.mjs
```

Publish:

```bash
git add .agents plugins README.md
git commit -m "Update Codex Claude Delegation plugin"
git push
```

Users refresh with:

```bash
codex plugin marketplace upgrade claude-delegation-team
codex plugin add codex-claude-delegation@claude-delegation-team
```

Then open a new Codex thread.

## Repository Layout

```text
.agents/plugins/marketplace.json
plugins/codex-claude-delegation/
  .codex-plugin/plugin.json
  README.md
  scripts/
  skills/
  templates/
```

## Safety

- Do not delegate secrets, credentials, unredacted local config, sensitive screenshots, personal data, or authenticated pages.
- Command delegation only supports a strict read-only allowlist.
- Claude output is advisory. Codex remains responsible for final decisions, implementation, and verification.
