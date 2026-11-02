import assert from "node:assert/strict";
import { test } from "node:test";

import { cacheDir } from "./cachedir.ts";

test("the cache folder follows XDG_CACHE_HOME, then HOME", () => {
  const cases: [string, Record<string, string>, string][] = [
    ["XDG_CACHE_HOME wins", { XDG_CACHE_HOME: "/x/cache", HOME: "/home/me" }, "/x/cache/js-prueffactory"],
    ["HOME is the fallback", { HOME: "/home/me" }, "/home/me/.cache/js-prueffactory"],
    ["a relative XDG_CACHE_HOME is ignored, as the XDG spec says", { XDG_CACHE_HOME: "cache", HOME: "/home/me" }, "/home/me/.cache/js-prueffactory"],
    ["the paths are cleaned", { XDG_CACHE_HOME: "/x//cache/" }, "/x/cache/js-prueffactory"],
  ]; // prettier-ignore
  for (const [name, env, want] of cases) {
    assert.equal(
      cacheDir((k) => env[k] ?? ""),
      want,
      name,
    );
  }
});

test("without XDG_CACHE_HOME and HOME the cache folder is in the temporary folder", () => {
  const tmp = process.env.TMPDIR;
  try {
    process.env.TMPDIR = "/some/tmp/";
    assert.equal(
      cacheDir(() => ""),
      "/some/tmp/js-prueffactory-cache",
    );
    delete process.env.TMPDIR;
    assert.equal(
      cacheDir(() => ""),
      "/tmp/js-prueffactory-cache",
    );
  } finally {
    if (tmp !== undefined) {
      process.env.TMPDIR = tmp;
    }
  }
});
