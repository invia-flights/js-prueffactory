'use strict';
// Embedded helper of the schema.compile Check. It compiles every JSON Schema it
// is given with the toolset's Ajv, twice: without strict mode and with it. It
// never reads project files and never fetches anything: the schemas arrive
// parsed in the input, and a reference that points outside the given schemas is
// answered locally.
//
// Input:  { modules, schemas: [{ path, draft, schema }] }
//   modules  folder that holds the installed npm packages
//   draft    one of "draft-04", "draft-06", "draft-07", "2019-09", "2020-12"
// Output: { version, schemas: [{ path, draft, lax, strict, remote }] }
//   lax      null, or { kind, message }: a failure without strict mode
//   strict   null, or { kind, message }: a failure that only strict mode reports
//   remote   references to other hosts that were not fetched
//   kind     "invalid-schema", "unresolved-ref" or "compile-error" for lax,
//            "strict-mode" for strict
//
// A reference to a URL outside the project is answered with the empty schema,
// which accepts everything, so that the rest of the file still compiles. It is
// reported in `remote`. A reference that is relative, or that points at a
// project schema that does not exist, fails the compile.

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const requireTool = createRequire(path.join(input.modules, 'noop.js'));
const dflt = (m) => (m && m.default) || m;

const Ajv07 = dflt(requireTool('ajv'));
const Ajv2019 = dflt(requireTool('ajv/dist/2019'));
const Ajv2020 = dflt(requireTool('ajv/dist/2020'));
const Ajv04 = dflt(requireTool('ajv-draft-04'));
const addFormats = dflt(requireTool('ajv-formats'));
const draft06 = requireTool('ajv/dist/refs/json-schema-draft-06.json');
const version = requireTool('ajv/package.json').version;

function newAjv(draft, strict, loadSchema) {
  const opts = { strict, logger: false, allErrors: false, validateFormats: true, loadSchema };
  let ajv;
  switch (draft) {
    case 'draft-04': ajv = new Ajv04(opts); break;
    case '2019-09': ajv = new Ajv2019(opts); break;
    case '2020-12': ajv = new Ajv2020(opts); break;
    default:
      ajv = new Ajv07(opts);
      if (draft === 'draft-06') ajv.addMetaSchema(draft06);
  }
  addFormats(ajv);
  return ajv;
}

const idKey = (draft) => (draft === 'draft-04' ? 'id' : '$id');

// fileURI is the URI a schema without an id gets, so that relative references
// resolve against its folder. Every path segment is percent-encoded.
function fileURI(rel) {
  return 'file:///' + rel.split('/').map(encodeURIComponent).join('/');
}

function stripFragment(uri) {
  const i = uri.indexOf('#');
  return i < 0 ? uri : uri.slice(0, i);
}

// canon makes two spellings of one URI equal: no fragment, no empty fragment
// marker, percent-decoded.
function canon(uri) {
  const bare = stripFragment(String(uri));
  try { return decodeURI(bare); } catch (e) { return bare; }
}

// refStrings collects the string values of `$ref` keywords. A `$ref` below
// enum, const, default or examples is data and not a keyword.
function refStrings(node, out) {
  if (Array.isArray(node)) {
    for (const v of node) refStrings(v, out);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else if (k === 'enum' || k === 'const' || k === 'default' || k === 'examples') continue;
      else refStrings(v, out);
    }
  }
  return out;
}

const isAbsolute = (s) => /^[a-z][a-z0-9+.-]*:/i.test(s);

// byLocation maps every way a project schema can be named to the schema: its
// file URI and, when it has one, its id.
const byLocation = new Map();
for (const s of input.schemas) {
  byLocation.set(canon(fileURI(s.path)), s);
  const id = s.schema && typeof s.schema === 'object' ? s.schema[idKey(s.draft)] : undefined;
  if (typeof id === 'string' && !byLocation.has(canon(id))) byLocation.set(canon(id), s);
}

// describe is the first line of an error, with the synthetic file URIs turned
// back into the project paths they stand for.
function describe(e) {
  const line = String((e && e.message) || e).split('\n')[0];
  const shown = line.replace(/file:\/\/\/[^\s"']*/g, (m) => {
    try { return decodeURIComponent(m.slice('file:///'.length)); } catch (err) { return m; }
  });
  return shown.slice(0, 600);
}

function kindOf(e) {
  const m = String((e && e.message) || e);
  if (/can't resolve reference|cannot be resolved/i.test(m) || (e && e.missingRef)) return 'unresolved-ref';
  if (/schema is invalid|strict mode:|^Error: schema/i.test(m)) return 'invalid-schema';
  return 'compile-error';
}

async function compile(target, strict) {
  const draft = target.draft;
  const remote = new Set();
  const key = idKey(draft);
  const doc = JSON.parse(JSON.stringify(target.schema));
  const ownId = typeof doc[key] === 'string' && doc[key] !== '' ? doc[key] : null;
  if (!ownId) doc[key] = fileURI(target.path);
  const base = ownId ? ownId.replace(/[^/]*$/, '') : '';
  const written = new Set(refStrings(target.schema, []).filter(isAbsolute).map(canon));

  const loadSchema = async (uri) => {
    const found = byLocation.get(canon(uri));
    if (found) {
      const copy = JSON.parse(JSON.stringify(found.schema));
      if (typeof copy[idKey(found.draft)] !== 'string' || copy[idKey(found.draft)] === '') {
        copy[idKey(found.draft)] = fileURI(found.path);
      }
      return copy;
    }
    // Outside the project. The reference counts as remote when the file wrote
    // its absolute URL, or when it does not resolve into the folder of the
    // file's own id (a relative reference that went wrong).
    const asLocal = uri.startsWith('file:') || (base !== '' && canon(uri).startsWith(canon(base)) && !written.has(canon(uri)));
    if (asLocal) throw new Error("can't resolve reference " + uri + ' from the project files');
    remote.add(stripFragment(uri));
    return {};
  };
  const ajv = newAjv(draft, strict, loadSchema);

  try {
    await ajv.compileAsync(doc);
    return { error: null, remote: [...remote] };
  } catch (e) {
    return { error: { kind: strict ? 'strict-mode' : kindOf(e), message: describe(e) }, remote: [...remote] };
  }
}

async function main() {
  const out = [];
  for (const target of input.schemas) {
    const lax = await compile(target, false);
    const result = { path: target.path, draft: target.draft, lax: lax.error, strict: null, remote: lax.remote };
    if (!lax.error) {
      const strict = await compile(target, true);
      if (strict.error) result.strict = { kind: 'strict-mode', message: strict.error.message };
    }
    out.push(result);
  }
  process.stdout.write(JSON.stringify({ version, schemas: out }));
}

main().catch((e) => {
  process.stderr.write(String((e && e.stack) || e) + '\n');
  process.exit(2);
});
