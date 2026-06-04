#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from './estimate_tokens.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' || arg === '--output' || arg === '--report') {
      args[arg.slice(2)] = argv[++i];
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
  sanitize_delegation_input.mjs --input raw.txt --output no-images.txt [--report report.json]

Removes image payloads from JSONL/plain-text delegation input while preserving text records.
`;
}

const stats = {
  removed_items: 0,
  removed_chars: 0,
  data_uri_count: 0,
  base64_field_count: 0,
  image_url_count: 0,
  image_object_count: 0,
};

function addRemoval(kind, chars) {
  stats.removed_items += 1;
  stats.removed_chars += Math.max(0, Number(chars || 0));
  if (kind === 'data_uri') stats.data_uri_count += 1;
  if (kind === 'base64_field') stats.base64_field_count += 1;
  if (kind === 'image_url') stats.image_url_count += 1;
  if (kind === 'image_object') stats.image_object_count += 1;
}

function placeholder(kind, chars, detail = '') {
  const suffix = detail ? ` ${detail}` : '';
  return `[codex-delegation:${kind}-removed chars=${chars}${suffix}]`;
}

function isLikelyBase64(value) {
  const compact = value.replace(/\s+/g, '');
  if (compact.length < 1024) return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(compact)) return false;
  return /[A-Z]/.test(compact) && /[a-z]/.test(compact) && /[0-9+/]/.test(compact);
}

function keyLooksImageLike(keyPath) {
  const key = keyPath.join('.').toLowerCase();
  return /(^|[._-])(image|images|image_url|imageurl|imagedata|image_data|screenshot|screenshots|thumbnail|thumb|attachment|media)([._-]|$)/.test(key);
}

function keyLooksPayloadLike(keyPath) {
  const key = keyPath.join('.').toLowerCase();
  return /(^|[._-])(base64|bytes|blob|data|payload|source|content|url)([._-]|$)/.test(key);
}

function isImageUrl(value) {
  return /^https?:\/\/\S+\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)(\?\S*)?(#\S*)?$/i.test(value);
}

function replaceDataUris(value) {
  return value.replace(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]{128,}/g, (match) => {
    addRemoval('data_uri', match.length);
    const mime = match.slice(5, match.indexOf(';base64,'));
    return placeholder('image-data-uri', match.length, `mime=${mime}`);
  });
}

function objectHasImageSignal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => keyLooksImageLike([key]))) return true;
  const typeText = [value.type, value.kind, value.name, value.mime_type, value.media_type, value.content_type]
    .filter((item) => typeof item === 'string')
    .join(' ')
    .toLowerCase();
  if (/\b(image|input_image|screenshot)\b/.test(typeText)) return true;
  if (/image\//.test(typeText)) return true;
  if (value.source && typeof value.source === 'object') {
    const sourceText = [value.source.type, value.source.media_type, value.source.mime_type]
      .filter((item) => typeof item === 'string')
      .join(' ')
      .toLowerCase();
    if (/image|image\//.test(sourceText)) return true;
  }
  return false;
}

function sanitizeString(value, keyPath, imageContext) {
  let text = replaceDataUris(value);
  const imageKey = keyLooksImageLike(keyPath);
  const payloadKey = keyLooksPayloadLike(keyPath);
  if ((imageKey || imageContext) && isImageUrl(text)) {
    addRemoval('image_url', text.length);
    return placeholder('image-url', text.length);
  }
  if ((imageKey || (imageContext && payloadKey)) && isLikelyBase64(text)) {
    addRemoval('base64_field', text.length);
    return placeholder('image-base64', text.length);
  }
  return text;
}

function sanitizeValue(value, keyPath = [], imageContext = false) {
  if (typeof value === 'string') return sanitizeString(value, keyPath, imageContext);
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeValue(item, [...keyPath, String(index)], imageContext));
  }
  if (!value || typeof value !== 'object') return value;

  const currentImageContext = imageContext || objectHasImageSignal(value) || keyLooksImageLike(keyPath);
  const output = {};
  if (currentImageContext) stats.image_object_count += 1;
  for (const [key, child] of Object.entries(value)) {
    output[key] = sanitizeValue(child, [...keyPath, key], currentImageContext);
  }
  return output;
}

function sanitizeLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return line;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(sanitizeValue(JSON.parse(line)));
    } catch {
      return replaceDataUris(line);
    }
  }
  return replaceDataUris(line);
}

function sanitizeText(text) {
  const lines = text.split('\n');
  return lines.map((line) => sanitizeLine(line)).join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (!args.input || !args.output) {
    throw new Error('Both --input and --output are required');
  }
  const inputPath = path.resolve(args.input);
  const outputPath = path.resolve(args.output);
  const input = fs.readFileSync(inputPath, 'utf8');
  const output = sanitizeText(input);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output);
  const report = {
    input_path: inputPath,
    output_path: outputPath,
    input_bytes: Buffer.byteLength(input),
    output_bytes: Buffer.byteLength(output),
    input_est_tokens: estimateTokens(input),
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
