#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from './estimate_tokens.mjs';

const cwd = process.cwd();
const delegationRoot = path.resolve(process.env.CODEX_DELEGATION_STATE_DIR || path.join(cwd, '.codex', 'delegation'));
const gateRunsDir = path.resolve(process.env.CODEX_DELEGATION_GATE_DIR || path.join(delegationRoot, 'gate-runs'));
const metricsDir = path.resolve(process.env.CODEX_DELEGATION_METRICS_DIR || path.join(process.env.HOME || cwd, '.codex', 'metrics'));
const ledgerPath = path.resolve(process.env.CODEX_DELEGATION_LEDGER || path.join(metricsDir, 'delegation-ledger.jsonl'));
const contextStatePath = path.resolve(process.env.CODEX_DELEGATION_CONTEXT_STATE || path.join(delegationRoot, 'context-state.md'));
const budgetStatePath = path.resolve(process.env.CODEX_DELEGATION_BUDGET_STATE || path.join(delegationRoot, 'budget-state.json'));

const summarizeThreshold = Number(process.env.CODEX_DELEGATION_CONTEXT_SUMMARIZE_THRESHOLD || 60000);
const handoffThreshold = Number(process.env.CODEX_DELEGATION_CONTEXT_HANDOFF_THRESHOLD || 120000);
const blockThreshold = Number(process.env.CODEX_DELEGATION_CONTEXT_BLOCK_THRESHOLD || 160000);

function parseArgs(argv) {
  const args = { json: false, writeState: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--write-state') args.writeState = true;
    else if (arg === '--task') args.task = argv[++i];
    else if (arg === '--new-input') args.newInput = argv[++i];
    else if (arg === '-h' || arg === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readLedger() {
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

function readGateArtifacts() {
  if (!fs.existsSync(gateRunsDir)) return [];
  return fs.readdirSync(gateRunsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(gateRunsDir, name)))
    .filter(Boolean);
}

function estimatePath(value) {
  if (!value) return 0;
  const absolute = path.resolve(value);
  if (!fs.existsSync(absolute)) return 0;
  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    return Math.ceil(stat.size / 4);
  }
  if (stat.isDirectory()) {
    let total = 0;
    const stack = [absolute];
    while (stack.length) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !['.git', 'node_modules', 'dist', 'build', 'coverage'].includes(entry.name)) {
          stack.push(full);
        } else if (entry.isFile()) {
          total += fs.statSync(full).size;
        }
      }
    }
    return Math.ceil(total / 4);
  }
  return 0;
}

function writeContextState(record) {
  fs.mkdirSync(path.dirname(contextStatePath), { recursive: true });
  const body = [
    '# Codex Claude Delegation Context State',
    '',
    `Updated: ${new Date().toISOString()}`,
    `CWD: ${cwd}`,
    '',
    '## Current Task',
    record.task || 'Not specified.',
    '',
    '## Context Budget',
    `Decision: ${record.decision}`,
    `Estimated working tokens: ${record.estimated_context_tokens}`,
    `Reason: ${record.reason}`,
    '',
    '## Local Artifacts',
    `Gate runs: ${record.gate_artifact_count}`,
    `Ledger entries: ${record.ledger_entry_count}`,
    `Budget state: ${budgetStatePath}`,
    '',
    '## Notes',
    '- This file is short-term task state for Codex handoff.',
    '- Do not treat it as a replacement for AGENTS.md or Codex Memories.',
    '',
  ].join('\n');
  fs.writeFileSync(contextStatePath, body);
}

function decide(args) {
  const ledger = readLedger();
  const gateArtifacts = readGateArtifacts();
  const contextStateTokens = fs.existsSync(contextStatePath)
    ? estimateTokens(fs.readFileSync(contextStatePath, 'utf8'))
    : 0;
  const rawAvoided = gateArtifacts.reduce((sum, item) => sum + Number(item.estimated_tokens || 0), 0);
  const injectedByHelper = ledger.reduce((sum, item) => sum + Number(item.output_est_tokens || item.codex_injected_est_tokens || 0), 0);
  const gateJsonOverhead = gateArtifacts.length * 150;
  const newInputEstimate = estimatePath(args.newInput);
  const estimatedContext = contextStateTokens + injectedByHelper + gateJsonOverhead + Math.min(rawAvoided, 20000) + newInputEstimate;

  let decision = 'ok';
  if (estimatedContext >= blockThreshold) decision = 'block_heavy_read';
  else if (estimatedContext >= handoffThreshold) decision = 'handoff';
  else if (estimatedContext >= summarizeThreshold) decision = 'summarize';
  else if (newInputEstimate >= 5000 && estimatedContext >= summarizeThreshold * 0.75) decision = 'delegate';

  const reason = `estimated_context_tokens=${estimatedContext},summarize=${summarizeThreshold},handoff=${handoffThreshold},block=${blockThreshold}`;
  const record = {
    decision,
    reason,
    task: args.task || '',
    estimated_context_tokens: estimatedContext,
    context_state_tokens: contextStateTokens,
    raw_avoided_est_tokens: rawAvoided,
    helper_output_est_tokens: injectedByHelper,
    gate_json_overhead_est_tokens: gateJsonOverhead,
    new_input_est_tokens: newInputEstimate,
    gate_artifact_count: gateArtifacts.length,
    ledger_entry_count: ledger.length,
    context_state_path: contextStatePath,
    budget_state_path: budgetStatePath,
    thresholds: {
      summarizeThreshold,
      handoffThreshold,
      blockThreshold,
    },
  };

  fs.mkdirSync(path.dirname(budgetStatePath), { recursive: true });
  fs.writeFileSync(budgetStatePath, `${JSON.stringify({ ...record, updated_at: new Date().toISOString(), cwd }, null, 2)}\n`);
  if (args.writeState || ['summarize', 'handoff', 'block_heavy_read'].includes(decision)) {
    writeContextState(record);
  }
  return record;
}

function usage() {
  return `Usage:
  context_budget_gate.mjs --json
  context_budget_gate.mjs --task "review current implementation" --new-input ./docs --json
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  const record = decide(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  } else {
    process.stdout.write(`${record.decision}: ${record.reason}\n`);
  }
}

main();
