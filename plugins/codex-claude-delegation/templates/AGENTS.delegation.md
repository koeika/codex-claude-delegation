# Claude Delegation Rules

Before Codex reads a large PRD, Confluence export, log, diff, directory, URL, or broad review input, run the Claude delegation gate from the installed plugin.

Required behavior:

- Do not `cat` or paste suspected large content into Codex first.
- Run `delegation_gate.mjs` for file, directory, URL, and read-only command inputs.
- Only read the original content directly when the gate returns `local`.
- When the gate returns `delegate` or `delegate_manifest`, use `ask_claude_deepseek.sh` and inspect the concise Claude summary.
- If delegated JSONL/tool logs exceed the Claude context limit, strip image payloads first. DeepSeek through Claude CLI does not read images, and `data:image/*;base64` payloads can dominate the token count.
- For Codex session history, use `claude_delegate.mjs --session-id <id>` or `--session-file <jsonl>`. Do not delegate session extraction through `--cmd "jq ..."`; complex commands can be blocked before filtering runs.
- When a thread has accumulated many artifacts or prior summaries, run `context_budget_gate.mjs --json` before another large read.
- Treat Claude output as advisory. Verify important claims against source files or targeted excerpts.

Do not delegate secrets, credentials, unredacted config, personal data, sensitive screenshots, or authenticated pages.

Recommended memory boundary:

- Use Codex Memories for stable long-term preferences and recurring project facts.
- Use `.codex/delegation/context-state.md` only as short-term current-task state.
- Keep mandatory team rules in `AGENTS.md` or checked-in documentation.
