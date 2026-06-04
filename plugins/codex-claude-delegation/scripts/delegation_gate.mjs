#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { estimateTokens } from './estimate_tokens.mjs';

const cwd = process.cwd();
const tokenThreshold = Number(process.env.CODEX_DELEGATION_TOKEN_THRESHOLD || 5000);
const diffLineThreshold = Number(process.env.CODEX_DELEGATION_DIFF_LINE_THRESHOLD || 300);
const logLineThreshold = Number(process.env.CODEX_DELEGATION_LOG_LINE_THRESHOLD || 200);
const fileCountThreshold = Number(process.env.CODEX_DELEGATION_FILE_COUNT_THRESHOLD || 8);
const maxDirFiles = Number(process.env.CODEX_DELEGATION_MAX_DIR_FILES || 200);
const maxDirTextBytes = Number(process.env.CODEX_DELEGATION_MAX_DIR_TEXT_BYTES || 2 * 1024 * 1024);
const httpMaxBytes = Number(process.env.CODEX_DELEGATION_HTTP_MAX_BYTES || 256 * 1024);
const gateDir = path.resolve(process.env.CODEX_DELEGATION_GATE_DIR || path.join(cwd, '.codex', 'delegation', 'gate-runs'));

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

const excludedDirNames = new Set([
  '.cache', '.git', '.hg', '.next', '.nuxt', '.parcel-cache', '.pnpm-store',
  '.svn', '.turbo', 'build', 'coverage', 'dist', 'node_modules', 'out', 'target',
]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file' || arg === '--path' || arg === '--url' || arg === '--cmd') {
      args[arg.slice(2)] = argv[++i];
    } else if (arg === '--pretty') {
      args.pretty = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return `Usage:
  delegation_gate.mjs --file <path>
  delegation_gate.mjs --path <directory>
  delegation_gate.mjs --url <http-url>
  delegation_gate.mjs --cmd "<read-only command>"
`;
}

function ensureGateDir() {
  fs.mkdirSync(gateDir, { recursive: true });
}

function runId() {
  return `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

function relOrAbs(value) {
  if (!value) return value;
  const absolute = path.resolve(value);
  return path.relative(cwd, absolute) || '.';
}

function countLines(text) {
  if (!text) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

function isProbablyBinaryBuffer(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function readTextSample(file, maxBytes = 5 * 1024 * 1024) {
  const stat = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, 0);
    const binary = isProbablyBinaryBuffer(buffer);
    return {
      stat,
      binary,
      truncated: stat.size > maxBytes,
      text: binary ? '' : buffer.toString('utf8'),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function artifactPath(id, suffix = '.json') {
  ensureGateDir();
  return path.join(gateDir, `${id}${suffix}`);
}

function writeArtifact(record) {
  const id = record.task_id || runId();
  const file = artifactPath(id);
  const payload = { ...record, task_id: id, created_at: new Date().toISOString(), cwd };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

function shortDecision(record) {
  const artifact = writeArtifact(record);
  const stdoutRecord = {
    decision: record.decision,
    input_type: record.input_type,
    reason: record.reason,
    estimated_tokens: record.estimated_tokens || 0,
    artifact,
  };
  if (record.captured_output_path) stdoutRecord.captured_output_path = record.captured_output_path;
  if (record.content_type) stdoutRecord.content_type = record.content_type;
  if (record.status_code) stdoutRecord.status_code = record.status_code;
  return stdoutRecord;
}

function fileDecision(file) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) {
    return shortDecision({
      decision: 'unavailable',
      input_type: 'file',
      reason: 'file does not exist',
      target: file,
    });
  }
  const ext = path.extname(absolute).toLowerCase();
  if (binaryExtensions.has(ext)) {
    return shortDecision({
      decision: 'unsupported',
      input_type: 'file',
      reason: `unsupported binary extension: ${ext}`,
      target: relOrAbs(absolute),
    });
  }
  const sample = readTextSample(absolute);
  if (sample.binary) {
    return shortDecision({
      decision: 'unsupported',
      input_type: 'file',
      reason: 'binary content detected',
      target: relOrAbs(absolute),
      bytes: sample.stat.size,
    });
  }
  const estimated = estimateTokens(sample.text);
  const lines = countLines(sample.text);
  const forcedBySize = sample.truncated;
  const delegate = forcedBySize || estimated >= tokenThreshold;
  return shortDecision({
    decision: delegate ? 'delegate' : 'local',
    input_type: 'file',
    reason: forcedBySize
      ? `file exceeds sampling cap; bytes=${sample.stat.size}`
      : `estimated_tokens=${estimated} ${delegate ? '>=' : '<'} threshold=${tokenThreshold}`,
    target: relOrAbs(absolute),
    bytes: sample.stat.size,
    lines,
    estimated_tokens: estimated,
    threshold: tokenThreshold,
  });
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
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirNames.has(entry.name)) walkDirectory(full, files);
    } else if (entry.isFile() && shouldIncludeFile(full)) {
      files.push(full);
    }
  }
  return files;
}

function directoryDecision(dir) {
  const absolute = path.resolve(dir);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    return shortDecision({
      decision: 'unavailable',
      input_type: 'directory',
      reason: 'directory does not exist',
      target: dir,
    });
  }

  const candidates = walkDirectory(absolute);
  const fileRecords = [];
  let totalBytes = 0;
  let totalTokens = 0;
  let totalLines = 0;
  let truncatedFiles = 0;

  for (const file of candidates) {
    const sample = readTextSample(file, 512 * 1024);
    if (sample.binary) continue;
    const estimated = estimateTokens(sample.text);
    const lines = countLines(sample.text);
    totalBytes += sample.stat.size;
    totalTokens += estimated;
    totalLines += lines;
    if (sample.truncated) truncatedFiles += 1;
    fileRecords.push({
      path: relOrAbs(file),
      bytes: sample.stat.size,
      lines,
      estimated_tokens: estimated,
      truncated: sample.truncated,
    });
  }

  const tooLargeForDirectManifest = fileRecords.length > maxDirFiles || totalBytes > maxDirTextBytes || truncatedFiles > 0;
  const delegate = tooLargeForDirectManifest || fileRecords.length > fileCountThreshold || totalTokens >= tokenThreshold;
  const decision = !delegate ? 'local' : tooLargeForDirectManifest ? 'delegate_manifest' : 'delegate';
  const reason = tooLargeForDirectManifest
    ? `candidate_files=${fileRecords.length},total_text_bytes=${totalBytes},truncated_files=${truncatedFiles}`
    : fileRecords.length > fileCountThreshold
      ? `candidate_files=${fileRecords.length} > threshold=${fileCountThreshold}`
      : `estimated_tokens=${totalTokens} ${delegate ? '>=' : '<'} threshold=${tokenThreshold}`;

  return shortDecision({
    decision,
    input_type: 'directory',
    reason,
    target: relOrAbs(absolute),
    candidate_files: fileRecords.length,
    excluded_dirs: [...excludedDirNames].sort(),
    total_text_bytes: totalBytes,
    total_lines: totalLines,
    estimated_tokens: totalTokens,
    thresholds: {
      tokenThreshold,
      fileCountThreshold,
      maxDirFiles,
      maxDirTextBytes,
    },
    files: fileRecords.sort((a, b) => b.estimated_tokens - a.estimated_tokens),
  });
}

function isUnsafeCommand(command) {
  return /[;&|><`$(){}\n\r]/.test(command);
}

function isAllowedCommand(command) {
  return /^(git\s+(diff|show|log|status|ls-files)\b|rg\b|find\b|sed\s+-n\b|wc\b|ls\b)/.test(command.trim());
}

function runReadOnlyCommand(command) {
  return new Promise((resolve) => {
    if (isUnsafeCommand(command) || !isAllowedCommand(command)) {
      resolve(shortDecision({
        decision: 'blocked',
        input_type: 'command',
        reason: 'command is not in the read-only allowlist or contains shell control operators',
        command,
      }));
      return;
    }

    const id = runId();
    ensureGateDir();
    const capturedOutputPath = artifactPath(id, '.output.txt');
    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, Number(process.env.CODEX_DELEGATION_CMD_TIMEOUT_MS || 10000));

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      const output = stderr ? `${stdout}\n===== STDERR =====\n${stderr}` : stdout;
      fs.writeFileSync(capturedOutputPath, output);
      const estimated = estimateTokens(output);
      const lines = countLines(output);
      const isDiff = /^git\s+diff\b/.test(command.trim());
      const lineThreshold = isDiff ? diffLineThreshold : logLineThreshold;
      const delegate = estimated >= tokenThreshold || lines >= lineThreshold;
      resolve(shortDecision({
        task_id: id,
        decision: delegate ? 'delegate' : 'local',
        input_type: 'command',
        reason: `lines=${lines},estimated_tokens=${estimated},line_threshold=${lineThreshold},token_threshold=${tokenThreshold}`,
        command,
        exit_code: code,
        signal,
        lines,
        estimated_tokens: estimated,
        captured_output_path: capturedOutputPath,
      }));
    });
  });
}

function looksLikeAuthPage(text) {
  return /sign\s*in|log\s*in|password|sso|oauth|unauthorized|forbidden/i.test(text.slice(0, 4096));
}

async function urlDecision(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return shortDecision({
      decision: 'unsupported',
      input_type: 'url',
      reason: 'invalid URL',
      url,
    });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return shortDecision({
      decision: 'unsupported',
      input_type: 'url',
      reason: 'only http and https URLs are supported',
      url,
    });
  }

  let head;
  try {
    head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  } catch (error) {
    return shortDecision({
      decision: 'unavailable',
      input_type: 'url',
      reason: `HEAD failed: ${error.message}`,
      url,
    });
  }

  const contentType = head.headers.get('content-type') || '';
  const contentLength = Number(head.headers.get('content-length') || 0);
  if (head.status === 401 || head.status === 403) {
    return shortDecision({
      decision: 'unavailable',
      input_type: 'url',
      reason: `HTTP ${head.status}`,
      status_code: head.status,
      content_type: contentType,
      url,
    });
  }

  if (/\b(pdf|msword|officedocument|zip|image|audio|video)\b/i.test(contentType)) {
    return shortDecision({
      decision: 'unsupported',
      input_type: 'url',
      reason: `unsupported content-type: ${contentType}`,
      status_code: head.status,
      content_type: contentType,
      content_length: contentLength,
      url,
    });
  }

  if (contentLength > httpMaxBytes && contentLength / 4 >= tokenThreshold) {
    return shortDecision({
      decision: 'delegate',
      input_type: 'url',
      reason: `content_length=${contentLength} exceeds sampling cap=${httpMaxBytes}`,
      status_code: head.status,
      content_type: contentType,
      content_length: contentLength,
      estimated_tokens: Math.ceil(contentLength / 4),
      url,
    });
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { range: `bytes=0-${httpMaxBytes - 1}` },
    });
  } catch (error) {
    return shortDecision({
      decision: 'unavailable',
      input_type: 'url',
      reason: `GET failed: ${error.message}`,
      url,
    });
  }

  const buffer = Buffer.from(await response.arrayBuffer()).subarray(0, httpMaxBytes);
  const text = buffer.toString('utf8');
  if (looksLikeAuthPage(text)) {
    return shortDecision({
      decision: 'unavailable',
      input_type: 'url',
      reason: 'login or authorization page detected',
      status_code: response.status,
      content_type: response.headers.get('content-type') || contentType,
      url,
    });
  }

  const estimated = estimateTokens(text);
  const delegate = estimated >= tokenThreshold || (contentLength > 0 && contentLength > buffer.length && Math.ceil(contentLength / 4) >= tokenThreshold);
  return shortDecision({
    decision: delegate ? 'delegate' : 'local',
    input_type: 'url',
    reason: `sample_estimated_tokens=${estimated} ${delegate ? '>=' : '<'} threshold=${tokenThreshold}`,
    status_code: response.status,
    content_type: response.headers.get('content-type') || contentType,
    content_length: contentLength,
    sampled_bytes: buffer.length,
    estimated_tokens: contentLength > buffer.length && contentLength > 0 ? Math.ceil(contentLength / 4) : estimated,
    url,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const selected = ['file', 'path', 'url', 'cmd'].filter((key) => args[key]);
  if (selected.length !== 1) {
    throw new Error('Provide exactly one of --file, --path, --url, or --cmd');
  }

  let result;
  if (args.file) result = fileDecision(args.file);
  if (args.path) result = directoryDecision(args.path);
  if (args.url) result = await urlDecision(args.url);
  if (args.cmd) result = await runReadOnlyCommand(args.cmd);
  process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
});
