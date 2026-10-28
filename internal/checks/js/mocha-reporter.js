'use strict';

// js-prueffactory's Mocha reporter. Mocha loads it with --reporter, and it
// learns where to write from the JSPF_EVENTS environment variable, because a
// reporter option from the project's config file can beat the command line.
//
// It appends one JSON event per line and writes each line before it returns,
// so the results survive a crash or a timeout. The format is internal; the Go
// side (test_events.go) is its only reader. Events:
//
//   config     what the project's own configuration says about bail, which
//              the run overrides
//   found      every test of the loaded files, before Mocha runs or filters any
//   partial    the tests were not all announced, and why
//   result     the final outcome of one test
//   retry      a failed attempt of a test that Mocha tries again
//   hook_fail  a hook that threw, with its scope
//   end        the run finished, with the resources still open, from
//              process.getActiveResourcesInfo()
//
// It supports Mocha 9 to 12 and uses nothing from Mocha but the runner's
// events and the suite objects it hands over.

const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_TEXT = 16384;

let fd = -1;
try {
  if (process.env.JSPF_EVENTS) fd = fs.openSync(process.env.JSPF_EVENTS, 'a');
} catch (e) {
  fd = -1;
}

function emit(event) {
  if (fd < 0) return;
  try {
    fs.writeSync(fd, JSON.stringify(event) + '\n');
  } catch (e) {
    // A full disk must not turn into a test failure.
  }
}

function cap(text) {
  const s = String(text);
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
}

function show(value) {
  if (typeof value === 'string') return cap(value);
  try {
    return cap(util.inspect(value, { depth: 8, maxArrayLength: 200, maxStringLength: 4096, breakLength: 100, sorted: true }));
  } catch (e) {
    return cap(String(value));
  }
}

function serializeError(err) {
  if (err === undefined || err === null) return null;
  const out = {
    name: typeof err.name === 'string' ? err.name : typeof err,
    message: cap(err.message !== undefined ? err.message : String(err)),
    stack: typeof err.stack === 'string' ? cap(err.stack) : '',
  };
  if (err.showDiff !== false && ('expected' in Object(err) || 'actual' in Object(err))) {
    if (err.expected !== undefined) out.expected = show(err.expected);
    if (err.actual !== undefined) out.actual = show(err.actual);
  }
  return out;
}

function titlesOf(suite) {
  const titles = [];
  for (let s = suite; s && !s.root; s = s.parent) titles.unshift(s.title);
  return titles;
}

function fileOf(runnable) {
  for (let s = runnable; s; s = s.parent) {
    if (s.file) return s.file;
  }
  return '';
}

function fullTitleOf(test) {
  return typeof test.fullTitle === 'function' ? test.fullTitle() : titlesOf(test.parent).concat(test.title).join(' ');
}

function describe(test) {
  return {
    file: fileOf(test),
    title: test.title,
    fullTitle: fullTitleOf(test),
    suitePath: titlesOf(test.parent),
  };
}

// A test is focused when it or a suite around it is marked .only.
function isFocused(test) {
  const own = test.parent && test.parent._onlyTests;
  if (own && own.indexOf(test) !== -1) return true;
  for (let s = test.parent; s && s.parent; s = s.parent) {
    const only = s.parent._onlySuites;
    if (only && only.indexOf(s) !== -1) return true;
  }
  return false;
}

// The project's own bail setting, from its config files, package.json and
// MOCHA_OPTIONS, as Mocha itself reads them. The run switches bail off with
// --no-bail, which wins over all of them, so the reporter reads the options
// again without the last argument, which is that --no-bail. Mocha's option
// loader sits in lib/cli/options.js, or options.cjs from Mocha 12 on.
function projectBail() {
  try {
    const mochaDir = path.resolve(path.dirname(process.argv[1]), '..');
    const argv = process.argv.slice(2);
    if (argv[argv.length - 1] === '--no-bail') argv.pop();
    for (const name of ['options.js', 'options.cjs']) {
      const file = path.join(mochaDir, 'lib', 'cli', name);
      if (!fs.existsSync(file)) continue;
      return require(file).loadOptions(argv).bail === true;
    }
  } catch (e) {
    // Without an answer the Report says nothing about bail.
  }
  return undefined;
}

// In parallel mode the files are loaded in worker processes, so the reporter
// never sees a test a worker's .only excluded, and never sees a test before it
// has run.
function isParallel(runner) {
  return !!runner.constructor && runner.constructor.name === 'ParallelBufferedRunner';
}

// What process.getActiveResourcesInfo() calls the handle behind a stream.
const STREAM_HANDLES = { Pipe: 'PipeWrap', TTY: 'TTYWrap', TCP: 'TCPSocketWrap' };

// The resources that keep the process alive now, by type, without the two
// streams that carry stdout and stderr, which Mocha itself holds open. It is
// undefined when this Node cannot list them.
function openResources() {
  try {
    if (typeof process.getActiveResourcesInfo !== 'function') return undefined;
    // Touching the streams creates them, so they are in the list and go out
    // of it, whether Mocha has used them yet or not.
    const streams = [process.stdout, process.stderr];
    const list = process.getActiveResourcesInfo().map(String);
    for (const stream of streams) {
      const handle = stream && stream._handle;
      const kind = handle && handle.constructor && STREAM_HANDLES[handle.constructor.name];
      const at = kind ? list.indexOf(kind) : -1;
      if (at !== -1) list.splice(at, 1);
    }
    return list.slice(0, 200).map((name) => name.slice(0, 40));
  } catch (e) {
    return undefined;
  }
}

// The Go side stops the container when the process is still alive 30 seconds
// after it saw this line. The line is a token that only this run knows, so that
// the project's own output cannot end the run early.
function announceEnd() {
  try {
    if (process.env.JSPF_END_MARKER) fs.writeSync(2, process.env.JSPF_END_MARKER + '\n');
  } catch (e) {
    // The grace period is a safeguard and must not turn into a test failure.
  }
}

function JspfReporter(runner) {
  const ids = new WeakMap();
  let seq = 0;

  // A retried test runs again as a clone that points back to the original.
  function idOf(test) {
    const own = ids.get(test);
    if (own !== undefined) return own;
    return typeof test.retriedTest === 'function' && test.retriedTest() ? ids.get(test.retriedTest()) : undefined;
  }

  const bail = projectBail();
  if (bail !== undefined) emit({ ev: 'config', bail });
  if (isParallel(runner)) emit({ ev: 'partial', reason: 'parallel' });

  // Mocha builds this reporter after it loaded the test files and before it
  // drops the tests a .only excludes, so the tree still holds every test.
  (function announce(suite) {
    (suite.tests || []).forEach((test) => {
      ids.set(test, ++seq);
      emit(Object.assign({ ev: 'found', id: seq, focused: isFocused(test) }, describe(test)));
    });
    (suite.suites || []).forEach(announce);
  })(runner.suite);

  function result(outcome, test, err) {
    emit(Object.assign({
      ev: 'result',
      id: idOf(test),
      outcome,
      duration: Math.round(test.duration || 0),
      err: serializeError(err),
    }, describe(test)));
  }

  runner.on('pass', (test) => result('passed', test));
  runner.on('pending', (test) => result('skipped', test));
  runner.on('retry', (test, err) => {
    emit(Object.assign({
      ev: 'retry',
      id: idOf(test),
      duration: Math.round(test.duration || 0),
      err: serializeError(err),
    }, describe(test)));
  });
  runner.on('fail', (runnable, err) => {
    if (runnable.type === 'hook') {
      const parent = runnable.parent;
      emit({
        ev: 'hook_fail',
        title: runnable.title,
        hookType: String(runnable.originalTitle || runnable.title).replace(/^"|" hook.*$/g, ''),
        scope: parent && parent.root ? '{root}' : parent ? parent.fullTitle() : '',
        scopePath: titlesOf(parent),
        file: fileOf(runnable),
        err: serializeError(err),
      });
      return;
    }
    result('failed', runnable, err);
  });
  // The resources are listed here, before Mocha's own exit, which would take
  // them with it. Then the Go side is told that all results are written: from
  // now on the process has a grace period to exit.
  runner.once('end', () => {
    const resources = openResources();
    emit(resources ? { ev: 'end', resources } : { ev: 'end' });
    announceEnd();
  });
}

module.exports = JspfReporter;
