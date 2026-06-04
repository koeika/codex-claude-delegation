# Codex Claude Delegation Marketplace

This repository is a Codex plugin marketplace source for the `codex-claude-delegation` plugin.

The plugin helps Codex avoid unnecessary context growth on large read-only inputs. It adds deterministic local gates for files, directories, URLs, command output, and accumulated task context, then delegates heavy read-only analysis to a local Claude CLI subprocess when delegation is useful.

Raw evidence stays on the local machine. Codex receives concise gate decisions, Claude summaries, artifact paths, and estimated token-saving metrics.

## Install

Requirements:

- Codex with plugin support.
- Node.js available as `node`.
- Claude CLI available as `claude`, or `CLAUDE_DELEGATION_CLAUDE_BIN` set to the Claude CLI path.
- Access to this Sea Group Git repository.

Install the marketplace:

```bash
codex plugin marketplace add https://git.garena.com/huixia.huang/claude-delegation --ref main
```

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
echo "content to summarize" | node plugins/codex-claude-delegation/scripts/claude_delegate.mjs
```

Explicit delegation bypasses size thresholds only. It does not bypass safety blocks for secrets, unsafe commands, authenticated pages, unsupported binary formats, or sensitive personal data.

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

