#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { estimateTokens } from './estimate_tokens.mjs';

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const cwd = process.cwd();
const artifactDir = path.resolve(process.env.CODEX_DELEGATION_FORCE_DIR || path.join(cwd, '.codex', 'delegation', 'force-runs'));
const forceMaxBytes = Number(process.env.CODEX_DELEGATION_FORCE_MAX_BYTES || 1024 * 1024);
const httpMaxBytes = Number(process.env.CODEX_DELEGATION_HTTP_MAX_BYTES || forceMaxBytes);

const excludedDirNames = new Set([
  '.cache', '.git', '.hg', '.next', '.nuxt', '.parcel-cache', '.pnpm-store',
  '.svn', '.turbo', 'build', 'coverage', 'dist', 'node_modules', 'out', 'target',
]);

const textExtensions = new Set([
  '.c', '.cc', '.conf', '.cpp', '.cs', '.css', '.csv', '.go', '.h', '.hpp', '.html',
  '.java', '.js', '.json', '.jsx', '.kt', '.less', '.log', '.lua', '.md', '.mjs',
  '.php', '.properties', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.swift',
  '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml',
]);

const binaryExtensions = new Set([
  '.7z', '.avif', '.bmp', '.class', '.dmg', '.doc', '.docx', '.exe', '.gif', '.gz',
  '.ico', '.jar', '.jpeg', '.jpg', '.lockb', '.mov', '.mp3', '.mp4', '.pdf', '.png',
  '.ppt', '.pptx', '.so', '.tar', '.webp', '.xls', '.xlsx', '.zip',
]);

function parseArgs(argv) {
  const args = { taskType: 'explicit_delegate', notes: '', prepareOnly: false, pretty: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file' || arg === '--path' || arg === '--url' || arg === '--cmd' || arg === '--text') {
      args[arg.slice(2)] = argv[++i];
    } else if (arg === '--session-id') {
      args.sessionId = argv[++i];
    } else if (arg === '--session-file') {
      args.sessionFile = argv[++i];
    } else if (arg === '--task-type') {
      args.taskType = argv[++i] || args.taskType;
    } else if (arg === '--notes') {
      args.notes = argv[++i] || '';
    } else if (arg === '--prepare-only') {
      args.prepareOnly = true;
    } else if (arg === '--pretty') {
      args.pretty = true;
    } else if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return `Usage:
  claude_delegate.mjs --file <path> [--task-type TYPE]
  claude_delegate.mjs --path <directory> [--task-type TYPE]
  claude_delegate.mjs --url <http-url> [--task-type TYPE]
  claude_delegate.mjs --cmd "<read-only command>" [--task-type TYPE]
  claude_delegate.mjs --session-id <codex-session-id> [--task-type TYPE]
  claude_delegate.mjs --session-file ~/.codex/sessions/...jsonl [--task-type TYPE]
  claude_delegate.mjs --text "content" [--task-type TYPE]
  echo "content" | claude_delegate.mjs [--task-type TYPE]

Explicitly delegates supported read-only input to Claude CLI. Safety blocks still apply.
`;
}

function ensureArtifactDir() {
  fs.mkdirSync(artifactDir, { recursive: true });
}

function runId() {
  return `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

function artifactPath(id, suffix) {
  ensureArtifactDir();
  return path.join(artifactDir, `${id}${suffix}`);
}

function relOrAbs(value) {
  const absolute = path.resolve(value);
  return path.relative(cwd, absolute) || '.';
}

function isProbablyBinaryBuffer(buffer) {
  if (!buffer || buffer.length === 0) return false;
  return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

function shouldIncludeFile(file) {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file).toLowerCase();
  if (binaryExtensions.has(ext)) return false;
  if (base === 'package-lock.json' || base === 'yarn.lock' || base === 'pnpm-lock.yaml') return false;
  if (textExtensions.has(ext)) return true;
  return ext === '' && !base.includes('.');
}

function walkDirectory(root, files = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirNames.has(entry.name)) walkDirectory(full, files);
    } else if (entry.isFile() && shouldIncludeFile(full)) {
      files.push(full);
    }
  }
  return files;
}

function readSafeTextFile(file, remainingBytes = forceMaxBytes) {
  const stat = fs.statSync(file);
  const bytesToRead = Math.min(stat.size, remainingBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, 0);
    if (isProbablyBinaryBuffer(buffer)) return { binary: true, text: '', bytes: stat.size, truncated: false };
    return {
      binary: false,
      text: buffer.toString('utf8'),
      bytes: stat.size,
      truncated: stat.size > bytesToRead,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function prepareText(text, label = 'inline-text') {
  const id = runId();
  const preparedFile = artifactPath(id, '.input.txt');
  const body = [
    `===== ${label} =====`,
    String(text || ''),
    '',
  ].join('\n');
  fs.writeFileSync(preparedFile, body);
  return {
    source_type: 'text',
    prepared_file: preparedFile,
    estimated_tokens: estimateTokens(body),
    truncated: false,
  };
}

function prepareSession(args) {
  const id = runId();
  const preparedFile = artifactPath(id, '.session-text.txt');
  const reportFile = artifactPath(id, '.session-report.json');
  const extractor = path.join(scriptDir, 'extract_codex_session.mjs');
  const extractorArgs = [extractor, '--output', preparedFile, '--report', reportFile];
  if (args.sessionId) extractorArgs.push('--session-id', args.sessionId);
  else extractorArgs.push('--session-file', args.sessionFile);
  const result = spawnSync(process.execPath, extractorArgs, {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`session extraction failed: ${result.stderr || result.stdout}`);
  }
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  return {
    source_type: 'session',
    prepared_file: preparedFile,
    report_file: reportFile,
    session_file: report.session_file,
    estimated_tokens: report.output_est_tokens || estimateTokens(fs.readFileSync(preparedFile, 'utf8')),
    lines_seen: report.lines_seen || 0,
    lines_extracted: report.lines_extracted || 0,
    image_payloads_omitted: report.image_payloads_omitted || 0,
    encrypted_fields_omitted: report.encrypted_fields_omitted || 0,
    truncated: report.truncated_fields > 0,
  };
}

function prepareFile(file) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`file does not exist: ${file}`);
  }
  const ext = path.extname(absolute).toLowerCase();
  if (binaryExtensions.has(ext)) {
    throw new Error(`unsupported binary extension for explicit delegation: ${ext}`);
  }
  const sample = readSafeTextFile(absolute, Math.min(forceMaxBytes, 64 * 1024));
  if (sample.binary) {
    throw new Error('binary content detected; explicit delegation blocked');
  }
  return {
    source_type: 'file',
    prepared_file: absolute,
    estimated_tokens: Math.ceil(fs.statSync(absolute).size / 4),
    truncated: false,
  };
}

function prepareDirectory(dir) {
  const absolute = path.resolve(dir);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    throw new Error(`directory does not exist: ${dir}`);
  }
  const id = runId();
  const preparedFile = artifactPath(id, '.directory-bundle.txt');
  const manifestFile = artifactPath(id, '.manifest.json');
  const files = walkDirectory(absolute);
  const included = [];
  const omitted = [];
  let usedBytes = 0;
  const chunks = [
    `===== DIRECTORY: ${relOrAbs(absolute)} =====`,
    `Force delegation bundle. Max bytes: ${forceMaxBytes}`,
    '',
  ];

  for (const file of files) {
    if (usedBytes >= forceMaxBytes) {
      omitted.push({ path: relOrAbs(file), reason: 'force max bytes reached' });
      continue;
    }
    const remaining = forceMaxBytes - usedBytes;
    const item = readSafeTextFile(file, remaining);
    if (item.binary) {
      omitted.push({ path: relOrAbs(file), reason: 'binary content detected' });
      continue;
    }
    chunks.push(`\n===== FILE: ${relOrAbs(file)} =====\n${item.text}\n`);
    usedBytes += Buffer.byteLength(item.text);
    included.push({
      path: relOrAbs(file),
      bytes: item.bytes,
      included_bytes: Buffer.byteLength(item.text),
      truncated: item.truncated,
    });
    if (item.truncated) {
      omitted.push({ path: relOrAbs(file), reason: 'file truncated by force max bytes' });
    }
  }

  const body = chunks.join('\n');
  fs.writeFileSync(preparedFile, body);
  fs.writeFileSync(manifestFile, `${JSON.stringify({
    source_type: 'directory',
    directory: relOrAbs(absolute),
    prepared_file: preparedFile,
    included,
    omitted,
    excluded_dirs: [...excludedDirNames].sort(),
    force_max_bytes: forceMaxBytes,
    estimated_tokens: estimateTokens(body),
  }, null, 2)}\n`);
  return {
    source_type: 'directory',
    prepared_file: preparedFile,
    manifest_file: manifestFile,
    estimated_tokens: estimateTokens(body),
    included_files: included.length,
    omitted_files: omitted.length,
    truncated: omitted.length > 0,
  };
}

function looksLikeAuthPage(text) {
  return /sign\s*in|log\s*in|password|sso|oauth|unauthorized|forbidden/i.test(text.slice(0, 4096));
}

async function prepareUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('only http and https URLs are supported');
  }

  const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  const contentType = head.headers.get('content-type') || '';
  if (head.status === 401 || head.status === 403) {
    throw new Error(`URL unavailable: HTTP ${head.status}`);
  }
  if (/\b(pdf|msword|officedocument|zip|image|audio|video)\b/i.test(contentType)) {
    throw new Error(`unsupported content-type for explicit delegation: ${contentType}`);
  }

  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: { range: `bytes=0-${httpMaxBytes - 1}` },
  });
  const buffer = Buffer.from(await response.arrayBuffer()).subarray(0, httpMaxBytes);
  const text = buffer.toString('utf8');
  if (looksLikeAuthPage(text)) {
    throw new Error('login or authorization page detected; explicit delegation blocked');
  }
  const id = runId();
  const preparedFile = artifactPath(id, '.url.txt');
  const body = [
    `===== URL: ${url} =====`,
    `Status: ${response.status}`,
    `Content-Type: ${response.headers.get('content-type') || contentType}`,
    `Sampled-Bytes: ${buffer.length}`,
    '',
    text,
  ].join('\n');
  fs.writeFileSync(preparedFile, body);
  return {
    source_type: 'url',
    prepared_file: preparedFile,
    estimated_tokens: estimateTokens(body),
    sampled_bytes: buffer.length,
    truncated: Number(head.headers.get('content-length') || 0) > buffer.length,
  };
}

function readStdinIfAvailable() {
  if (process.stdin.isTTY) return '';
  return fs.readFileSync(0, 'utf8');
}

function runHelper(args, prepared) {
  const helper = path.join(scriptDir, 'ask_claude_deepseek.sh');
  const helperArgs = ['--task-type', args.taskType];
  if (args.notes) helperArgs.push('--notes', args.notes);
  if (prepared.source_type === 'command') {
    helperArgs.push('--cmd', args.cmd);
  } else {
    helperArgs.push('--file', prepared.prepared_file);
  }
  const result = spawnSync(helper, helperArgs, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

async function prepare(args) {
  const stdinText = !args.file && !args.path && !args.url && !args.cmd && !args.text && !args.sessionId && !args.sessionFile ? readStdinIfAvailable() : '';
  const selected = ['file', 'path', 'url', 'cmd', 'text', 'sessionId', 'sessionFile'].filter((key) => args[key]);
  if (stdinText) selected.push('stdin');
  if (selected.length !== 1) {
    throw new Error('Provide exactly one input source: --file, --path, --url, --cmd, --session-id, --session-file, --text, or stdin');
  }
  if (args.file) return prepareFile(args.file);
  if (args.path) return prepareDirectory(args.path);
  if (args.url) return prepareUrl(args.url);
  if (args.cmd) return { source_type: 'command', prepared_file: '', estimated_tokens: 0, truncated: false };
  if (args.sessionId || args.sessionFile) return prepareSession(args);
  if (args.text) return prepareText(args.text, 'inline-text');
  return prepareText(stdinText, 'stdin');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  const prepared = await prepare(args);
  if (args.prepareOnly) {
    process.stdout.write(`${JSON.stringify({
      decision: 'delegate',
      explicit: true,
      ...prepared,
    }, null, args.pretty ? 2 : 0)}\n`);
    return;
  }
  runHelper(args, prepared);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
});
