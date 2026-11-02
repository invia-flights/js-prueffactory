// What types.javascript decides on the host: which packages it takes, the
// generated tsconfig, and what it makes of TypeScript's output (Go:
// types_javascript_test.go). The run of tsc itself needs Docker and is covered
// by cli/types_javascript.docker.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Applicable,
  ConfidenceSuspected,
  NotApplicable,
  SeverityWarning,
  StatusCompleted,
  StatusToolError,
  StatusUnsupported,
} from "../resultset/types.ts";
import "./all.ts";
import { Implemented, lookup, PerPackage } from "./catalog.ts";
import { impl, packageContext, tree } from "./checks.testutil.ts";
import { Input } from "./input.ts";
import {
  metricOf,
  otherError,
  resolutionDiagnostics,
  typesInput,
} from "./types.testutil.ts";
import {
  interpretTypes,
  parseTSC,
  tsTarget,
  typesResolutionCodes,
  typesTargets,
  typesTsconfig,
} from "./types_javascript.ts";

test("types.javascript is implemented per package as a side indicator without Gates", () => {
  const entry = lookup("types.javascript");
  assert.equal(entry?.status, Implemented);
  assert.equal(entry.scope, PerPackage);
  assert.equal(entry.canFireGates, false, "it reports warnings, never Gates");
});

test("types.javascript needs the install and the toolset", (t) => {
  const proj = tree(t, { "package.json": '{"name":"x"}', "src/a.js": "1;\n" });
  const c = packageContext(proj, ".");
  const check = impl("types.javascript");

  assert.deepEqual(check.prerequisites?.(c), ["package.install"]);
  assert.equal(
    check.usesWorkingCopy?.(),
    true,
    "the Check reads the installed dependencies in the Working copy",
  );
  assert.equal(check.usesToolset?.(c), true);
  assert.equal(
    check.images?.(c).length,
    1,
    "the Check runs TypeScript from the toolset in one image",
  );
});

test("TypeScript source files do not make a package unsupported", async (t) => {
  for (const ts of ["src/b.ts", "src/b.tsx", "src/b.mts", "src/b.cts"]) {
    await t.test(ts, (t) => {
      const proj = tree(t, {
        "package.json": '{"name":"x"}',
        "src/a.js": "1;\n",
        [ts]: "export {};\n",
        // An editor tsconfig next to a few TypeScript files is no build step.
        "tsconfig.json": '{"compilerOptions":{"strict":true}}',
      });
      const c = packageContext(proj, ".");
      const check = impl("types.javascript");

      assert.deepEqual(check.applicability(proj, c), [Applicable, ""]);
      assert.equal(check.images?.(c).length, 1);
      assert.equal(check.usesToolset?.(c), true);
      assert.deepEqual(check.prerequisites?.(c), ["package.install"]);
    });
  }
});

test("a package of only TypeScript source files is checked", (t) => {
  const proj = tree(t, {
    "package.json": '{"name":"x"}',
    "src/a.ts": "export {};\n",
  });
  assert.deepEqual(
    impl("types.javascript").applicability(proj, packageContext(proj, ".")),
    [Applicable, ""],
  );
});

test("a package that needs a build step for its TypeScript stays unsupported with the reason", async (t) => {
  const cases: Record<string, Record<string, string>> = {
    "tsconfig that emits": {
      "tsconfig.json": '{"compilerOptions":{"outDir":"dist"}}',
    },
    "tsc build script": {
      "tsconfig.json": "{}",
      "package.json": '{"name":"x","scripts":{"build":"tsc"}}',
    },
    "babel config": { ".babelrc": "{}" },
    "bundler config": { "rollup.config.mjs": "export default {};\n" },
  };
  for (const [name, extra] of Object.entries(cases)) {
    await t.test(name, async (t) => {
      const files = {
        "package.json": '{"name":"x"}',
        ...extra,
        "src/a.js": "1;\n",
        "src/b.ts": "export {};\n",
      };
      const proj = tree(t, files);
      const c = packageContext(proj, ".");
      const check = impl("types.javascript");

      const [got, reason] = check.applicability(proj, c);

      assert.equal(got, Applicable);
      assert.ok(
        reason.startsWith("unsupported: ") && reason.includes("build step"),
        reason,
      );
      assert.equal(check.images?.(c).length, 0);
      assert.equal(check.usesToolset?.(c), false);
      assert.deepEqual(check.prerequisites?.(c), []);
      const res = await check.run?.(
        new AbortController().signal,
        new Input({ project: proj, context: c }),
      );
      assert.equal(res?.status, StatusUnsupported);
      assert.equal(res.reasonCode, "build_step_required");
      assert.ok(res.reason?.includes("build step"), res.reason);
    });
  }
});

test("a build config without TypeScript source code does not change the Check", (t) => {
  const proj = tree(t, {
    "package.json": '{"name":"x"}',
    ".babelrc": "{}",
    "src/a.js": "1;\n",
  });
  assert.deepEqual(
    impl("types.javascript").applicability(proj, packageContext(proj, ".")),
    [Applicable, ""],
    "only TypeScript sources need the build step to be unsupported",
  );
});

test("a declaration file or an editor-only tsconfig does not make a package TypeScript", (t) => {
  const proj = tree(t, {
    "package.json": '{"name":"x"}',
    "src/a.js": "1;\n",
    "src/a.d.ts": "export {};\n",
    "src/b.d.mts": "export {};\n",
    "src/c.d.cts": "export {};\n",
    "tsconfig.json": "{}\n",
    "jsconfig.json": "{}\n",
  });
  assert.deepEqual(
    impl("types.javascript").applicability(proj, packageContext(proj, ".")),
    [Applicable, ""],
  );
});

test("packages without JavaScript source code are not applicable", (t) => {
  const proj = tree(t, {
    "package.json": '{"name":"x"}',
    "test/a.test.js": "1;\n",
    "test/fixtures/f.js": "1;\n",
    "dist/g.js": "1;\n",
  });
  const [got, reason] = impl("types.javascript").applicability(
    proj,
    packageContext(proj, "."),
  );
  assert.equal(got, NotApplicable);
  assert.notEqual(reason, "");
});

test("the project Context is not applicable", (t) => {
  const proj = tree(t, { "package.json": '{"name":"x"}', "src/a.js": "1;\n" });
  const project = proj.contexts[0];
  assert.ok(project);
  assert.equal(
    impl("types.javascript").applicability(proj, project)[0],
    NotApplicable,
  );
});

test("only JavaScript, TypeScript and declaration files of Source code are given to TypeScript as literal paths", (t) => {
  const input = typesInput(t, {
    "package.json": '{"name":"x"}',
    "src/a.js": "1;\n",
    "src/b.mjs": "1;\n",
    "src/c.cjs": "1;\n",
    "src/d.d.ts": "export {};\n",
    "src/[id].js": "1;\n",
    "src/-x.js": "1;\n",
    "src/e.jsx": "1;\n",
    "src/f.ts": "export {};\n",
    "src/g.tsx": "export {};\n",
    "src/h.mts": "export {};\n",
    "src/i.cts": "export {};\n",
    "src/j.d.mts": "export {};\n",
    "test/b.test.ts": "export {};\n",
    "test/a.test.js": "1;\n",
    "dist/g.js": "1;\n",
    "README.md": "# x\n",
  });

  assert.deepEqual(typesTargets(input), [
    "src/-x.js",
    "src/[id].js",
    "src/a.js",
    "src/b.mjs",
    "src/c.cjs",
    "src/d.d.ts",
    "src/f.ts",
    "src/g.tsx",
    "src/h.mts",
    "src/i.cts",
    "src/j.d.mts",
  ]);
});

/** generatedConfig parses the generated tsconfig, which must be JSON. */
function generatedConfig(
  files: string[],
  pkgPath: string,
  node: string,
  mocha: boolean,
): Record<string, unknown> {
  const data = typesTsconfig(files, pkgPath, node, mocha);
  return JSON.parse(data) as Record<string, unknown>;
}

test("the generated tsconfig is a basic profile for JavaScript that never reads the project's config", () => {
  const cfg = generatedConfig(["src/a.js", "src/[id].js"], ".", "24", false);

  const opts = cfg.compilerOptions as Record<string, unknown>;
  const want: Record<string, unknown> = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    strict: false,
    noImplicitAny: false,
    module: "nodenext",
    target: "es2024",
    skipLibCheck: true,
    // .tsx files parse; nothing is emitted, so the JSX is never transformed.
    jsx: "preserve",
    // An extensionless require of a .json file resolves the way Node does.
    resolveJsonModule: true,
  };
  for (const [k, v] of Object.entries(want)) {
    assert.equal(opts[k], v, `compilerOptions.${k}`);
  }
  assert.deepEqual(
    opts.types,
    ["node"],
    "node only for a package without Mocha",
  );
  // The package's own types come first, then the toolset's.
  assert.deepEqual(opts.typeRoots, [
    "/work/node_modules/@types",
    "/toolset/node_modules/@types",
  ]);
  // Literal absolute paths: no glob can match anything else, and a name that
  // starts with "-" or holds "[" means what it says.
  assert.deepEqual(cfg.files, ["/work/src/a.js", "/work/src/[id].js"]);
  for (const k of ["include", "exclude", "extends", "references"]) {
    assert.ok(
      !(k in cfg),
      `the config has "${k}": the project's own config and globs must not come in`,
    );
  }
});

test("TypeScript files are listed as literal paths next to the JavaScript ones", () => {
  const cfg = generatedConfig(
    ["src/a.js", "src/b.ts", "src/c.tsx", "src/[d].mts", "src/e.d.cts"],
    "pkg",
    "24",
    false,
  );

  assert.deepEqual(cfg.files, [
    "/work/pkg/src/a.js",
    "/work/pkg/src/b.ts",
    "/work/pkg/src/c.tsx",
    "/work/pkg/src/[d].mts",
    "/work/pkg/src/e.d.cts",
  ]);
  const opts = cfg.compilerOptions as Record<string, unknown>;
  assert.equal(opts.jsx, "preserve");
  assert.equal(opts.strict, false);
  assert.equal(opts.noImplicitAny, false);
});

test("Mocha types come in for Mocha packages and the target follows the Node version", () => {
  const cfg = generatedConfig(["a.js"], "packages/inner", "20", true);
  const opts = cfg.compilerOptions as Record<string, unknown>;

  assert.deepEqual(opts.types, ["node", "mocha"]);
  assert.equal(opts.target, "es2023", "Node 20");
  assert.deepEqual(opts.typeRoots, [
    "/work/packages/inner/node_modules/@types",
    "/work/packages/node_modules/@types",
    "/work/node_modules/@types",
    "/toolset/node_modules/@types",
  ]);
  assert.deepEqual(cfg.files, ["/work/packages/inner/a.js"]);
});

test("the target matches the Node version", () => {
  const want: Record<string, string> = {
    "24": "es2024",
    "22": "es2023",
    "20": "es2023",
    "18": "es2022",
    "16": "es2021",
    "14": "es2020",
    "12": "es2019",
    "22.4.1": "es2023",
    "": "es2024",
    latest: "es2024",
    "26": "es2024",
  };
  for (const [node, target] of Object.entries(want)) {
    assert.equal(tsTarget(node), target, `tsTarget(${JSON.stringify(node)})`);
  }
});

const tscErrors = `src/index.js(3,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
src/other.js(10,1): error TS2322: Type 'string' is not assignable to type 'number'.
  Type 'string' is not assignable to type 'number'.
src/legacy (1).js(2,5): error TS2339: Property 'x' does not exist on type '{}'.
node_modules/dep/index.js(1,1): error TS7016: Could not find a declaration file for module 'dep'.
../outside.js(1,1): error TS2304: Cannot find name 'y'.
test/a.test.js(1,1): error TS2304: Cannot find name 'z'.
`;

test("parseTSC reads diagnostics with their continuation lines", () => {
  const { diags, global } = parseTSC(tscErrors);

  assert.deepEqual(global, []);
  assert.equal(diags.length, 6);
  assert.deepEqual(diags[1], {
    path: "src/other.js",
    line: 10,
    column: 1,
    code: "TS2322",
    category: "error",
    message:
      "Type 'string' is not assignable to type 'number'.\nType 'string' is not assignable to type 'number'.",
  });
  const legacy = diags[2];
  assert.equal(legacy?.path, "src/legacy (1).js", "a path with parentheses");
  assert.equal(legacy.line, 2);
  assert.equal(legacy.column, 5);
});

test("parseTSC separates diagnostics without a file because they mean the run was wrong", () => {
  const { global } = parseTSC(
    "error TS2688: Cannot find type definition file for 'mocha'.\n",
  );
  assert.equal(global.length, 1);
  assert.ok(global[0]?.includes("TS2688"), String(global));
});

test("every diagnostic in Source code becomes a warning with its TS code", (t) => {
  const input = typesInput(t, {
    "package.json": '{"name":"x"}',
    "src/index.js": "1;\n",
    "src/other.js": "1;\n",
    "src/legacy (1).js": "1;\n",
    "test/a.test.js": "1;\n",
  });
  const { diags } = parseTSC(tscErrors);

  const res = interpretTypes(input, diags, [], 1);

  assert.equal(res.status, StatusCompleted, res.reason);
  // Only the package's Source code is examined: not node_modules, not files
  // outside the package and not Test code pulled in by an import.
  const findings = res.findings ?? [];
  assert.equal(
    findings.length,
    3,
    "the three in Source code: " + JSON.stringify(findings),
  );
  const f = findings[0];
  assert.ok(f);
  assert.equal(f.check_id, "types.javascript");
  assert.equal(f.context_id, input.context.id);
  assert.equal(f.gate, false);
  assert.equal(f.severity, SeverityWarning);
  assert.equal(f.rule_id, "TS2345");
  const loc = f.locations[0];
  assert.equal(loc?.path, "src/index.js");
  assert.equal(loc.start?.line, 3);
  assert.notEqual(loc.file_sha256, "");
  assert.ok(f.message.includes("TS2345"), f.message);
  assert.ok(f.message.includes("not assignable to parameter"), f.message);
  assert.notEqual(
    findings[0]?.fingerprint.value,
    findings[1]?.fingerprint.value,
    "two diagnostics must have two fingerprints",
  );
});

test("paths of a diagnostic in a nested package are relative to the project", (t) => {
  const nested = typesInput(
    t,
    {
      "package.json": '{"name":"root"}',
      "packages/inner/package.json": '{"name":"inner"}',
      "packages/inner/src/in.js": "1;\n",
    },
    "packages/inner",
  );
  const { diags } = parseTSC(
    "src/in.js(1,1): error TS2304: Cannot find name 'q'.\n",
  );

  const res = interpretTypes(nested, diags, [], 1);

  assert.equal(res.findings?.length, 1);
  assert.equal(res.findings[0]?.locations[0]?.path, "packages/inner/src/in.js");
});

test("a clean run completes without findings", (t) => {
  const input = typesInput(t, {
    "package.json": '{"name":"x"}',
    "src/a.js": "1;\n",
  });
  const res = interpretTypes(input, [], [], 0);
  assert.equal(res.status, StatusCompleted);
  assert.equal(res.findings?.length ?? 0, 0);
});

test("a diagnostic without a file or a failure without a diagnostic is a tool error", (t) => {
  const input = typesInput(t, {
    "package.json": '{"name":"x"}',
    "src/a.js": "1;\n",
  });

  let res = interpretTypes(
    input,
    [],
    ["error TS2688: Cannot find type definition file for 'mocha'."],
    1,
  );
  assert.equal(res.status, StatusToolError);
  assert.equal(res.reasonCode, "tsc_config_error");
  assert.ok(res.reason?.includes("TS2688"), res.reason);

  res = interpretTypes(input, [], [], 2);
  assert.equal(res.status, StatusToolError, "exit 2 without a diagnostic");
  assert.equal(res.reasonCode, "tsc_failed");

  res = interpretTypes(input, [], [], 139);
  assert.equal(res.status, StatusToolError, "a crash");
  assert.equal(res.reasonCode, "tsc_failed");
});

test("diagnostics in TypeScript files are warnings like those in JavaScript files", (t) => {
  const input = typesInput(t, {
    "package.json": '{"name":"x"}',
    "src/a.js": "1;\n",
    "src/b.ts": "export {};\n",
    "src/c.tsx": "export {};\n",
    "src/d.mts": "export {};\n",
    "src/e.cts": "export {};\n",
    "test/f.test.ts": "export {};\n",
  });
  const { diags } =
    parseTSC(`src/a.js(1,1): error TS2322: Type 'string' is not assignable to type 'number'.
src/b.ts(2,7): error TS2322: Type 'string' is not assignable to type 'number'.
src/c.tsx(3,1): error TS2339: Property 'x' does not exist on type '{}'.
src/d.mts(1,1): error TS2304: Cannot find name 'a'.
src/e.cts(1,1): error TS2304: Cannot find name 'b'.
test/f.test.ts(1,1): error TS2304: Cannot find name 'c'.
node_modules/dep/index.d.ts(1,1): error TS2304: Cannot find name 'd'.
`);

  const res = interpretTypes(input, diags, [], 1);

  assert.equal(res.status, StatusCompleted);
  const findings = res.findings ?? [];
  assert.equal(
    findings.length,
    5,
    "5 in Source code and none in Test code or node_modules",
  );
  for (const f of findings) {
    assert.equal(f.severity, SeverityWarning);
    assert.equal(f.gate, false);
    assert.equal(f.confidence, ConfidenceSuspected);
    assert.ok(f.rule_id?.startsWith("TS"), String(f.rule_id));
  }
  const loc = findings[1]?.locations[0];
  assert.equal(loc?.path, "src/b.ts");
  assert.equal(loc.start?.line, 2);
  assert.equal(loc.start.column, 7);
});

test("a flood of resolution errors gets a Limitation naming the missing project config and a metric", (t) => {
  const input = typesInput(t, {
    "package.json": '{"name":"x"}',
    "src/a.ts": "export {};\n",
    "src/b.js": "1;\n",
  });
  // 30 unresolved modules and 10 other errors: three quarters of the Findings.
  const { diags } = parseTSC(resolutionDiagnostics(30) + otherError.repeat(10));

  const res = interpretTypes(input, diags, [], 2);

  assert.equal(res.status, StatusCompleted);
  assert.equal(res.findings?.length, 40, "the Findings stay in the Report");
  assert.equal(res.limitations?.length, 1);
  const l = res.limitations[0];
  assert.ok(l);
  assert.equal(l.reason_code, "project_tsconfig_not_used");
  assert.equal(l.check_id, "types.javascript");
  assert.ok(l.message.includes("30 of 40"), l.message);
  assert.ok(l.message.includes("tsconfig"), l.message);
  assert.ok(l.message.includes("TS2307"), l.message);
  const m = metricOf(res, "resolution_errors");
  assert.equal(m?.value, 30);
  assert.equal(m.unit, "errors");
});

test("few resolution errors get a metric but no Limitation", async (t) => {
  const input = typesInput(t, {
    "package.json": '{"name":"x"}',
    "src/a.ts": "export {};\n",
    "src/b.js": "1;\n",
  });
  const cases: Record<string, string> = {
    "a small share of many": resolutionDiagnostics(10) + otherError.repeat(90),
    "too few to say anything": resolutionDiagnostics(4),
    "exactly a fifth is still few":
      resolutionDiagnostics(10) + otherError.repeat(40),
  };
  for (const [name, out] of Object.entries(cases)) {
    await t.test(name, () => {
      const { diags } = parseTSC(out);
      const res = interpretTypes(input, diags, [], 2);
      assert.deepEqual(res.limitations, []);
      assert.notEqual(metricOf(res, "resolution_errors")?.value, undefined);
    });
  }
});

test("a clean run has a zero resolution error metric", (t) => {
  const input = typesInput(t, {
    "package.json": '{"name":"x"}',
    "src/a.js": "1;\n",
  });
  const res = interpretTypes(input, [], [], 0);
  assert.equal(metricOf(res, "resolution_errors")?.value, 0);
});

test("other resolution codes count too", () => {
  for (const code of [
    "TS2307",
    "TS2792",
    "TS2834",
    "TS2835",
    "TS2503",
    "TS2580",
    "TS2591",
    "TS2583",
  ]) {
    assert.ok(typesResolutionCodes.has(code), `${code} is not counted`);
  }
  for (const code of ["TS2345", "TS2322", "TS2339", "TS2304"]) {
    assert.ok(
      !typesResolutionCodes.has(code),
      `${code} is a type error of the code, not a resolution error`,
    );
  }
});

test("resolution errors dropped outside Source code do not count", (t) => {
  const input = typesInput(t, {
    "package.json": '{"name":"x"}',
    "src/a.js": "1;\n",
  });
  const { diags } = parseTSC(
    resolutionDiagnostics(30, "node_modules/dep/index.d.ts") +
      "src/a.js(1,1): error TS2339: Property 'x' does not exist on type '{}'.\n",
  );
  const res = interpretTypes(input, diags, [], 2);
  assert.deepEqual(res.limitations, [], "only what the Report keeps counts");
  assert.equal(res.findings?.length, 1);
});

interface DroppedJSONDoc {
  dropped: number;
  omitted: number;
  errors: {
    specifier: string;
    path: string;
    line: number;
    resolves_to: string;
  }[];
}

function droppedJSONList(res: {
  artifacts?: { path: string; content: Uint8Array | null }[];
}): DroppedJSONDoc {
  const a = res.artifacts?.find((x) =>
    x.path.endsWith("-json-modules-dropped.json"),
  );
  assert.ok(a?.content, "no list of dropped errors among the artifacts");
  return JSON.parse(Buffer.from(a.content).toString("utf8")) as DroppedJSONDoc;
}

// TypeScript never tries ".json" on an extensionless path, even with
// resolveJsonModule, so it reports TS2307 for require('./schema') where Node
// loads schema.json. Those are not findings about the project.
test("a require of a JSON file that Node resolves is not a missing module", (t) => {
  const input = typesInput(t, {
    "package.json": '{"name":"x"}',
    "src/a.js": "1;\n",
    "src/b.js": "1;\n",
    "src/data/schema.json": "{}\n",
    "src/cfg/index.json": "{}\n",
  });
  const { diags } = parseTSC(
    "src/a.js(1,1): error TS2307: Cannot find module './data/schema' or its corresponding type declarations.\n" +
      "src/a.js(2,1): error TS2307: Cannot find module './cfg' or its corresponding type declarations.\n" +
      "src/a.js(3,1): error TS2307: Cannot find module './data/missing' or its corresponding type declarations.\n" +
      "src/a.js(4,1): error TS2307: Cannot find module 'schema' or its corresponding type declarations.\n" +
      "src/a.js(5,1): error TS2307: Cannot find module './data/schema.json' or its corresponding type declarations.\n" +
      "src/b.js(6,1): error TS2307: Cannot find module './schema' or its corresponding type declarations.\n" +
      "src/b.js(7,1): error TS2307: Cannot find module '../src/cfg' or its corresponding type declarations.\n",
  );

  const res = interpretTypes(input, diags, [], 2);

  const left = (res.findings ?? []).map((f) => f.locations[0]?.start?.line);
  // ./data/schema and ./cfg (index.json) resolve in Node from src/a.js, and so
  // does ../src/cfg from src/b.js. A missing file, a bare package name, an
  // explicit .json that does not exist and a name that is only in another
  // folder (./schema from src/b.js) stay.
  assert.deepEqual(left, [3, 4, 5, 6]);
  assert.equal(
    metricOf(res, "resolution_errors")?.value,
    4,
    "the 4 real resolution errors",
  );
  // What was dropped stays visible: a count, and a list in an artifact.
  const dropped = metricOf(res, "json_modules_dropped");
  assert.equal(dropped?.value, 3);
  assert.equal(dropped.unit, "errors");
  const doc = droppedJSONList(res);
  assert.equal(doc.dropped, 3);
  assert.equal(doc.omitted, 0);
  assert.deepEqual(
    doc.errors.map((e) => ({
      specifier: e.specifier,
      path: e.path,
      line: e.line,
      resolves_to: e.resolves_to,
    })),
    [
      {
        specifier: "./data/schema",
        path: "src/a.js",
        line: 1,
        resolves_to: "src/data/schema.json",
      },
      {
        specifier: "./cfg",
        path: "src/a.js",
        line: 2,
        resolves_to: "src/cfg/index.json",
      },
      {
        specifier: "../src/cfg",
        path: "src/b.js",
        line: 7,
        resolves_to: "src/cfg/index.json",
      },
    ],
  );
});

test("the list of dropped JSON errors is capped and the rest is counted", (t) => {
  const input = typesInput(t, {
    "package.json": '{"name":"x"}',
    "src/a.js": "1;\n",
    "src/data/schema.json": "{}\n",
  });
  let out = "";
  for (let i = 1; i <= 60; i++) {
    out += `src/a.js(${String(i)},1): error TS2307: Cannot find module './data/schema' or its corresponding type declarations.\n`;
  }
  const { diags } = parseTSC(out);

  const res = interpretTypes(input, diags, [], 2);

  assert.equal(
    metricOf(res, "json_modules_dropped")?.value,
    60,
    "all 60 counted",
  );
  const doc = droppedJSONList(res);
  assert.equal(doc.dropped, 60);
  assert.equal(doc.errors.length, 50, "the first by position");
  assert.equal(doc.omitted, 10);
  assert.equal(doc.errors[49]?.line, 50);
  assert.equal(
    metricOf(res, "resolution_errors")?.value,
    0,
    "dropped errors count nowhere else",
  );
  assert.equal(res.findings?.length, 0);
});

test("without dropped JSON errors the metric is zero and there is no list", (t) => {
  const input = typesInput(t, {
    "package.json": '{"name":"x"}',
    "src/a.js": "1;\n",
  });
  const { diags } = parseTSC(
    "src/a.js(1,1): error TS2339: Property 'x' does not exist on type '{}'.\n",
  );

  const res = interpretTypes(input, diags, [], 2);

  assert.equal(metricOf(res, "json_modules_dropped")?.value, 0);
  assert.deepEqual(res.artifacts ?? [], []);
});
