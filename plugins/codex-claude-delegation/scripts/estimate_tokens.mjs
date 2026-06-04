#!/usr/bin/env node
import fs from 'node:fs';

export function estimateTokens(text) {
  let cjk = 0;
  let other = 0;

  for (const char of String(text || '')) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(char)) {
      cjk += 1;
    } else if (!/\s/u.test(char)) {
      other += 1;
    }
  }

  return Math.ceil(cjk / 1.6 + other / 4);
}

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const paths = args.filter((arg) => arg !== '--json');
  const text = paths.length === 0
    ? readStdin()
    : paths.map((path) => fs.readFileSync(path, 'utf8')).join('\n');
  const estimated = estimateTokens(text);

  if (json) {
    process.stdout.write(JSON.stringify({
      chars: [...text].length,
      estimated_tokens: estimated,
    }, null, 2));
  } else {
    process.stdout.write(String(estimated));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
