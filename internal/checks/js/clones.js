'use strict';
// Embedded helper of the quality.clones Check. It runs the toolset's jscpd once
// per group of files, in classic token mode with its default minimum tokens, and
// prints one JSON document on stdout. Paths are literal, never globs.
//
// Input:  { jscpd, root, groups: [{ name, files: [relative path] }] }
// Output: { version, groups: [{ name, files, percentage, duplicated_lines, lines,
//           clones: [{ first: {path,start,end}, second: {...}, lines, tokens, fragment }] ,
//           error? }] }
//
// jscpd reads a config file from the working directory or from package.json
// unless it is told which one to use. The project's own configuration must not
// change what the Check measures, so a config of ours (holding only the file
// list) is passed and
// .gitignore files are ignored: the Snapshot already holds exactly the files
// the Run examines.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jscpd-'));

const env = { ...process.env, JSCPD_NO_TIPS: '1', NO_COLOR: '1' };

function jscpd(args) {
  return spawnSync(process.execPath, [input.jscpd, ...args], {
    cwd: input.root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 9 * 60 * 1000,
  });
}

const version = (jscpd(['--version']).stdout || '').trim().replace(/^jscpd\s+/, '');
const groups = [];

for (const group of input.groups) {
  // A symbolic link points at a file that is listed anyway, so scanning it would
  // count the same code twice. jscpd also refuses links it cannot follow.
  const files = (group.files || []).filter((f) => {
    try { return !fs.lstatSync(path.join(input.root, f)).isSymbolicLink(); } catch (e) { return false; }
  });
  const out = { name: group.name, files: files.length, percentage: 0, duplicated_lines: 0, lines: 0, clones: [] };
  groups.push(out);
  if (files.length === 0) continue;

  const outDir = path.join(work, 'out-' + group.name);
  // File names come from the project and there can be many thousands of them,
  // more than a command line holds (ARG_MAX). They go to jscpd in its config
  // file, as absolute paths, so a name such as "-x.js" can never read as an
  // option and nothing is expanded on the command line.
  const groupConfig = path.join(work, 'config-' + group.name + '.json');
  fs.writeFileSync(groupConfig, JSON.stringify({ path: files.map((f) => path.join(input.root, f)) }));
  const run = jscpd([
    '--config', groupConfig, '--no-gitignore', '--no-tips', '--silent', '--no-colors', '--absolute',
    '--reporters', 'json', '--output', outDir,
  ]);
  if (run.error || run.status === null || run.status !== 0) {
    out.error = String((run.error && run.error.message) || (run.stderr || run.stdout || 'exit ' + run.status)).trim().slice(-600);
    continue;
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(path.join(outDir, 'jscpd-report.json'), 'utf8'));
  } catch (e) {
    out.error = 'cannot read the jscpd report: ' + e.message;
    continue;
  }
  const total = (report.statistics && report.statistics.total) || {};
  out.percentage = total.percentage || 0;
  out.duplicated_lines = total.duplicatedLines || 0;
  out.lines = total.lines || 0;
  for (const d of report.duplicates || []) {
    out.clones.push({
      first: place(d.firstFile),
      second: place(d.secondFile),
      lines: d.lines,
      tokens: d.tokens,
      fragment: d.fragment || '',
    });
  }
}

fs.rmSync(work, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ version, groups }));

// place turns jscpd's absolute file entry into a path relative to the root.
function place(f) {
  return { path: path.relative(input.root, f.name).split(path.sep).join('/'), start: f.start, end: f.end };
}
