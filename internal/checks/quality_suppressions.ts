import { createHash } from "node:crypto";

import {
  BuildOutput,
  type FileClass,
  Source,
  TestCode,
  TestData,
} from "../discovery/discovery.ts";
import { base, ext as pathExt } from "../gocompat/path.ts";
import { compareBytes, toLower } from "../gocompat/strings.ts";
import { goString } from "../gocompat/utf8.ts";
import {
  Applicable,
  type FileHash,
  type Inventory,
  NotApplicable,
  StatusCompleted,
  StatusPartial,
  type SuppressionCount,
} from "../resultset/types.ts";
import { newLimitation } from "../resultset/zero.ts";
import { type Check, register } from "./check.ts";
import { isBinary } from "./quality_size.ts";
import type { Input, Result } from "./input.ts";
import {
  errNotRegular,
  errTooLarge,
  readProjectFile,
  tooLargeLimitation,
} from "./readcap.ts";
import { shownPath } from "./shown_text.ts";
import { errorMessage } from "../gocompat/errors.ts";

export const qualitySuppressionsID = "quality.suppressions";

// qualitySuppressions counts comment Suppressions in Source code and Test code
// by kind and File class. It is native: it reads the host-side Snapshot copy
// and starts no container. Test data and Build output are not counted, because
// Test data may contain them on purpose and generated files are not the
// project's own choice.
//
// The same pass records the SHA-256 of every Test code file and of every test,
// lint, coverage and TypeScript config file, manifest and lockfile in the
// Inventory. Suppressions set in config files are not counted, and the hashes
// are what makes a change to them visible.
export const qualitySuppressions: Check = {
  applicability(_p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "quality.suppressions examines the whole project, and this is a package Context",
      ];
    }
    return [Applicable, ""];
  },

  run(_signal, input) {
    return Promise.resolve(runSuppressions(input));
  },
};

register(qualitySuppressionsID, qualitySuppressions);

// ws is RE2's \s: [\t\n\f\r ]. JavaScript's \s also holds \v, U+00A0 and the
// other Unicode spaces, which RE2 does not.
const ws = "[\\t\\n\\f\\r ]";

// ci is RE2's (?i:word): every letter in both cases, with the characters that
// Unicode simple case folding adds for s (U+017F) and k (U+212A).
function ci(word: string): string {
  return word
    .split("")
    .map((ch) => {
      const lower = ch.toLowerCase();
      const upper = ch.toUpperCase();
      const extra = lower === "s" ? "\\u017f" : lower === "k" ? "\\u212a" : "";
      return `[${lower}${upper}${extra}]`;
    })
    .join("");
}

/**
 * suppressionKinds lists the kinds in report order, each with the pattern
 * that follows a comment opener. Closing and re-enabling forms such as
 * `eslint-enable`, `c8 ignore stop` and `jscpd:ignore-end` are not
 * Suppressions.
 */
export const suppressionKinds: readonly { kind: string; pattern: string }[] = [
  { kind: "eslint-disable", pattern: "eslint-disable(?:-next-line|-line)?\\b" },
  { kind: "biome-ignore", pattern: "biome-ignore(?:-all|-start)?\\b" },
  { kind: "@ts-ignore", pattern: "@ts-ignore\\b" },
  { kind: "@ts-expect-error", pattern: "@ts-expect-error\\b" },
  { kind: "@ts-nocheck", pattern: "@ts-nocheck\\b" },
  {
    kind: "c8 ignore",
    pattern: `c8${ws}+ignore${ws}+(?:next|start|file)\\b`,
  },
  {
    kind: "istanbul ignore",
    pattern: `istanbul${ws}+ignore${ws}+(?:next|if|else|file)\\b`,
  },
  {
    kind: "node:coverage ignore",
    pattern: `node:coverage${ws}+(?:ignore${ws}+next|disable)\\b`,
  },
  { kind: "gitleaks:allow", pattern: "gitleaks:allow\\b" },
  { kind: "hadolint ignore", pattern: `hadolint${ws}+ignore${ws}*=` },
  { kind: "shellcheck disable", pattern: `shellcheck${ws}+disable${ws}*=` },
  { kind: "jscpd:ignore-start", pattern: "jscpd:ignore-start\\b" },
  {
    kind: "stryker disable",
    pattern: `${ci("stryker")}${ws}+${ci("disable")}\\b`,
  },
  { kind: "njsscan-ignore", pattern: "njsscan-ignore\\b" },
  { kind: "nosemgrep", pattern: "nosemgrep\\b" },
];

/**
 * suppressionRE finds a directive that starts a comment: a comment opener
 * (`//`, `/*`, a leading `*` of a block comment, `#` or `<!--`), optional
 * white space, then one of the kinds, each in its own capture group. A word in
 * a string or in the middle of a sentence is therefore not counted.
 *
 * Go's RE2 runs in linear time and a backtracking engine must too, because
 * the text is the project's: a line of ten thousand slashes would cost ten
 * thousand tries of ten thousand each. The slash opener therefore starts only
 * at the start of a run of slashes. A shorter run cannot match where the whole
 * run does not (the next character would be a slash, which neither white space
 * nor any kind starts with), and a start inside a run is found at its start
 * first, so the matches are the same.
 */
const suppressionRE = new RegExp(
  `(?:(?<!/)//+|/\\*+|<!--|#|^${ws}*\\*+)${ws}*(?:` +
    suppressionKinds.map((k) => "(" + k.pattern + ")").join("|") +
    ")",
  "g",
);

/** countSuppressions returns the number of Suppressions of each kind in a file. */
export function countSuppressions(data: Uint8Array): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of goString(data).split("\n")) {
    suppressionRE.lastIndex = 0;
    for (;;) {
      const m = suppressionRE.exec(line);
      if (m === null) {
        break;
      }
      suppressionKinds.forEach((k, i) => {
        if (m[i + 1] !== undefined) {
          counts.set(k.kind, (counts.get(k.kind) ?? 0) + 1);
        }
      });
    }
  }
  return counts;
}

/**
 * configRole returns the Inventory role of a test, lint, coverage or
 * TypeScript config file, a manifest or a lockfile, or "" for any other file.
 */
export function configRole(rel: string): string {
  const name = base(rel);
  switch (name) {
    case "package.json":
      return "manifest";
    case "package-lock.json":
    case "npm-shrinkwrap.json":
    case "yarn.lock":
    case "pnpm-lock.yaml":
    case "bun.lock":
    case "bun.lockb":
      return "lockfile";
    case ".eslintignore":
    case "biome.json":
    case "biome.jsonc":
      return "lint_config";
  }
  const hasPrefix = (...prefixes: string[]): boolean =>
    prefixes.some((p) => name.startsWith(p));
  if (
    hasPrefix(
      ".mocharc",
      "jest.config.",
      "vitest.config.",
      "vitest.workspace.",
      "ava.config.",
      "karma.conf.",
      ".taprc",
    )
  ) {
    return "test_config";
  }
  if (hasPrefix("eslint.config.", ".eslintrc")) {
    return "lint_config";
  }
  if (hasPrefix(".c8rc", ".nycrc", "c8.config.", ".istanbul")) {
    return "coverage_config";
  }
  if (
    (name.startsWith("tsconfig") || name.startsWith("jsconfig")) &&
    name.endsWith(".json")
  ) {
    return "typescript_config";
  }
  return "";
}

function runSuppressions(input: Input): Result {
  const res: Result = {
    status: StatusCompleted,
    limitations: [
      newLimitation({
        reason_code: "config_suppressions_not_counted",
        message:
          "Suppressions set in config files, such as ESLint rule overrides, ignore patterns and TypeScript " +
          "compiler options, are not counted. The Inventory's config file hashes make changes to them visible.",
        check_id: qualitySuppressionsID,
      }),
    ],
  };

  const counts = new Map<string, number>();
  const fileHashes: FileHash[] = [];
  let unreadable = 0;
  let firstErr = "";
  const tooLarge: string[] = [];

  for (const f of input.project.files) {
    if (f.class === TestData || f.class === BuildOutput) {
      continue;
    }
    let role = configRole(f.path);
    if (role === "" && f.class === TestCode) {
      role = "test_code";
    }
    let data: Uint8Array;
    try {
      data = readProjectFile(input, f.path);
    } catch (err) {
      if (err === errNotRegular) {
        continue;
      }
      if (err === errTooLarge) {
        tooLarge.push(f.path);
        continue;
      }
      if (++unreadable === 1) {
        firstErr = shownPath(f.path) + ": " + errorMessage(err);
      }
      continue;
    }
    if (role !== "") {
      fileHashes.push({
        path: f.path,
        role,
        sha256: createHash("sha256").update(data).digest("hex"),
      });
    }
    if (isBinary(data) || isProse(f.path)) {
      continue;
    }
    for (const [kind, n] of countSuppressions(data)) {
      const key = kind + "\x00" + f.class;
      counts.set(key, (counts.get(key) ?? 0) + n);
    }
  }

  const suppressions: SuppressionCount[] = [];
  for (const k of suppressionKinds) {
    for (const class_ of [Source, TestCode] as FileClass[]) {
      const n = counts.get(k.kind + "\x00" + class_) ?? 0;
      if (n > 0) {
        suppressions.push({ kind: k.kind, file_class: class_, count: n });
      }
    }
  }
  fileHashes.sort((a, b) => compareBytes(a.path, b.path));
  const inv: Inventory = {
    tests: [],
    test_suites: [],
    test_files: [],
    suppressions,
    file_hashes: fileHashes,
    size: [],
    moved_test_files: [],
  };
  res.inventory = inv;
  res.limitations = [
    ...(res.limitations ?? []),
    ...tooLargeLimitation(qualitySuppressionsID, tooLarge),
  ];

  if (unreadable > 0) {
    res.status = StatusPartial;
    res.reasonCode = "check_could_not_run_on_some_files";
    res.reason = `${String(unreadable)} file(s) could not be read and are not counted or hashed, for example ${firstErr}`;
  }
  return res;
}

/**
 * isProse reports whether a file is documentation. Its text talks about
 * directives instead of using them, so it is not scanned.
 */
function isProse(rel: string): boolean {
  switch (toLower(pathExt(rel))) {
    case ".md":
    case ".markdown":
    case ".txt":
    case ".rst":
    case ".adoc":
      return true;
  }
  return false;
}
