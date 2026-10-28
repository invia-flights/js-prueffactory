'use strict';

// Helper of schema.drift. It reads a copy of the project that generator scripts
// ran in and never runs any of the project's code.
//
//   node schema-drift.js manifest <root>
//     prints {"files": {<path>: <sha256>}} for the regular files below root,
//     leaving out node_modules and .git folders.
//
//   node schema-drift.js compare <root> <snapshot> <manifest.json>
//     prints the files whose content differs from the manifest taken before the
//     generators ran: "changed" holds those that exist in the snapshot with
//     other bytes, with their content in base64, and "created" those that are in
//     neither the manifest nor the snapshot.
//
// Links and special files are skipped, so nothing the generators linked to is
// ever read.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// A changed file over this many bytes is reported without its content, and the
// content of all changed files together stays within the total, so the answer
// fits what the caller reads.
const MAX_FILE = 4 * 1024 * 1024;
const MAX_TOTAL = 12 * 1024 * 1024;
const SKIPPED_DIRS = new Set(['node_modules', '.git']);

function* walk(root, rel = '') {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const next = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIPPED_DIRS.has(e.name)) yield* walk(root, next);
    } else if (e.isFile()) {
      yield next;
    }
  }
}

// sha256 streams the file, so that a large one never sits in memory.
function sha256(file) {
  const hash = crypto.createHash('sha256');
  const buf = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    for (let n = fs.readSync(fd, buf, 0, buf.length, null); n > 0; n = fs.readSync(fd, buf, 0, buf.length, null)) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function regularFile(file) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

const [mode, root, snapshot, manifestPath] = process.argv.slice(2);

if (mode === 'manifest') {
  const files = {};
  for (const rel of walk(root)) files[rel] = sha256(path.join(root, rel));
  process.stdout.write(JSON.stringify({ files }));
} else if (mode === 'compare') {
  const before = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files;
  const out = { changed: [], created: [] };
  let total = 0;
  for (const rel of walk(root)) {
    const file = path.join(root, rel);
    const known = Object.prototype.hasOwnProperty.call(before, rel);
    if (known && before[rel] === sha256(file)) continue;
    const there = regularFile(path.join(snapshot, rel));
    if (!there) {
      if (!known) out.created.push({ path: rel, size: fs.lstatSync(file).size });
      continue;
    }
    const size = fs.lstatSync(file).size;
    if (size > MAX_FILE || total + size > MAX_TOTAL) {
      if (size !== there.size || sha256(file) !== sha256(path.join(snapshot, rel))) {
        out.changed.push({ path: rel, size, too_large: true });
      }
      continue;
    }
    const content = fs.readFileSync(file);
    if (content.equals(fs.readFileSync(path.join(snapshot, rel)))) continue;
    total += size;
    out.changed.push({ path: rel, size, content: content.toString('base64') });
  }
  process.stdout.write(JSON.stringify(out));
} else {
  process.stderr.write('usage: schema-drift.js manifest <root> | compare <root> <snapshot> <manifest>\n');
  process.exit(2);
}
