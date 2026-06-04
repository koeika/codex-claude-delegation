#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const pluginRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const scripts = path.join(pluginRoot, 'scripts');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-claude-delegation-test-'));

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [path.join(scripts, args[0]), ...args.slice(1)], {
    cwd: tmp,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_DELEGATION_GATE_DIR: path.join(tmp, '.codex', 'delegation', 'gate-runs'),
      CODEX_DELEGATION_METRICS_DIR: path.join(tmp, 'metrics'),
      ...options.env,
    },
  });
  if (result.status !== 0) {
    throw new Error(`${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function runShell(args, options = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: tmp,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_DELEGATION_GATE_DIR: path.join(tmp, '.codex', 'delegation', 'gate-runs'),
      CODEX_DELEGATION_METRICS_DIR: path.join(tmp, 'metrics'),
      ...options.env,
    },
  });
  if (result.status !== 0) {
    throw new Error(`${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

fs.writeFileSync(path.join(tmp, 'small.txt'), 'hello\n');
let out = JSON.parse(run(['delegation_gate.mjs', '--file', 'small.txt']));
assert(out.decision === 'local', 'small file should be local');
assert(!JSON.stringify(out).includes('hello'), 'gate stdout must not include file body');

fs.writeFileSync(path.join(tmp, 'large.txt'), 'large fixture '.repeat(12000));
out = JSON.parse(run(['delegation_gate.mjs', '--file', 'large.txt']));
assert(out.decision === 'delegate', 'large file should delegate');
assert(fs.existsSync(out.artifact), 'large file artifact should exist');

fs.mkdirSync(path.join(tmp, 'docs'));
for (let i = 0; i < 10; i += 1) {
  fs.writeFileSync(path.join(tmp, 'docs', `file-${i}.md`), `# File ${i}\ncontent\n`);
}
out = JSON.parse(run(['delegation_gate.mjs', '--path', 'docs']));
assert(out.decision === 'delegate', 'multi-file directory should delegate');

out = JSON.parse(run(['delegation_gate.mjs', '--cmd', 'rm -rf /']));
assert(out.decision === 'blocked', 'unsafe command should be blocked');

out = JSON.parse(run(['context_budget_gate.mjs', '--json']));
assert(['ok', 'summarize', 'handoff', 'block_heavy_read', 'delegate'].includes(out.decision), 'context budget decision should be known');

out = JSON.parse(run(['claude_delegate.mjs', '--file', 'small.txt', '--prepare-only']));
assert(out.decision === 'delegate', 'explicit file delegation should force delegate');
assert(out.source_type === 'file', 'explicit file delegation should preserve file source type');

let shellOut = runShell([
  path.join(scripts, 'ask_claude_deepseek.sh'),
  '--file',
  'small.txt',
], {
  env: {
    CLAUDE_DELEGATION_CLAUDE_BIN: '/bin/echo',
  },
});
assert(shellOut.includes('max_budget_usd=none'), 'default Claude delegation should not set a budget cap');
assert(!shellOut.includes('--max-budget-usd'), 'default Claude command should not include --max-budget-usd');

shellOut = runShell([
  path.join(scripts, 'ask_claude_deepseek.sh'),
  '--file',
  'small.txt',
], {
  env: {
    CLAUDE_DELEGATION_CLAUDE_BIN: '/bin/echo',
    CLAUDE_DELEGATION_MAX_BUDGET_USD: '0.75',
  },
});
assert(shellOut.includes('max_budget_usd=0.75'), 'explicit Claude delegation budget should be recorded');
assert(shellOut.includes('--max-budget-usd 0.75'), 'explicit Claude command should include --max-budget-usd');

out = JSON.parse(run(['claude_delegate.mjs', '--path', 'docs', '--prepare-only']));
assert(out.decision === 'delegate', 'explicit directory delegation should force delegate');
assert(fs.existsSync(out.prepared_file), 'explicit directory delegation should prepare a bundle file');

const imagePayload = `data:image/png;base64,${'Aa0/'.repeat(2048)}`;
fs.writeFileSync(path.join(tmp, 'session.jsonl'), `${JSON.stringify({
  type: 'message',
  content: [
    { type: 'input_text', text: 'keep this text' },
    { type: 'input_image', image_url: imagePayload },
  ],
})}\n`);
out = JSON.parse(run([
  'sanitize_delegation_input.mjs',
  '--input',
  'session.jsonl',
  '--output',
  'session.no-images.jsonl',
  '--report',
  'sanitize-report.json',
]));
assert(out.removed_items > 0, 'sanitizer should remove image payloads');
const sanitized = fs.readFileSync(path.join(tmp, 'session.no-images.jsonl'), 'utf8');
assert(sanitized.includes('keep this text'), 'sanitizer should preserve text content');
assert(!sanitized.includes('data:image/png;base64'), 'sanitizer should remove data image URIs');
assert(sanitized.includes('image-data-uri-removed'), 'sanitizer should leave an image placeholder');

const sessionId = '019test-session';
const sessionsDir = path.join(tmp, 'sessions', '2026', '06', '04');
fs.mkdirSync(sessionsDir, { recursive: true });
const sessionFile = path.join(sessionsDir, `rollout-2026-06-04T12-00-00-${sessionId}.jsonl`);
fs.writeFileSync(sessionFile, [
  JSON.stringify({ timestamp: '2026-06-04T00:00:00Z', type: 'session_meta', payload: { id: sessionId, cwd: tmp, originator: 'test' } }),
  JSON.stringify({ timestamp: '2026-06-04T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'session user text' }, { type: 'input_image', image_url: imagePayload }] } }),
  JSON.stringify({ timestamp: '2026-06-04T00:00:02Z', type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'x'.repeat(4096), summary: [] } }),
  JSON.stringify({ timestamp: '2026-06-04T00:00:03Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'tool output text' } }),
].join('\n'));

out = JSON.parse(run([
  'extract_codex_session.mjs',
  '--session-file',
  sessionFile,
  '--output',
  'session.extract.txt',
  '--report',
  'session.extract.json',
]));
assert(out.output_est_tokens > 0, 'session extractor should produce text output');
const sessionExtract = fs.readFileSync(path.join(tmp, 'session.extract.txt'), 'utf8');
assert(sessionExtract.includes('session user text'), 'session extractor should preserve user text');
assert(sessionExtract.includes('tool output text'), 'session extractor should preserve tool output text');
assert(!sessionExtract.includes('data:image/png;base64'), 'session extractor should omit image payloads');
assert(!sessionExtract.includes('encrypted_content'), 'session extractor should omit encrypted content');

out = JSON.parse(run(['claude_delegate.mjs', '--session-id', sessionId, '--prepare-only'], {
  env: { CODEX_SESSIONS_DIR: path.join(tmp, 'sessions') },
}));
assert(out.decision === 'delegate', 'explicit session delegation should force delegate');
assert(out.source_type === 'session', 'session delegation should use session source type');
assert(fs.existsSync(out.prepared_file), 'session delegation should prepare a text handoff file');
const preparedSession = fs.readFileSync(out.prepared_file, 'utf8');
assert(preparedSession.includes('session user text'), 'prepared session should include user text');
assert(!preparedSession.includes('data:image/png;base64'), 'prepared session should not include image payloads');

console.log(`ok ${tmp}`);
