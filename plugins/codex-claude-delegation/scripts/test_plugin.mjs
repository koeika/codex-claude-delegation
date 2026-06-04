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

console.log(`ok ${tmp}`);
