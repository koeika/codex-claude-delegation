#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const metricsDir = process.env.CODEX_DELEGATION_METRICS_DIR || path.join(os.homedir(), '.codex', 'metrics');
const ledgerPath = process.env.CODEX_DELEGATION_LEDGER || path.join(metricsDir, 'delegation-ledger.jsonl');
const dashboardPath = process.env.CODEX_DELEGATION_DASHBOARD || path.join(metricsDir, 'delegation-dashboard.html');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

function readRecords() {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs.readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const records = readRecords();
const successful = records.filter((item) => item.status === 'success');
const totalSaved = successful.reduce((sum, item) => sum + Number(item.codex_saved_est_tokens || 0), 0);
const totalInjected = successful.reduce((sum, item) => sum + Number(item.codex_injected_est_tokens || item.output_est_tokens || 0), 0);
const totalClaudeInput = successful.reduce((sum, item) => sum + Number(item.raw_input_est_tokens || item.input_est_tokens || 0), 0);
const failed = records.filter((item) => item.status !== 'success').length;
const avgRatio = totalClaudeInput > 0 ? totalSaved / totalClaudeInput : 0;

const formatNumber = (value) => new Intl.NumberFormat('en-US').format(Math.round(Number(value || 0)));
const formatRatio = (value) => `${Math.round(Number(value || 0) * 100)}%`;

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const current = map.get(key) || { key, count: 0, saved: 0, input: 0 };
    current.count += 1;
    current.saved += Number(item.codex_saved_est_tokens || 0);
    current.input += Number(item.raw_input_est_tokens || item.input_est_tokens || 0);
    map.set(key, current);
  }
  return [...map.values()];
}

const byType = groupBy(successful, (item) => item.task_type || 'ad_hoc').sort((a, b) => b.saved - a.saved);
const maxSaved = Math.max(1, ...byType.map((item) => item.saved));
const recent = [...records].reverse().slice(0, 50);

const bars = byType.map((item) => {
  const width = Math.max(2, Math.round((item.saved / maxSaved) * 100));
  return `<div class="bar-row"><div>${escapeHtml(item.key)}</div><div class="bar"><span style="width:${width}%"></span></div><div>${formatNumber(item.saved)} saved</div></div>`;
}).join('\n') || '<p class="empty">No successful delegation records yet.</p>';

const rows = recent.map((item) => `
  <tr>
    <td>${escapeHtml(item.timestamp || '')}</td>
    <td>${escapeHtml(item.task_type || '')}</td>
    <td>${escapeHtml(item.model || '')}</td>
    <td class="num">${formatNumber(item.raw_input_est_tokens || item.input_est_tokens)}</td>
    <td class="num">${formatNumber(item.codex_injected_est_tokens || item.output_est_tokens)}</td>
    <td class="num">${formatNumber(item.codex_saved_est_tokens)}</td>
    <td>${formatRatio(item.saved_ratio)}</td>
    <td>${escapeHtml(item.status || '')}</td>
    <td>${item.artifact_path ? `<code>${escapeHtml(item.artifact_path)}</code>` : ''}</td>
  </tr>
`).join('\n') || '<tr><td colspan="9" class="empty">No records yet.</td></tr>';

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Claude Delegation Metrics</title>
  <style>
    body { margin: 0; background: #f7f8fb; color: #1f2937; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header, main { padding: 24px 32px; }
    h1 { margin: 0 0 4px; font-size: 24px; }
    .muted { color: #667085; }
    .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 18px 0; }
    .card, section { background: #fff; border: 1px solid #d9e2ec; border-radius: 8px; padding: 16px; }
    .metric { font-size: 26px; font-weight: 700; }
    .bar-row { display: grid; grid-template-columns: 180px 1fr 140px; gap: 12px; align-items: center; margin: 10px 0; }
    .bar { height: 10px; background: #e8eef8; border-radius: 999px; overflow: hidden; }
    .bar span { display: block; height: 100%; background: #2563eb; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 8px; text-align: left; vertical-align: top; }
    th { color: #667085; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    @media (max-width: 900px) { .cards, .bar-row { grid-template-columns: 1fr; } header, main { padding: 18px; } }
  </style>
</head>
<body>
  <header>
    <h1>Codex Claude Delegation Metrics</h1>
    <div class="muted">Estimated Codex context avoided by delegating raw read-only input to local Claude CLI.</div>
  </header>
  <main>
    <div class="cards">
      <div class="card"><div class="metric">${formatNumber(totalSaved)}</div><div class="muted">Codex tokens avoided</div></div>
      <div class="card"><div class="metric">${formatNumber(totalInjected)}</div><div class="muted">Codex tokens injected</div></div>
      <div class="card"><div class="metric">${formatRatio(avgRatio)}</div><div class="muted">Average saved ratio</div></div>
      <div class="card"><div class="metric">${formatNumber(failed)}</div><div class="muted">Failed runs</div></div>
    </div>
    <section>
      <h2>Savings By Task Type</h2>
      ${bars}
    </section>
    <section>
      <h2>Recent Delegations</h2>
      <table>
        <thead><tr><th>Time</th><th>Task</th><th>Model</th><th class="num">Raw input</th><th class="num">Injected</th><th class="num">Saved</th><th>Ratio</th><th>Status</th><th>Artifact</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
    <p class="muted">Ledger: ${escapeHtml(ledgerPath)}. Estimates are for workflow evaluation, not official billing.</p>
  </main>
</body>
</html>`;

fs.mkdirSync(metricsDir, { recursive: true });
fs.writeFileSync(dashboardPath, html);
console.log(dashboardPath);
