'use strict';
// Embedded helper of the modules.cycles Check. It runs the toolset's
// dependency-cruiser with our own rule file on a list of files and prints a
// short JSON document on stdout, so that a large project's full module graph
// never has to travel through the Report.
//
// Input:  { depcruise, config, root, files: [relative path] }
// Output: { version, total_cruised, violations: [{ rule, from, to, specifier, cycle: [path] }],
//           unresolved: [{ from, module }], edges: { from: [to] }, error? }
//
// The names in `files` come from the project. dependency-cruiser reads its
// arguments as globs, and the Go side only passes names that are not globs. The
// `./` prefix and `--` keep a name such as "-x.js" from ever reading as an
// option. The tool reads no configuration of the project: the rule file is
// ours, and only package.json (for the dependency types) and the installed
// dependencies are looked at.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'depcruise-'));
const outFile = path.join(work, 'report.json');

// Unresolved imports are reported once per specifier, and at most this many.
const maxUnresolved = 500;

function finish(doc) {
  fs.rmSync(work, { recursive: true, force: true });
  process.stdout.write(JSON.stringify(doc));
}

// A symbolic link may point anywhere, and the file it names is listed anyway.
const files = input.files.filter((f) => {
  try { return !fs.lstatSync(path.join(input.root, f)).isSymbolicLink(); } catch (e) { return false; }
});

const run = spawnSync(process.execPath, [
  input.depcruise, '--config', input.config, '--output-type', 'json', '--output-to', outFile,
  '--', ...files.map((f) => './' + f),
], {
  cwd: input.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 9 * 60 * 1000,
  env: { ...process.env, NO_COLOR: '1' },
});

const empty = { version: '', total_cruised: 0, violations: [], unresolved: [] };
if (run.error || run.status === null || (run.status !== 0 && !fs.existsSync(outFile))) {
  finish({ ...empty, error: String((run.error && run.error.message) || run.stderr || run.stdout || 'exit ' + run.status).trim().slice(-600) });
  return;
}

let report;
try {
  report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
} catch (e) {
  finish({ ...empty, error: 'cannot read the dependency-cruiser report: ' + e.message });
  return;
}

const summary = report.summary || {};
const violations = [];
for (const v of summary.violations || []) {
  violations.push({
    rule: (v.rule && v.rule.name) || '',
    from: v.from,
    to: v.to,
    specifier: v.unresolvedTo || '',
    cycle: (v.cycle || []).map((c) => c.name),
  });
}

const seen = new Set();
const unresolved = [];
const edges = {};
for (const m of report.modules || []) {
  for (const d of m.dependencies || []) {
    // An import of one of the package's own files, a lazy require inside a
    // function included: the Go side follows these from the entry points.
    if (!d.couldNotResolve && (d.dependencyTypes || []).includes('local') && typeof d.resolved === 'string') {
      (edges[m.source] = edges[m.source] || []).push(d.resolved);
    }
    if (!d.couldNotResolve || d.module.startsWith('.') || seen.has(d.module)) continue;
    seen.add(d.module);
    if (unresolved.length < maxUnresolved) unresolved.push({ from: m.source, module: d.module });
  }
}

finish({
  version: (summary.environment && summary.environment.version) || '',
  total_cruised: summary.totalCruised || 0,
  violations,
  unresolved,
  edges,
});
