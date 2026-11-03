import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  shownCommand,
  shownGlob,
  shownGlobbedPath,
  shownLockKey,
  shownPackage,
  shownPath,
  shownSpecifier,
} from "./shown_text.ts";

const pathPlaceholder = "(path with unusual characters)";

// Paths of file-system routers (Next.js, SvelteKit, Remix, Nuxt) hold
// brackets, parentheses and braces; they are legitimate path characters.
const routePaths = [
  "src/app/[id]/page.tsx",
  "src/app/(group)/layout.tsx",
  "src/routes/{id}/+page.ts",
  "pages/[...slug].js",
  "app/[locale]/(shop)/[[...rest]]/page.tsx",
  "(group)/x.js",
  "[id]/x.js",
];

// Text that would read as markup or as a second line of trusted text.
const unsafe = [
  "a b",
  "a\tb",
  "a\nb",
  "a\u0000b",
  "a\u0085b",
  "a'b",
  'a"b',
  "a`b",
  "a<b",
  "<x>",
  "[a](b)",
  "src/[x](http://evil.test)/y.js",
  "src/a](b).js",
];

describe("the shown* helpers for paths and specifiers", () => {
  it("shownPath keeps route-style folders", () => {
    for (const p of routePaths) {
      assert.equal(shownPath(p), p);
    }
  });

  it("shownGlobbedPath keeps route-style folders and glob characters", () => {
    for (const p of [...routePaths, "src/**/*.[jt]s", "a/b?.js", "x/!(a).js"]) {
      assert.equal(shownGlobbedPath(p), p);
    }
  });

  it("shownGlob keeps route-style folders and wildcards", () => {
    for (const p of [...routePaths, "ci/*.yml", "ci/${NAME}/x.yml"]) {
      assert.equal(shownGlob(p), p);
    }
  });

  it("shownSpecifier keeps route-style folders", () => {
    for (const p of [
      "./[id]/page",
      "../(group)/x",
      "./{id}/x",
      "~/pages/[slug]",
    ]) {
      assert.equal(shownSpecifier(p), p);
    }
  });

  it("shownLockKey keeps the folder of a workspace named like a route", () => {
    for (const p of [
      "apps/[id]",
      "packages/(group)/a",
      "node_modules/@s/b",
      "packages/{x}",
    ]) {
      assert.equal(shownLockKey(p), p);
    }
  });

  it("every path helper replaces markup, quotes, space and control characters", () => {
    for (const s of unsafe) {
      assert.equal(shownPath(s), pathPlaceholder, JSON.stringify(s));
      assert.equal(shownGlobbedPath(s), pathPlaceholder, JSON.stringify(s));
      assert.equal(shownGlob(s), pathPlaceholder, JSON.stringify(s));
      assert.equal(
        shownSpecifier(s),
        "(import specifier with unusual characters)",
        JSON.stringify(s),
      );
      assert.equal(
        shownLockKey(s),
        "(lockfile entry with unusual characters)",
        JSON.stringify(s),
      );
    }
  });

  it("a parent folder is not shown in a path, an include or an import may climb", () => {
    for (const s of ["a/../b", "../x", ".."]) {
      assert.equal(shownPath(s), pathPlaceholder, s);
      assert.equal(shownGlobbedPath(s), pathPlaceholder, s);
      assert.equal(shownLockKey(s), "(lockfile entry with unusual characters)");
    }
    assert.equal(shownPath("pages/[...slug].js"), "pages/[...slug].js");
    assert.equal(shownGlob("../../x.yml"), "../../x.yml");
    assert.equal(shownSpecifier("../x"), "../x");
  });

  it("a folder named like a Markdown link is not shown", () => {
    const hostile = "src/[docs](https://evil.test)/index.js";
    assert.equal(shownPath(hostile), pathPlaceholder);
    assert.equal(shownGlob(hostile), pathPlaceholder);
    assert.equal(shownGlobbedPath(hostile), pathPlaceholder);
  });
});

describe("shownPackage", () => {
  it("shows npm package names as they are", () => {
    for (const name of ["old-buffer", "@scope/tr46", "left_pad", "a.b~c"]) {
      assert.equal(shownPackage(name), name);
    }
  });

  it("replaces anything else", () => {
    for (const name of [
      "we ird",
      "x`y",
      "@a/b/c",
      "",
      "x\n",
      "a".repeat(300),
    ]) {
      assert.equal(
        shownPackage(name),
        "(package name with unusual characters)",
        JSON.stringify(name),
      );
    }
  });
});

describe("shownCommand", () => {
  it("is not widened by the path rule", () => {
    assert.equal(
      shownCommand("deploy [x](y)"),
      "(command with unusual characters)",
    );
  });
});

describe("shownSpecifier", () => {
  it("shows a relative path with folders named after route parameters", () => {
    const s = "./../../docs/json/flight/{flightStoreToken}/products/put/schema";
    assert.equal(shownSpecifier(s), s);
  });

  it("shows packages, scoped packages and aliases as they are", () => {
    for (const s of ["lodash", "@app/x", "~/x", "#lib/x", "node:fs"]) {
      assert.equal(shownSpecifier(s), s);
    }
  });
});
