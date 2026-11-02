// Shared by the lockfile tests.

export const text = (s: string): Uint8Array => new TextEncoder().encode(s);

// Repeat stands for prefix + open*count + middle + close*count + suffix:
// deeply nested documents, kept short in the fixture.
export interface Repeat {
  prefix: string;
  open: string;
  middle: string;
  close: string;
  suffix: string;
  count: number;
}

// docBytes returns the bytes of a recorded document: doc as UTF-8, b64 for
// documents that are not valid UTF-8, or a repeat.
export function docBytes(c: {
  doc?: string;
  b64?: string;
  repeat?: Repeat;
}): Uint8Array {
  if (c.repeat) {
    const r = c.repeat;
    return text(
      r.prefix +
        r.open.repeat(r.count) +
        r.middle +
        r.close.repeat(r.count) +
        r.suffix,
    );
  }
  return c.b64 === undefined ? text(c.doc ?? "") : Buffer.from(c.b64, "base64");
}

export const v3Lock = `{
  "name": "x", "lockfileVersion": 3, "requires": true,
  "packages": {
    "": {"name": "x", "dependencies": {"a": "^1.0.0"}, "devDependencies": {"b": "~2.1.0"}},
    "node_modules/a": {"version": "1.2.0", "resolved": "https://registry.npmjs.org/a/-/a-1.2.0.tgz", "integrity": "sha512-aaa", "license": "MIT", "hasInstallScript": true},
    "node_modules/b": {"version": "2.1.4", "dev": true, "license": "(MIT OR Apache-2.0)"},
    "node_modules/l": {"resolved": "../l", "link": true}
  }
}`;
