// Where c8 and its output are, and the config that c8 gets (Go:
// tests_coverage_config.go). Every suite of a package writes its raw V8
// coverage into the same temp directory of one run-owned volume, which
// outlives the containers, and one `c8 report` over that volume gives the
// Coverage of the package. The raw coverage is there however a suite's run
// ended.
import {
  BuildOutput,
  folderNames,
  type Package,
  type Project,
  TestCode,
  TestData,
} from "../discovery/discovery.ts";
import { array, bool, marshal, object, string } from "../gocompat/json.ts";
import { clean } from "../gocompat/path.ts";
import { sortStrings } from "../gocompat/strings.ts";
import { ToolBin } from "../toolvolume/toolvolume.ts";
import { workPath } from "./package_install.ts";

export const c8ConfigPath = "/jspf/c8.json";
export const c8Bin = ToolBin + "/c8/bin/c8.js";

export const coverageMount = "/jspf-cov";
export const coverageTmp = coverageMount + "/tmp";
export const coverageDir = coverageMount + "/report";
/**
 * suiteReportDir is where the c8 that wraps a suite writes the report of
 * that suite alone, which nobody reads.
 */
export const suiteReportDir = coverageMount + "/suite-report";

export const coverageSummaryFile = coverageDir + "/coverage-summary.json";
export const coverageFilesFile = coverageDir + "/coverage-final.json";

/**
 * wrapWithC8 puts the pinned c8 in front of the runner's command. Everything
 * after the double dash is the runner's, so none of the project's arguments
 * can be read as a c8 option, `--reporter` of Mocha least of all. The
 * project's own c8 configuration is never read, because the config file is
 * named explicitly.
 */
export function wrapWithC8(cmd: readonly string[]): string[] {
  return ["node", c8Bin, "--config", c8ConfigPath, "--", ...cmd];
}

/**
 * coverageConfig is c8's config document for the report over one package's
 * suites: every file below the package root counts (--all), except Test
 * code, Test data, Build output, `node_modules` and the folders of nested
 * packages, which have their own Context. The reporters are the JSON
 * summary, with a line for every file, and the JSON of every file.
 *
 * The exclusions are globs. A file name is escaped, so that a name such as
 * `[id].test.js` or `!x.js` excludes that file and nothing else. All of it is
 * in a config file, so no path ever becomes a command line option.
 */
export function coverageConfig(proj: Project, pkg: Package): Buffer {
  return c8Config(proj, pkg, true);
}

/**
 * suiteCoverageConfig is the config of the c8 that wraps one suite: it only
 * collects. It adds to the raw coverage of the suites before it (clean is
 * off, the volume is new for every Run), and it does not look for files the
 * suite did not load, because the report does that once for all suites.
 */
export function suiteCoverageConfig(proj: Project, pkg: Package): Buffer {
  return c8Config(proj, pkg, false);
}

interface C8Doc {
  all: boolean;
  clean: boolean;
  exclude: string[];
  reporter: string[];
  reportsDir: string;
  src: string[];
  tempDirectory: string;
}

// The fields in the order Go's sorted map keys give them.
const c8DocShape = object<C8Doc>([
  ["all", bool],
  ["clean", bool],
  ["exclude", array(string)],
  ["reporter", array(string)],
  ["reportsDir", string],
  ["src", array(string)],
  ["tempDirectory", string],
]);

function c8Config(proj: Project, pkg: Package, report: boolean): Buffer {
  const exclude: string[] = [];
  const seen = new Set<string>();
  const add = (p: string): void => {
    if (!seen.has(p)) {
      seen.add(p);
      exclude.push(p);
    }
  };
  for (const f of pkg.files) {
    switch (f.class) {
      case TestCode:
      case TestData:
      case BuildOutput:
        add(globLiteral(f.packageRel));
    }
  }
  for (const cls of [TestCode, TestData, BuildOutput]) {
    for (const name of folderNames(cls)) {
      add("**/" + name + "/**");
    }
  }
  add("**/*.min.js");
  add("**/node_modules/**");
  for (const q of proj.packages) {
    const rel = below(pkg.path, q.path);
    if (rel !== undefined) {
      add(globLiteral(rel));
    }
  }
  sortStrings(exclude);

  const doc: C8Doc = {
    all: report,
    clean: false,
    exclude,
    reporter: report ? ["json-summary", "json"] : ["json-summary"],
    reportsDir: report ? coverageDir : suiteReportDir,
    src: [workPath(pkg)],
    tempDirectory: coverageTmp,
  };
  return Buffer.from(marshal(doc, c8DocShape));
}

/**
 * below returns the path of a package relative to another package's folder,
 * when it lies below it.
 */
export function below(parent: string, child: string): string | undefined {
  if (child === parent) {
    return undefined;
  }
  if (parent === ".") {
    return child;
  }
  if (child.startsWith(parent + "/")) {
    return child.slice(parent.length + 1);
  }
  return undefined;
}

/** globLiteral escapes a path for a glob, so that it matches that path only. */
export function globLiteral(p: string): string {
  let b = "";
  for (const ch of clean(p)) {
    if ("\\*?[]{}()!+@#|".includes(ch)) {
      b += "\\";
    }
    b += ch;
  }
  return b;
}
