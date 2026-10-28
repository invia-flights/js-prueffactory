'use strict';
// Embedded helper of the registry-data step (deps.deprecated, deps.outdated). It
// asks the npm registry about the packages of a lockfile and prints one JSON
// document on stdout. It reads its input from the JSON file named by argv[2].
//
// Input:  { npmrc, packages: [{ name, versions, direct }], concurrency,
//           request_timeout_ms, deadline_ms }
//   npmrc     the text of the project's .npmrc, or ""
//   direct    true for a direct dependency: it gets the full packument, which
//             has publication times. Every other package gets the abbreviated
//             packument, which has the per-version deprecation text.
//   deadline_ms  how long the whole step may take; packages that are not
//             answered by then are unknown with the error "deadline"
// Output: { fetched_at, packages: [{ name, status, registry, http_status, error,
//           latest, latest_deprecated, versions: { <version>: { deprecated, published } } }] }
//
// A package's registry is resolved the way npm does it: the scope's
// `@scope:registry`, otherwise `registry`, otherwise the public registry. The
// credentials are those of the .npmrc entry whose `//host/path/` prefix matches
// the registry, and a `${VAR}` that is not set means no credential. Nothing of
// the host's environment gets here, and no secret is ever printed.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const concurrency = Math.max(1, Math.min(8, input.concurrency || 8));
const requestTimeoutMs = input.request_timeout_ms || 30000;
const deadline = Date.now() + (input.deadline_ms || 270000);
const maxBody = 128 * 1024 * 1024;
const maxText = 16 * 1024;

const ABBREVIATED = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';
const FULL = 'application/json';

// --- .npmrc ---

function interpolate(value) {
  let missing = false;
  const text = value.replace(/(\\*)\$\{([^}]+)\}/g, (all, slashes, name) => {
    if (slashes.length % 2) return all.slice(slashes.length - 1);
    const v = process.env[name];
    if (v === undefined) { missing = true; return ''; }
    return slashes.slice(slashes.length / 2) + v;
  });
  return missing ? null : text;
}

function parseNpmrc(text) {
  const config = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === ';' || line[0] === '#') continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    config.set(key, interpolate(value));
  }
  return config;
}

const npmrc = parseNpmrc(input.npmrc);
const defaultRegistry = 'https://registry.npmjs.org/';

function registryFor(name) {
  if (name[0] === '@') {
    const scope = name.slice(0, name.indexOf('/'));
    const own = npmrc.get(scope + ':registry');
    if (own) return withSlash(own);
  }
  return withSlash(npmrc.get('registry') || defaultRegistry);
}

function withSlash(u) { return u.endsWith('/') ? u : u + '/'; }

// credentials returns the Authorization header value for a registry URL, or
// null. npm looks the entries up under `//host[:port]/path/`, from the longest
// path to the shortest.
function credentials(registryUrl) {
  const u = new URL(registryUrl);
  let path = u.pathname;
  for (;;) {
    const nerf = '//' + u.host + path;
    const token = npmrc.get(nerf + ':_authToken');
    if (token) return 'Bearer ' + token;
    const auth = npmrc.get(nerf + ':_auth');
    if (auth) return 'Basic ' + auth;
    const user = npmrc.get(nerf + ':username');
    const pass = npmrc.get(nerf + ':_password');
    if (user && pass) return 'Basic ' + Buffer.from(user + ':' + Buffer.from(pass, 'base64').toString('utf8')).toString('base64');
    if (path === '/' || path === '') break;
    path = path.replace(/[^/]*\/$/, '');
    if (path === '') path = '/';
  }
  const token = npmrc.get('_authToken');
  if (token) return 'Bearer ' + token;
  const auth = npmrc.get('_auth');
  if (auth) return 'Basic ' + auth;
  return null;
}

const strictSsl = npmrc.get('strict-ssl') !== 'false';

// --- requests ---

class Failure extends Error {
  constructor(error, httpStatus) { super(error || ('HTTP ' + httpStatus)); this.error = error || ''; this.httpStatus = httpStatus || 0; }
}

function get(registryUrl, name, accept) {
  return new Promise((resolve, reject) => {
    const target = new URL(registryUrl + name.replace('/', '%2f'));
    const lib = target.protocol === 'http:' ? http : https;
    const headers = { accept, 'user-agent': 'js-prueffactory registry-data', 'accept-encoding': 'identity' };
    const auth = credentials(registryUrl);
    if (auth) headers.authorization = auth;
    const options = { method: 'GET', headers, timeout: requestTimeoutMs };
    if (target.protocol === 'https:' && !strictSsl) options.rejectUnauthorized = false;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new Failure('deadline'));
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const req = lib.request(target, options, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBody) { req.destroy(); finish(reject, new Failure('too_large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) finish(resolve, Buffer.concat(chunks).toString('utf8'));
        else finish(reject, new Failure('', res.statusCode));
      });
      res.on('error', (e) => finish(reject, new Failure(e.code || 'error')));
    });
    // The step's own deadline and the per-request limit, whichever is first.
    const timer = setTimeout(() => {
      const why = deadline - Date.now() <= 0 ? 'deadline' : 'timeout';
      req.destroy();
      finish(reject, new Failure(why));
    }, Math.min(remaining, requestTimeoutMs));
    req.on('timeout', () => { req.destroy(); finish(reject, new Failure('timeout')); });
    req.on('error', (e) => finish(reject, new Failure(e.code || 'error')));
    req.end();
  });
}

// getWithRetry tries once more after a connection problem, a server error or
// HTTP 429. Refusals (401, 403, 404) are answers and are not retried.
async function getWithRetry(registryUrl, name, accept) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await get(registryUrl, name, accept);
    } catch (e) {
      const retry = attempt < 2 && e.error !== 'deadline' && (e.httpStatus === 0 || e.httpStatus === 429 || e.httpStatus >= 500);
      if (!retry) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

function text(v) {
  if (typeof v === 'string') return v.length > maxText ? v.slice(0, maxText) : v;
  if (v === true) return 'deprecated';
  return '';
}

async function answer(pkg) {
  const registry = registryFor(pkg.name);
  const base = { name: pkg.name, registry: new URL(registry).host };
  try {
    const body = await getWithRetry(registry, pkg.name, pkg.direct ? FULL : ABBREVIATED);
    const doc = JSON.parse(body);
    const versions = doc.versions && typeof doc.versions === 'object' ? doc.versions : {};
    const times = pkg.direct && doc.time && typeof doc.time === 'object' ? doc.time : {};
    const latest = doc['dist-tags'] && typeof doc['dist-tags'].latest === 'string' ? doc['dist-tags'].latest : '';
    const wanted = new Set(pkg.versions);
    if (latest) wanted.add(latest);
    const out = {};
    for (const v of wanted) {
      const entry = { deprecated: versions[v] ? text(versions[v].deprecated) : '', published: '' };
      if (typeof times[v] === 'string') entry.published = times[v];
      out[v] = entry;
    }
    return {
      ...base, status: 'ok', latest,
      latest_deprecated: latest && versions[latest] ? text(versions[latest].deprecated) : '',
      versions: out,
    };
  } catch (e) {
    if (e instanceof SyntaxError) return { ...base, status: 'unknown', error: 'invalid_json' };
    return { ...base, status: 'unknown', http_status: e.httpStatus || 0, error: e.error || 'error' };
  }
}

async function main() {
  const packages = input.packages || [];
  const results = new Array(packages.length);
  let next = 0;
  const worker = async () => {
    while (next < packages.length) {
      const i = next++;
      results[i] = await answer(packages[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, packages.length) }, worker));
  process.stdout.write(JSON.stringify({ fetched_at: new Date().toISOString(), packages: results }));
}

main().catch((e) => {
  process.stderr.write(String((e && e.stack) || e) + '\n');
  process.exit(1);
});
