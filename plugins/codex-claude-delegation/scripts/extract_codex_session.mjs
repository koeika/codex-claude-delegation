#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateTokens } from './estimate_tokens.mjs';

const defaultMaxTextChars = Number(process.env.CODEX_DELEGATION_SESSION_MAX_TEXT_CHARS || 4000);
const defaultMaxToolChars = Number(process.env.CODEX_DELEGATION_SESSION_MAX_TOOL_CHARS || 1200);
const defaultMaxTotalChars = Number(process.env.CODEX_DELEGATION_SESSION_MAX_TOTAL_CHARS || 900000);

function parseArgs(argv) {
  const args = {
    maxTextChars: defaultMaxTextChars,
    maxToolChars: defaultMaxToolChars,
    maxTotalChars: defaultMaxTotalChars,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output' || arg === '--report') {
      args[arg.slice(2)] = argv[++i];
    } else if (arg === '--session-id') {
      args.sessionId = argv[++i];
    } else if (arg === '--session-file') {
      args.sessionFile = argv[++i];
    } else if (arg === '--max-text-chars') {
      args.maxTextChars = Number(argv[++i] || args.maxTextChars);
    } else if (arg === '--max-tool-chars') {
      args.maxToolChars = Number(argv[++i] || args.maxToolChars);
    } else if (arg === '--max-total-chars') {
      args.maxTotalChars = Number(argv[++i] || args.maxTotalChars);
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
  extract_codex_session.mjs --session-id <uuid> --output session.txt [--report report.json]
  extract_codex_session.mjs --session-file ~/.codex/sessions/...jsonl --output session.txt [--report report.json]

Extracts a text-only Codex session handoff from JSONL. Images, encrypted reasoning,
and large binary-like payloads are omitted before Claude delegation.
`;
}

function homeDir() {
  return os.homedir();
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(homeDir(), '.codex');
}

function sessionsRoot() {
  return process.env.CODEX_SESSIONS_DIR || path.join(codexHome(), 'sessions');
}

function walk(root, visitor) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walk(full, visitor);
    else if (entry.isFile()) visitor(full);
  }
}

function findSessionFile(sessionId) {
  const direct = path.resolve(sessionId);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  const root = sessionsRoot();
  const matches = [];
  walk(root, (file) => {
    if (path.basename(file).includes(sessionId) && file.endsWith('.jsonl')) {
      matches.push(file);
    }
  });
  matches.sort();
  if (matches.length === 0) {
    throw new Error(`session not found under ${root}: ${sessionId}`);
  }
  return matches[matches.length - 1];
}

const stats = {
  lines_seen: 0,
  lines_extracted: 0,
  image_payloads_omitted: 0,
  encrypted_fields_omitted: 0,
  truncated_fields: 0,
  skipped_items: 0,
};

function truncate(value, max, label = 'text') {
  const text = String(value || '');
  if (text.length <= max) return text;
  stats.truncated_fields += 1;
  return `${text.slice(0, max)}\n[codex-delegation:${label}-truncated chars=${text.length} kept=${max}]`;
}

function imagePlaceholder(kind, chars = 0) {
  stats.image_payloads_omitted += 1;
  return `[codex-delegation:${kind}-omitted chars=${chars}]`;
}

function sanitizeString(value, key = '', max = defaultMaxTextChars) {
  const lowerKey = String(key).toLowerCase();
  let text = String(value || '');
  text = text.replace(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]{128,}/g, (match) => imagePlaceholder('image-data-uri', match.length));
  if (/image|screenshot|thumbnail|attachment|media/.test(lowerKey) && /^https?:\/\/\S+\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)(\?\S*)?(#\S*)?$/i.test(text)) {
    return imagePlaceholder('image-url', text.length);
  }
  if (/image|screenshot|thumbnail|attachment|media|base64/.test(lowerKey) && /^[A-Za-z0-9+/=\s]{1024,}$/.test(text)) {
    return imagePlaceholder('image-base64', text.length);
  }
  return truncate(text, max, 'field');
}

function scrub(value, key = '', max = defaultMaxTextChars) {
  if (typeof value === 'string') {
    if (key === 'encrypted_content') {
      stats.encrypted_fields_omitted += 1;
      return '[codex-delegation:encrypted-content-omitted]';
    }
    return sanitizeString(value, key, max);
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, key, max));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === 'encrypted_content') {
      stats.encrypted_fields_omitted += 1;
      output[childKey] = '[codex-delegation:encrypted-content-omitted]';
    } else {
      output[childKey] = scrub(childValue, childKey, max);
    }
  }
  return output;
}

function contentText(content, maxTextChars) {
  if (typeof content === 'string') return sanitizeString(content, 'content', maxTextChars);
  if (!Array.isArray(content)) return truncate(JSON.stringify(scrub(content, 'content', maxTextChars)), maxTextChars, 'content-json');
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') {
      parts.push(truncate(String(item), maxTextChars, 'content-item'));
      continue;
    }
    const type = String(item.type || '');
    if (/image|screenshot/.test(type) || item.image_url || item.image) {
      parts.push(imagePlaceholder(type || 'image-content', JSON.stringify(item).length));
      continue;
    }
    if (typeof item.text === 'string') parts.push(sanitizeString(item.text, 'text', maxTextChars));
    else if (typeof item.output_text === 'string') parts.push(sanitizeString(item.output_text, 'output_text', maxTextChars));
    else parts.push(truncate(JSON.stringify(scrub(item, 'content-item', maxTextChars)), maxTextChars, 'content-item-json'));
  }
  return parts.filter(Boolean).join('\n');
}

function compactJson(value, maxChars, label) {
  return truncate(JSON.stringify(scrub(value, label, maxChars)), maxChars, label);
}

function section(title, body) {
  const text = String(body || '').trim();
  if (!text) return '';
  stats.lines_extracted += 1;
  return `\n## ${title}\n${text}\n`;
}

function extractLine(item, args) {
  const timestamp = item.timestamp || '';
  const prefix = timestamp ? `${timestamp}\n` : '';
  const payload = item.payload || {};

  if (item.type === 'session_meta') {
    return section('session_meta', compactJson({
      id: payload.id,
      timestamp: payload.timestamp,
      cwd: payload.cwd,
      originator: payload.originator,
      model_provider: payload.model_provider,
      cli_version: payload.cli_version,
      source: payload.source,
    }, args.maxTextChars, 'session-meta'));
  }

  if (item.type === 'turn_context') {
    return section('turn_context', compactJson({
      turn_id: payload.turn_id,
      cwd: payload.cwd,
      current_date: payload.current_date,
      timezone: payload.timezone,
      approval_policy: payload.approval_policy,
      workspace_roots: payload.workspace_roots,
    }, args.maxTextChars, 'turn-context'));
  }

  if (item.type === 'compacted') {
    return section('compacted_summary', `${prefix}${compactJson(payload || item, args.maxTextChars * 2, 'compacted')}`);
  }

  if (item.type === 'event_msg') {
    if (payload.type === 'task_started' || payload.type === 'task_complete' || payload.type === 'turn_aborted' || payload.type === 'context_compacted') {
      return section(`event:${payload.type}`, `${prefix}${compactJson(payload, args.maxTextChars, 'event')}`);
    }
    return '';
  }

  if (item.type !== 'response_item') return '';

  if (payload.type === 'message') {
    const role = payload.role || 'unknown';
    if (role === 'developer' || role === 'system') {
      stats.skipped_items += 1;
      return '';
    }
    return section(`message:${role}`, `${prefix}${contentText(payload.content, args.maxTextChars)}`);
  }

  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    return section(`tool_call:${payload.name || payload.type}`, `${prefix}${compactJson({
      name: payload.name,
      call_id: payload.call_id,
      arguments: payload.arguments,
      input: payload.input,
    }, args.maxToolChars, 'tool-call')}`);
  }

  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    return section('tool_output', `${prefix}call_id: ${payload.call_id || ''}\n${sanitizeString(payload.output || payload.result || '', 'tool_output', args.maxToolChars)}`);
  }

  if (payload.type === 'reasoning') {
    if (Array.isArray(payload.summary) && payload.summary.length > 0) {
      return section('reasoning_summary', `${prefix}${compactJson(payload.summary, args.maxTextChars, 'reasoning-summary')}`);
    }
    stats.skipped_items += 1;
    return '';
  }

  return section(`response_item:${payload.type || 'unknown'}`, `${prefix}${compactJson(payload, args.maxToolChars, 'response-item')}`);
}

function writeLimited(outputPath, header, sections, maxTotalChars) {
  let body = `${header}\n`;
  for (const item of sections) {
    if (!item) continue;
    if (body.length + item.length > maxTotalChars) {
      body += `\n[codex-delegation:session-extract-truncated max_total_chars=${maxTotalChars}]\n`;
      stats.truncated_fields += 1;
      break;
    }
    body += item;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, body);
  return body;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (!args.output) throw new Error('--output is required');
  if (!args.sessionId && !args.sessionFile) throw new Error('Provide --session-id or --session-file');

  const sessionFile = args.sessionFile ? path.resolve(args.sessionFile) : findSessionFile(args.sessionId);
  if (!fs.existsSync(sessionFile) || !fs.statSync(sessionFile).isFile()) {
    throw new Error(`session file does not exist: ${sessionFile}`);
  }

  const sections = [];
  for (const line of fs.readFileSync(sessionFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    stats.lines_seen += 1;
    try {
      sections.push(extractLine(JSON.parse(line), args));
    } catch (error) {
      stats.skipped_items += 1;
      sections.push(section('unparsed_line', truncate(line, args.maxToolChars, 'unparsed-line')));
    }
  }

  const outputPath = path.resolve(args.output);
  const header = [
    '# Codex Session Text Handoff',
    `source_session_file: ${sessionFile}`,
    `session_id: ${args.sessionId || ''}`,
    'note: Images, encrypted reasoning, and oversized payloads are omitted before Claude delegation.',
  ].join('\n');
  const output = writeLimited(outputPath, header, sections, args.maxTotalChars);
  const report = {
    session_id: args.sessionId || '',
    session_file: sessionFile,
    output_path: outputPath,
    output_bytes: Buffer.byteLength(output),
    output_est_tokens: estimateTokens(output),
    ...stats,
  };
  if (args.report) {
    const reportPath = path.resolve(args.report);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main();
