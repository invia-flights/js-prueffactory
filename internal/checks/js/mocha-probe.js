'use strict';

// js-prueffactory's test file probe for Mocha. It asks the project's own
// installed Mocha which files a suite loads, so that they can be treated as
// Test code wherever they live.
//
//   node mocha-probe.js <the folder of the installed mocha package> [mocha arguments]
//
// It runs in the package's folder, with the suite's environment. It loads
// Mocha's option loader (lib/cli/options.js, or options.cjs from Mocha 12 on:
// the same lookup the reporter does for bail) with the suite's arguments, which
// reads the project's config files, package.json and MOCHA_OPTIONS the way
// `mocha` does. It expands the spec with Mocha's own file collection
// (lib/cli/collect-files.js or .cjs), which honours `extension`, `recursive`
// and `ignore`. It never loads a spec file or the files named by `require` and
// `import`: those are only resolved to paths.
//
// The answer is one line that starts with the marker below, so that whatever a
// config file prints does not matter:
//
//   {"ok":true,"spec":[…],"require":[…],"import":[…],"file":[…]}
//   {"ok":false,"code":"…","error":"…"}
//
// Paths are absolute. Without a usable Mocha the answer is ok:false, with the
// code "no_loader" when Mocha has none of the expected loader files.

const fs = require('fs');
const path = require('path');

const MARKER = '@@JSPF-PROBE@@';
const realExit = process.exit.bind(process);

function answer(result) {
  fs.writeSync(1, '\n' + MARKER + JSON.stringify(result) + '\n');
  realExit(0);
}

function fail(code, error) {
  answer({ ok: false, code, error: String(error && error.message ? error.message : error).slice(0, 2000) });
}

function firstExisting(dir, names) {
  for (const name of names) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return '';
}

function list(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

// Mocha's own resolution of a --require: a path that exists relative to the
// working folder (with or without .js), else a module name.
function resolveRequire(name) {
  const cwd = process.cwd();
  if (fs.existsSync(name) || fs.existsSync(name + '.js')) {
    const abs = path.resolve(name);
    try {
      return require.resolve(abs);
    } catch (e) {
      return abs;
    }
  }
  try {
    return require.resolve(name, { paths: [cwd] });
  } catch (e) {
    return '';
  }
}

function resolveImport(name) {
  const abs = path.resolve(name);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  return resolveRequire(name);
}

function main() {
  const mochaDir = process.argv[2];
  const args = process.argv.slice(3);
  if (!mochaDir) return fail('no_loader', 'no Mocha folder was given');
  const cli = path.join(mochaDir, 'lib', 'cli');

  const optionsFile = firstExisting(cli, ['options.js', 'options.cjs']);
  const collectFile = firstExisting(cli, ['collect-files.js', 'collect-files.cjs']);
  if (!optionsFile || !collectFile) {
    return fail('no_loader', 'Mocha has no lib/cli/options.js or options.cjs, or no lib/cli/collect-files.js or collect-files.cjs');
  }

  // Mocha ends the process when its files are missing. The probe wants the
  // answer anyway.
  process.exit = (code) => {
    throw Object.assign(new Error('Mocha stopped the process with exit code ' + code), { jspfExit: true });
  };

  let opts;
  try {
    opts = require(optionsFile).loadOptions(args);
  } catch (e) {
    return fail('load_failed', e);
  }

  const spec = list(opts._).length > 0 ? list(opts._) : ['test'];
  const fileArgs = list(opts.file);
  let files = [];
  let noFiles = false;
  try {
    const collected = require(collectFile)({
      ignore: list(opts.ignore),
      extension: opts.extension === undefined ? ['js', 'cjs', 'mjs'] : list(opts.extension),
      file: fileArgs,
      recursive: !!opts.recursive,
      sort: !!opts.sort,
      spec,
    });
    // Mocha 9 returns the list itself, later versions an object with it.
    files = (Array.isArray(collected) ? collected : collected.files).slice(fileArgs.length);
  } catch (e) {
    if (!e.jspfExit) return fail('collect_failed', e);
    noFiles = true;
  }

  const unique = (items) => Array.from(new Set(items.filter(Boolean)));
  answer({
    ok: true,
    noFiles,
    spec: unique(files.map((f) => path.resolve(f))),
    file: unique(fileArgs.map(resolveRequire)),
    require: unique(list(opts.require).map(resolveRequire)),
    import: unique(list(opts.import).map(resolveImport)),
  });
}

try {
  main();
} catch (e) {
  fail('probe_failed', e);
}
