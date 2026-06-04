---
name: claude-delegation
description: Delegate token-heavy read-only Codex work to local Claude CLI after a deterministic local gate. Use before Codex reads large files, directories, URLs, command outputs, logs, PRDs, Confluence exports, diffs, or broad review inputs.
---

# Claude Delegation

Use this skill when a task may require Codex to read large or accumulating context.

## Explicit Invocation

When the user explicitly invokes this plugin or says to use Claude delegation for the current input, skip the size-threshold decision and delegate supported read-only input directly:

```bash
node <plugin-root>/scripts/claude_delegate.mjs --file path/to/file.md --task-type explicit_delegate
node <plugin-root>/scripts/claude_delegate.mjs --path ./docs --task-type explicit_delegate
node <plugin-root>/scripts/claude_delegate.mjs --url https://example.com/prd --task-type explicit_delegate
node <plugin-root>/scripts/claude_delegate.mjs --cmd "git diff -- src" --task-type explicit_delegate
echo "inline content" | node <plugin-root>/scripts/claude_delegate.mjs --task-type explicit_delegate
```

Explicit invocation bypasses size thresholds only. It does not bypass safety blocks for secrets, unsafe commands, authenticated pages, unsupported binary formats, or sensitive personal data.

## Visible Result Contract

After running `claude_delegate.mjs` or `ask_claude_deepseek.sh`, Codex must surface the final Claude result in the user-facing response.

Use the content printed between:

```text
[delegation] claude_output_begin
...
[delegation] claude_output_end
```

User-facing responses should include:

- `Claude 处理结果`: the concise final Claude output, summarized only if it is too long.
- `Artifact`: the local output artifact path printed by the helper.
- `Metrics`: status and estimated token fields from the helper line when relevant.

Do not paste raw delegated input, full prompts, hidden helper prompt files, or sensitive local artifacts into the conversation. Claude internal reasoning is not available and must not be claimed.

## Mandatory Gates

Do not read suspected large content directly into Codex first. Run the deterministic gate and inspect only its short JSON output:

```bash
node <plugin-root>/scripts/delegation_gate.mjs --file path/to/file.md
node <plugin-root>/scripts/delegation_gate.mjs --path ./docs
node <plugin-root>/scripts/delegation_gate.mjs --url https://example.com/prd
node <plugin-root>/scripts/delegation_gate.mjs --cmd "git diff -- src"
```

Decision handling:

- `delegate`: run `scripts/ask_claude_deepseek.sh` with the original file or the gate artifact.
- `delegate_manifest`: run the helper on the manifest artifact rather than raw directory content.
- `local`: Codex may read the content directly.
- `unavailable`, `unsupported`, or `blocked`: explain the reason and do not force delegation.

Before starting another large read in a long thread, also run:

```bash
node <plugin-root>/scripts/context_budget_gate.mjs --json
```

If it returns `handoff` or `block_heavy_read`, refresh `.codex/delegation/context-state.md` and avoid pulling large raw input into Codex.

## Safety

- Delegate only read-only analysis.
- Do not delegate secrets, credentials, unredacted local config, personal data, sensitive screenshots, or authenticated pages.
- Claude output is advisory. Codex remains responsible for verification and final conclusions.
- Keep raw evidence in local artifacts; do not paste large artifacts into Codex unless the gate returns `local`.

## Metrics

The helper writes local metrics under `CODEX_DELEGATION_METRICS_DIR` or `~/.codex/metrics`:

- `delegation-ledger.jsonl`
- `delegation-dashboard.html`
- `delegation-runs/`

The saved-token numbers are estimates for Codex context avoided, not official billing records.
