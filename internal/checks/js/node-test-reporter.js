'use strict';

// js-prueffactory's node:test reporter. `node --test` loads it with
// --test-reporter, and it learns where to write from the JSPF_EVENTS
// environment variable, the same one the Mocha reporter reads.
//
// It appends one JSON event per line and writes each line before it returns,
// so the results survive a crash or a timeout. The format is internal; the Go
// side (test_events.go) is its only reader, and it is the format of the Mocha
// reporter (mocha-reporter.js). Events:
//
//   found      a test that starts, before it runs
//   result     the final outcome of one test: passed, failed, skipped, todo
//   hook_fail  a hook that threw, with its scope
//   file_fail  a test file whose process failed as a whole: it did not load,
//              or it stopped before it was finished
//   end        the run finished
//
// A test that node cancels because its suite failed gets a found event and no
// result, so it counts as never run. Tests of a file that did not load are not
// known. The reporter yields only what the tests wrote to stdout, because the
// destination ends up in the suite's log; stderr goes to stderr.
//
// It supports Node 22, 24 and 26: it uses only the events test:enqueue,
// test:start, test:pass, test:fail, test:stdout and test:stderr, and reads no
// field that the oldest of them lacks.

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

// serializeError turns the error of a failed test, which node wraps in a
// TestError whose `cause` is what the test threw, into the event's error.
function serializeError(wrapper) {
  if (wrapper === undefined || wrapper === null) return null;
  const cause = wrapper.cause !== null && typeof wrapper.cause === 'object' ? wrapper.cause : null;
  const hasMessage = cause && typeof cause.message === 'string';
  const out = {
    name: cause && typeof cause.name === 'string' ? cause.name : typeof wrapper.name === 'string' ? wrapper.name : 'Error',
    message: cap(hasMessage ? cause.message : wrapper.message !== undefined ? wrapper.message : String(wrapper)),
    stack: cause && typeof cause.stack === 'string' && cause.stack !== 'undefined' ? cap(cause.stack) : '',
  };
  if (cause && cause.showDiff !== false && ('expected' in cause || 'actual' in cause)) {
    if (cause.expected !== undefined) out.expected = show(cause.expected);
    if (cause.actual !== undefined) out.actual = show(cause.actual);
  }
  return out;
}

const cwd = process.cwd();

function absolute(file) {
  return file ? path.resolve(cwd, String(file)) : '';
}

// isFileTest is true for the test node makes up for each test file: it runs the
// file's process and has the file's own path as its name.
function isFileTest(data) {
  if (data.nesting !== 0 || data.line !== 1 || data.column !== 1 || !data.file) return false;
  return data.name === path.relative(cwd, absolute(data.file)) || data.name === absolute(data.file);
}

function keyOf(data) {
  return [absolute(data.file), data.line, data.column, data.name].join('\u0000');
}

function hookTypeOf(message) {
  const m = /failed running (\w+) hook/.exec(String(message));
  return m ? m[1] : '';
}

async function* JspfReporter(source) {
  // What each file has started, by nesting, so that a test knows the names of
  // the suites around it. Tests of one file run one after the other, and
  // events of different files do not share a stack.
  const stacks = new Map();
  const kinds = new Map(); // keyOf -> 'test' | 'suite', from test:enqueue
  const stderrOf = new Map(); // absolute file -> the tail of its stderr

  function pathOf(data) {
    const stack = stacks.get(absolute(data.file)) || [];
    return stack.slice(0, data.nesting || 0).filter((n) => n !== undefined);
  }

  function describe(data) {
    const suitePath = pathOf(data);
    return {
      file: absolute(data.file),
      title: data.name,
      fullTitle: suitePath.concat(data.name).join(' '),
      suitePath,
    };
  }

  function start(data) {
    if (isFileTest(data)) return;
    const file = absolute(data.file);
    if (!stacks.has(file)) stacks.set(file, []);
    const stack = stacks.get(file);
    stack.length = data.nesting || 0;
    stack[data.nesting || 0] = data.name;
    if (kinds.get(keyOf(data)) === 'suite') return;
    emit(Object.assign({ ev: 'found' }, describe(data)));
  }

  function fileResult(data, details) {
    const failure = details.error;
    // The tests of the file carry their own failures.
    if (!failure || failure.failureType === 'subtestsFailed') return;
    emit({
      ev: 'file_fail',
      file: absolute(data.file),
      err: serializeError(failure),
      text: cap(stderrOf.get(absolute(data.file)) || ''),
    });
  }

  function hookFailure(data, failure, scopePath) {
    const type = hookTypeOf(failure.message);
    emit({
      ev: 'hook_fail',
      title: type ? `"${type}" hook` : 'hook',
      hookType: type,
      scope: scopePath.length ? scopePath.join(' ') : '{root}',
      scopePath,
      file: absolute(data.file),
      err: serializeError(failure),
    });
    return type;
  }

  function finish(data, passed) {
    const details = data.details || {};
    if (isFileTest(data)) {
      if (!passed) fileResult(data, details);
      return;
    }
    const failure = passed ? null : details.error;
    if (details.type === 'suite') {
      if (failure && failure.failureType === 'hookFailed') {
        hookFailure(data, failure, describe(data).suitePath.concat(data.name));
      }
      return;
    }
    const info = describe(data);
    const result = (outcome, err) => emit(Object.assign({
      ev: 'result',
      outcome,
      duration: Math.round(details.duration_ms || 0),
      err,
    }, info));
    if (passed) {
      result(data.skip ? 'skipped' : data.todo ? 'todo' : 'passed', null);
      return;
    }
    switch (failure && failure.failureType) {
      case 'cancelledByParent':
        // Never run: the suite around it failed or was cancelled.
        return;
      case 'hookFailed': {
        const type = hookFailure(data, failure, info.suitePath);
        // A test whose beforeEach failed never ran. One whose afterEach
        // failed did run, and node counts it as failed.
        if (type === 'afterEach' || type === 'after') result('failed', serializeError(failure));
        return;
      }
      default:
        result(data.skip ? 'skipped' : data.todo ? 'todo' : 'failed', serializeError(failure));
    }
  }

  try {
    for await (const event of source) {
      try {
        const data = event.data;
        switch (event.type) {
          case 'test:enqueue':
            kinds.set(keyOf(data), data.type);
            break;
          case 'test:start':
            start(data);
            break;
          case 'test:pass':
            finish(data, true);
            break;
          case 'test:fail':
            finish(data, false);
            break;
          case 'test:stdout':
            yield data.message;
            break;
          case 'test:stderr': {
            const file = absolute(data.file);
            stderrOf.set(file, (stderrOf.get(file) || '') + data.message);
            if (stderrOf.get(file).length > 2 * MAX_TEXT) stderrOf.set(file, stderrOf.get(file).slice(-MAX_TEXT));
            process.stderr.write(data.message);
            break;
          }
          default:
            break;
        }
      } catch (e) {
        // A reporter that throws would hide the results of the project's tests.
      }
    }
  } finally {
    // No list of open resources: every test file runs in its own process, and
    // this one is only the parent.
    emit({ ev: 'end' });
    try {
      // Tells the Go side that all results are written: from now on the
      // process has a grace period to exit.
      if (process.env.JSPF_END_MARKER) fs.writeSync(2, process.env.JSPF_END_MARKER + '\n');
    } catch (e) {
      // The grace period is a safeguard and must not turn into a failure.
    }
  }
}

module.exports = JspfReporter;
