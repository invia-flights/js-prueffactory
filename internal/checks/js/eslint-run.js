'use strict';
// Embedded helper of the combined ESLint run. It generates a flat config for
// the rule groups it is given, runs the toolset's ESLint once over the listed
// files and prints one JSON document on stdout. The project's own ESLint
// configuration and its inline directives never take part: the run uses
// --no-config-lookup and --no-inline-config.
//
// Input:  { eslint, globals, tools, root,
//           groups: [{ id, core_problem, except, core_options, plugins: [name],
//                      rules: [{ name, options, measure }], test_only, source_only, settings }],
//           files: [{ path, source_type }], test_files: [path], source_files: [path], mocha }
//         eslint and globals are the folders of the toolset's packages, tools
//         is the folder that holds all of them (the plugins too), root is the
//         package folder in the Snapshot, and all file paths are relative to
//         root. A group's rules come on top of its core problem rules; their
//         names carry the plugin's prefix. core_options maps the name of a core
//         problem rule to its options, with the rule still a warning. A rule
//         with a measure is a measuring rule: its hits are not messages but
//         measures.
// Output: { version, exit_code, command, config, groups: { id: [rule] },
//           results: [{ path, messages: [{ rule_id, message, line, column,
//           end_line, end_column, fatal }] }], dropped_messages,
//           measures: [{ path, kind, line, column, value, name }],
//           measures_dropped, measures_unreadable }
//
// Paths come from the project. They are given to ESLint after `--` and with a
// `./` prefix, so that a name such as "-x.js" never reads as an option, and the
// helper looks at each file again: only regular files below the size cap go in.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 20000;
const MAX_MEASURES = 100000;
// Stay far below the operating system's limit for the length of arguments.
const MAX_ARGV_BYTES = 900 * 1024;
const TIMEOUT_MS = 9 * 60 * 1000;

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const eslintRequire = createRequire(path.join(input.eslint, 'package.json'));
const version = eslintRequire('./package.json').version;
const { builtinRules } = eslintRequire('eslint/use-at-your-own-risk');
const globals = createRequire(path.join(input.globals, 'package.json'))('./index.js');

// escapeGlob makes a file path a literal pattern for the config's `files`.
function escapeGlob(p) {
  return p.replace(/[\\*?[\]{}()!+@#]/g, '\\$&');
}

function sortedGlobals(set) {
  const out = {};
  for (const name of Object.keys(set).sort()) out[name] = set[name];
  return out;
}

// The plugins of the toolset that groups may use: the folder of the package and
// the file that holds the plugin object. Both are fixed by the pinned versions.
const PLUGINS = {
  mocha: { dir: 'eslint-plugin-mocha', entry: 'plugin.js' },
  n: { dir: 'eslint-plugin-n', entry: 'lib/index.js' },
  sonarjs: { dir: 'eslint-plugin-sonarjs', entry: 'cjs/plugin.js' },
};

// The rules of each group. Core problem rules go into the base config object,
// and the explicit rules of a group get a config object of their own, so that
// a group's plugins, settings and files scope stay with it.
const groupRules = {};
const rules = {};
const groupConfigs = [];
const pluginVersions = {};
const measureKinds = {};
for (const group of input.groups) {
  let list = [];
  if (group.core_problem) {
    const except = new Set(group.except || []);
    for (const [name, rule] of builtinRules) {
      const meta = rule.meta || {};
      if (meta.type === 'problem' && !meta.deprecated && !except.has(name)) list.push(name);
    }
  }
  list = list.sort();
  const coreOptions = group.core_options || {};
  for (const name of list) rules[name] = ['warn', ...(coreOptions[name] || [])];

  const explicit = {};
  for (const rule of group.rules || []) {
    explicit[rule.name] = ['warn', ...(rule.options || [])];
    list.push(rule.name);
    if (rule.measure) measureKinds[rule.name] = rule.measure;
  }
  groupRules[group.id] = list.sort();
  for (const name of group.plugins || []) {
    const plugin = PLUGINS[name];
    if (!plugin) throw new Error('unknown plugin ' + name);
    pluginVersions[name] = JSON.parse(fs.readFileSync(path.join(input.tools, plugin.dir, 'package.json'), 'utf8')).version;
  }
  if (Object.keys(explicit).length > 0) {
    const config = { plugins: group.plugins || [], rules: explicit };
    if (group.settings && Object.keys(group.settings).length > 0) config.settings = group.settings;
    if (group.test_only) {
      // Test code only, and nothing when there is none.
      if (input.test_files.length > 0) config.files = input.test_files.map(escapeGlob);
      else continue;
    }
    if (group.source_only) {
      // Source code only, and nothing when there is none.
      if (input.source_files.length > 0) config.files = input.source_files.map(escapeGlob);
      else continue;
    }
    groupConfigs.push(config);
  }
}

const nodeGlobals = sortedGlobals(globals.node);
const mochaGlobals = sortedGlobals(globals.mocha);
const jsFile = input.files.find((f) => f.path.endsWith('.js'));
const jsSourceType = jsFile ? jsFile.source_type : 'commonjs';

const flatConfig = [
  {
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
    languageOptions: { ecmaVersion: 'latest', globals: nodeGlobals },
    rules,
  },
  { files: ['**/*.mjs'], languageOptions: { sourceType: 'module' } },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
  { files: ['**/*.js'], languageOptions: { sourceType: jsSourceType } },
];
if (input.mocha && input.test_files.length > 0) {
  flatConfig.push({ files: input.test_files.map(escapeGlob), languageOptions: { globals: mochaGlobals } });
}
flatConfig.push(...groupConfigs);

// The description of the config holds what decides the rules and globals, and
// nothing that is specific to the project. Its hash goes into the Benchmark
// fingerprint.
const description = {
  eslint: version,
  language: { ecma_version: 'latest', source_types: { '.cjs': 'commonjs', '.js': 'package type', '.mjs': 'module' } },
  linter_options: { no_inline_config: true, report_unused_disable_directives: 'off' },
  globals: { node: nodeGlobals, mocha: mochaGlobals },
  groups: {},
};
for (const group of input.groups) {
  const entry = { severity: 'warn', rules: groupRules[group.id] };
  const options = {};
  for (const [name, list] of Object.entries(group.core_options || {})) {
    if (list.length > 0 && groupRules[group.id].includes(name)) options[name] = list;
  }
  for (const rule of group.rules || []) if ((rule.options || []).length > 0) options[rule.name] = rule.options;
  if (Object.keys(options).length > 0) entry.rule_options = options;
  if ((group.plugins || []).length > 0) {
    entry.plugins = {};
    for (const name of group.plugins) entry.plugins[name] = pluginVersions[name];
  }
  if (group.test_only) entry.test_only = true;
  if (group.source_only) entry.source_only = true;
  if (group.settings && Object.keys(group.settings).length > 0) entry.settings = group.settings;
  description.groups[group.id] = entry;
}

// The config is an ES module, because the plugins are loaded from their files.
// Plugin names in the generated objects are replaced by the plugin objects.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eslint-'));
const configFile = path.join(work, 'eslint.config.mjs');
const pluginImports = Object.keys(pluginVersions).map((name) => {
  const url = pathToFileURL(path.join(input.tools, PLUGINS[name].dir, PLUGINS[name].entry)).href;
  return '  ' + JSON.stringify(name) + ': await load(' + JSON.stringify(url) + ')';
});
fs.writeFileSync(configFile, [
  'const load = async (url) => { const m = await import(url); return m.default ?? m; };',
  'const plugins = {',
  pluginImports.join(',\n'),
  '};',
  'const config = ' + JSON.stringify(flatConfig) + ';',
  'for (const c of config) if (c.plugins) c.plugins = Object.fromEntries(c.plugins.map((n) => [n, plugins[n]]));',
  'export default config;',
  '',
].join('\n'));

const files = input.files.filter((f) => {
  try {
    const info = fs.lstatSync(path.join(input.root, f.path));
    return info.isFile() && info.size <= MAX_FILE_BYTES;
  } catch (e) {
    return false;
  }
});

const baseArgs = [
  path.join(input.eslint, 'bin', 'eslint.js'),
  '--no-config-lookup', '--no-inline-config', '--config', configFile, '--format', 'json',
];

// Batches keep the argument list short. A normal package is one batch, which is
// one ESLint run.
const batches = [];
let batch = [];
let size = 0;
for (const f of files) {
  const arg = './' + f.path;
  if (batch.length > 0 && size + arg.length + 1 > MAX_ARGV_BYTES) {
    batches.push(batch);
    batch = [];
    size = 0;
  }
  batch.push(arg);
  size += arg.length + 1;
}
if (batch.length > 0) batches.push(batch);

// How each measuring rule says its value. The rules are pinned, and a message
// that does not match is counted, not guessed at.
const MEASURE_READERS = {
  // "Function 'f' has a complexity of 7. Maximum allowed is 0."
  cyclomatic: (text) => {
    const m = /^(.*?) has a complexity of (\d+)\./.exec(text);
    return m && { value: Number(m[2]), name: m[1].slice(0, 80) };
  },
  // "Function 'f' has too many lines (4). Maximum allowed is 0."
  length: (text) => {
    const m = /^(.*?) has too many lines \((\d+)\)\./.exec(text);
    return m && { value: Number(m[2]), name: m[1].slice(0, 80) };
  },
  // "Refactor this function to reduce its Cognitive Complexity from 11 to the 0 allowed."
  cognitive: (text) => {
    const m = /Cognitive Complexity from (\d+) to /.exec(text);
    return m && { value: Number(m[1]), name: '' };
  },
};

const results = [];
const measures = [];
let measuresDropped = 0;
let measuresUnreadable = 0;
let dropped = 0;
let total = 0;
let exitCode = 0;
batches.forEach((args, i) => {
  const outFile = path.join(work, 'out-' + i + '.json');
  const run = spawnSync(process.execPath, [...baseArgs, '--output-file', outFile, '--', ...args], {
    cwd: input.root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (run.error || run.status === null || run.status > 1) {
    const why = (run.error && run.error.message) || run.stderr || run.stdout || 'exit ' + run.status;
    throw new Error('eslint failed: ' + String(why).trim().slice(-800));
  }
  exitCode = Math.max(exitCode, run.status);
  for (const r of JSON.parse(fs.readFileSync(outFile, 'utf8'))) {
    const messages = [];
    const relPath = path.relative(input.root, r.filePath).split(path.sep).join('/');
    for (const m of r.messages) {
      // Messages without a rule that are not parse errors are notes about the
      // run itself, such as "this directive has no effect", and are no hits.
      if (!m.fatal && !m.ruleId) continue;
      // A hit of a measuring rule is a value, not a message.
      const kind = !m.fatal && measureKinds[m.ruleId];
      if (kind) {
        const read = MEASURE_READERS[kind](String(m.message));
        if (!read) {
          measuresUnreadable++;
        } else if (measures.length >= MAX_MEASURES) {
          measuresDropped++;
        } else {
          measures.push({ path: relPath, kind, line: m.line || 0, column: m.column || 0, value: read.value, name: read.name });
        }
        continue;
      }
      if (total >= MAX_MESSAGES) {
        dropped++;
        continue;
      }
      total++;
      messages.push({
        rule_id: m.ruleId || '', message: String(m.message), line: m.line || 0, column: m.column || 0,
        end_line: m.endLine || 0, end_column: m.endColumn || 0, fatal: m.fatal === true,
      });
    }
    if (messages.length > 0) {
      results.push({ path: relPath, messages });
    }
  }
});
results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
measures.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.column - b.column || (a.kind < b.kind ? -1 : 1)));

fs.rmSync(work, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
  version,
  exit_code: exitCode,
  command: [
    'node', 'eslint', '--no-config-lookup', '--no-inline-config', '--config', 'eslint.config.mjs', '--format', 'json',
    '--', files.length + ' files',
  ],
  config: description,
  groups: groupRules,
  results,
  dropped_messages: dropped,
  measures,
  measures_dropped: measuresDropped,
  measures_unreadable: measuresUnreadable,
}));
