#!/usr/bin/env node
/**
 * detect-pii.js — Scan source files for hardcoded PII patterns.
 *
 * Usage:
 *   node scripts/detect-pii.js [target-dir]   # default: current directory
 *
 * Exit 0 = clean. Exit 1 = PII found.
 *
 * To add family-specific patterns, create scripts/pii-patterns.local.js
 * (gitignored) exporting an array of { name, re } objects.
 */

const fs   = require('fs');
const path = require('path');

// ── Generic PII patterns (safe to publish) ────────────────────────────────────

const PATTERNS = [
  { name: 'Israeli phone (972...)',  re: /\+?972\d{8,10}/g },
  { name: 'Real email address',      re: /[a-zA-Z0-9._%+-]+@(?!example\.|c\.us|g\.us|s\.whatsapp\.net)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { name: 'Anthropic API key',       re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'OpenAI API key',          re: /sk-[A-Za-z0-9]{40,}/g },
  { name: 'Hardcoded secret literal', re: /(?:secret|password|passwd)\s*=\s*["'][^"']{8,}["']/gi },
];

// Load optional local patterns (gitignored, family-specific)
const LOCAL_PATTERNS_PATH = path.join(__dirname, 'pii-patterns.local.js');
if (fs.existsSync(LOCAL_PATTERNS_PATH)) {
  const local = require(LOCAL_PATTERNS_PATH);
  if (Array.isArray(local)) PATTERNS.push(...local);
}

// ── Files & dirs to skip ──────────────────────────────────────────────────────

const SKIP_DIRS  = new Set(['node_modules', '.git', 'data', 'backups', 'logs',
  'whatsapp-session', '.wwebjs_auth', '.wwebjs_cache']);
const SKIP_FILES = new Set(['.env', 'credentials.json', 'package-lock.json', 'detect-pii.js']);
const SCAN_EXT   = new Set(['.js', '.json', '.ts', '.yaml', '.yml', '.txt', '.md', '.sh']);

// ── Scanner ───────────────────────────────────────────────────────────────────

function walk(target, results = []) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (SCAN_EXT.has(path.extname(target)) && !SKIP_FILES.has(path.basename(target)))
      results.push(target);
    return results;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) walk(full, results);
    else if (SCAN_EXT.has(path.extname(entry.name)) && !SKIP_FILES.has(entry.name))
      results.push(full);
  }
  return results;
}

function scanFile(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) { return []; }
  const findings = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const line = content.slice(0, m.index).split('\n').length;
      findings.push({ pattern: name, match: m[0], line });
    }
  }
  return findings;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const target = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const files  = walk(target);

let total = 0;
const report = [];

for (const file of files) {
  const findings = scanFile(file);
  if (findings.length) { report.push({ file: path.relative(target, file), findings }); total += findings.length; }
}

if (total === 0) {
  console.log(`✅ PII scan clean — ${files.length} files checked, 0 findings.`);
  process.exit(0);
} else {
  console.error(`\n🚨 PII DETECTED — ${total} finding(s) in ${report.length} file(s):\n`);
  for (const { file, findings } of report) {
    console.error(`  ${file}:`);
    for (const f of findings) console.error(`    Line ${f.line}: [${f.pattern}] "${f.match}"`);
  }
  console.error('\nFix all findings before proceeding.\n');
  process.exit(1);
}
