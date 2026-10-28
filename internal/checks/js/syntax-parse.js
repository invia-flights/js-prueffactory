'use strict';
// Embedded helper of the syntax.parse Check. It runs `node --check` on every
// listed file and prints one JSON document on stdout. It reads the file list
// from the JSON file named by argv[2]; paths are literal, never globs.
//
// Input:  { root, display_prefix, files: [{ path }] }
// Output: { node_version, checked, failures: [...], errors: [...] }

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const failures = [];
const errors = [];

for (const file of input.files) {
  const abs = path.join(input.root, file.path);
  const shown = input.display_prefix + file.path;
  const run = spawnSync(process.execPath, ['--check', abs], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
  });
  if (run.error || run.status === null) {
    errors.push({ path: shown, message: String((run.error && run.error.message) || 'terminated by signal ' + run.signal) });
    continue;
  }
  if (run.status === 0) continue;
  failures.push(describe(shown, abs, run.stderr));
}

process.stdout.write(JSON.stringify({
  node_version: process.version,
  checked: input.files.length,
  failures,
  errors,
}));

// describe turns the stderr of a failed `node --check` into a failure record.
// The stderr looks like:
//
//   /abs/file.js:3
//   const x = ;
//             ^
//
//   SyntaxError: Unexpected token ';'
//       at ...
//   Node.js v24.0.0
function describe(shown, abs, stderr) {
  const lines = stderr.split('\n');
  let line = 0;
  let column = 0;
  const head = lines[0] || '';
  const m = /:(\d+)$/.exec(head);
  if (m && head.startsWith(abs)) {
    line = Number(m[1]);
    const source = lines[1] || '';
    const caret = lines[2] || '';
    const at = caret.indexOf('^');
    if (at >= 0) column = Array.from(source.slice(0, at)).length + 1;
  }
  let rule = 'SyntaxError';
  let message = '';
  for (const l of lines) {
    const e = /^([A-Za-z]*Error): (.*)$/.exec(l);
    if (e) {
      rule = e[1];
      message = e[2];
      break;
    }
  }
  const output = lines
    .filter((l) => !/^\s+at /.test(l) && !/^Node\.js v/.test(l))
    .join('\n')
    .split(abs)
    .join(shown)
    .trim();
  return { path: shown, line, column, rule, message, output };
}
