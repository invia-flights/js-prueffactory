import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { catalog, type Entry, Implemented, Planned } from "./catalog.ts";
import { resolve, resolveFast } from "./selection.ts";

// A small Catalog: the real one grows as Checks are implemented, and Selection
// rules must not depend on which Checks exist today.
function entry(
  id: string,
  status: Entry["status"],
  skippedByFast = false,
): Entry {
  return {
    id,
    family: id.slice(0, id.indexOf(".")),
    description: "",
    scope: "package",
    canFireGates: false,
    area: "",
    status,
    skippedByFast,
  };
}

const entries: Entry[] = [
  entry("security.secrets", Implemented),
  entry("security.dependencies", Implemented),
  entry("security.containers", Planned),
  entry("tests.existing", Implemented),
  entry("tests.mutation", Planned),
  entry("sbom.generate", Planned),
  entry("syntax.parse", Implemented),
];

test("without --only the whole implemented Catalog is selected", () => {
  const sel = resolve(entries, [], []);
  assert.deepEqual(sel.effective, [
    "security.secrets",
    "security.dependencies",
    "tests.existing",
    "syntax.parse",
  ]);
  assert.deepEqual(sel.deselected, []);
  assert.equal(sel.isStandardScope, true);
});

test("--only builds the union of IDs and families in Catalog order", () => {
  // One flag with a comma list, and a repeated flag.
  const sel = resolve(entries, ["syntax.parse,security"], []);
  assert.deepEqual(sel.effective, [
    "security.secrets",
    "security.dependencies",
    "syntax.parse",
  ]);
  assert.deepEqual(sel.deselected, ["tests.existing"]);
  assert.equal(sel.isStandardScope, false);
  assert.deepEqual(sel.only, ["syntax.parse", "security"]);
  assert.deepEqual(sel.exclude, []);

  const again = resolve(entries, ["syntax.parse", "security"], []);
  assert.deepEqual(again.effective, sel.effective);
});

test("--exclude subtracts after --only", () => {
  let sel = resolve(entries, ["security"], ["security.dependencies"]);
  assert.deepEqual(sel.effective, ["security.secrets"]);
  assert.deepEqual(sel.exclude, ["security.dependencies"]);

  // --exclude alone starts from the whole implemented Catalog.
  sel = resolve(entries, [], ["tests"]);
  assert.deepEqual(sel.effective, [
    "security.secrets",
    "security.dependencies",
    "syntax.parse",
  ]);
  assert.deepEqual(sel.deselected, ["tests.existing"]);
});

test("a family with planned members selects its implemented Checks only", () => {
  assert.deepEqual(resolve(entries, ["tests"], []).effective, [
    "tests.existing",
  ]);
});

describe("Selection errors name the problem", () => {
  const cases: [string, string[], string[], string][] = [
    [
      "unknown ID",
      ["tests.exsting"],
      [],
      'unknown Check or family "tests.exsting"',
    ],
    ["unknown family", ["bogus"], [], 'unknown Check or family "bogus"'],
    ["unknown in exclude", [], ["bogus"], 'unknown Check or family "bogus"'],
    ["planned ID", ["tests.mutation"], [], "planned"],
    ["planned ID in exclude", [], ["tests.mutation"], "planned"],
    ["family of planned Checks only", ["sbom"], [], "planned"],
    ["empty element", ["tests,,syntax"], [], "empty"],
    ["empty flag value", [""], [], "empty"],
    ["empty Selection", ["tests"], ["tests.existing"], "no Checks"],
    ["exclude everything", [], ["security", "tests", "syntax"], "no Checks"],
  ];
  for (const [name, only, exclude, want] of cases) {
    test(name, () => {
      assert.throws(
        () => resolve(entries, only, exclude),
        (err: Error) => err.message.includes(want),
      );
    });
  }

  test("the texts are Go's", () => {
    const message = (only: string[], exclude: string[], fast = false) => {
      try {
        resolveFast(entries, only, exclude, fast);
      } catch (err) {
        return (err as Error).message;
      }
      return "";
    };
    assert.equal(
      message(["x é"], []),
      '--only: unknown Check or family "x é"; js-prueffactory list-checks <path> shows the Catalog',
    );
    assert.equal(
      message([], ["sbom"]),
      '--exclude: "sbom" is planned and not implemented yet, so it cannot be selected',
    );
    assert.equal(
      message(["a, ,b"], []),
      '--only has an empty Check name in "a, ,b"',
    );
    assert.equal(
      message(["tests"], ["tests.existing"], true),
      "the Selection contains no Checks: --only tests --exclude tests.existing --fast",
    );
    // Names are trimmed with Go's white space: U+0085 counts, U+FEFF not.
    assert.equal(message(["\u0085syntax.parse\t"], [], false), "");
  });
});

// fastEntries has implemented Checks that --fast skips next to ones it keeps,
// and a planned one with the marking.
const fastEntries: Entry[] = [
  entry("tests.existing", Implemented),
  entry("tests.mutation", Implemented, true),
  entry("api.lint", Implemented),
  entry("api.fuzz", Implemented, true),
  entry("api.dast", Planned, true),
];

test("--fast deselects the marked implemented Checks", () => {
  const sel = resolveFast(fastEntries, [], [], true);
  assert.deepEqual(sel.effective, ["tests.existing", "api.lint"]);
  assert.deepEqual(sel.deselected, ["tests.mutation", "api.fuzz"]);
  assert.deepEqual(sel.deselectedByFast, ["tests.mutation", "api.fuzz"]);
  assert.equal(sel.fast, true);
  assert.equal(sel.isStandardScope, false);
});

test("without --fast the marked Checks are selected", () => {
  const sel = resolveFast(fastEntries, [], [], false);
  assert.deepEqual(sel.effective, [
    "tests.existing",
    "tests.mutation",
    "api.lint",
    "api.fuzz",
  ]);
  assert.equal(sel.fast, false);
  assert.deepEqual(sel.deselectedByFast, []);
  assert.equal(sel.isStandardScope, true);
});

test("--fast removes marked Checks after --only and --exclude", () => {
  let sel = resolveFast(fastEntries, ["tests"], [], true);
  assert.deepEqual(sel.effective, ["tests.existing"]);
  assert.deepEqual(sel.deselectedByFast, ["tests.mutation"]);

  // A Check that --exclude already removed is not deselected by --fast.
  sel = resolveFast(fastEntries, [], ["tests.mutation"], true);
  assert.deepEqual(sel.deselectedByFast, ["api.fuzz"]);
  assert.deepEqual(sel.deselected, ["tests.mutation", "api.fuzz"]);
});

test("--fast with an --only that names skipped Checks only is an empty Selection", () => {
  assert.throws(
    () => resolveFast(fastEntries, ["tests.mutation,api.fuzz"], [], true),
    (err: Error) =>
      err.message.includes("no Checks") && err.message.includes("--fast"),
  );
});

test("--fast ignores a marked Check that is still planned", () => {
  resolveFast(fastEntries, [], [], true);
  assert.throws(
    () => resolveFast(fastEntries, ["api.dast"], [], true),
    /planned/,
  );
});

test("the Catalog marks mutation, fuzz and DAST as skipped by --fast", () => {
  assert.deepEqual(
    catalog()
      .filter((e) => e.skippedByFast)
      .map((e) => e.id),
    ["tests.mutation", "api.fuzz", "api.dast"],
  );
});
