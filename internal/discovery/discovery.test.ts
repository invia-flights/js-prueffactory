import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fileOf, project, tempDir } from "./discovery.testutil.ts";
import {
  BuildOutput,
  discover,
  type FileClass,
  folderNames,
  Source,
  TestCode,
  TestData,
} from "./discovery.ts";

test("folderNames lists the folders of a File class, sorted byte-wise", () => {
  assert.deepEqual(folderNames(TestData), [
    "__fixtures__",
    "__mocks__",
    "fixtures",
    "testdata",
  ]);
  assert.deepEqual(folderNames(BuildOutput), ["build", "coverage", "dist"]);
  assert.deepEqual(folderNames(TestCode), [
    "__tests__",
    "spec",
    "test",
    "tests",
  ]);
  assert.deepEqual(folderNames(Source), []);
});

test("files get their File class from folder names and the .min.js suffix", () => {
  const want: Record<string, FileClass> = {
    "src/app.js": Source,
    "index.js": Source,
    "test/a.test.js": TestCode,
    "tests/unit/b.js": TestCode,
    "src/__tests__/c.js": TestCode,
    "spec/d.js": TestCode,
    "test/fixtures/data.js": TestData, // Test data wins over Test code
    "src/__fixtures__/x.json": TestData,
    "testdata/y.js": TestData,
    "src/__mocks__/m.js": TestData,
    "dist/bundle.js": BuildOutput,
    "build/out.js": BuildOutput,
    "coverage/lcov-report/x.js": BuildOutput,
    "public/vendor.min.js": BuildOutput,
    "README.md": Source,
    "scripts/docker/Dockerfile": Source,
    "tester/not-a-test-folder.js": Source,
    "src/fixtures-like/not-data.js": Source,
  };
  const files: Record<string, string> = { "package.json": "{}" };
  for (const p of Object.keys(want)) files[p] = "";
  const proj = project(files);
  for (const [path, cls] of Object.entries(want)) {
    assert.equal(fileOf(proj, path).class, cls, path);
  }
});

test("packages and Context IDs: the project Context first, then packages in path order", () => {
  const proj = project({
    "package.json": '{"name":"root"}',
    "src/index.js": "",
    "ci/complexity/package.json": '{"name":"complexity"}',
    "ci/complexity/run.js": "",
    "node_modules/dep/package.json": "{}",
    "test/fixtures/pkg/package.json": "{}",
    "dist/package.json": "{}",
    "tools/standalone.js": "",
  });
  assert.deepEqual(
    proj.packages.map((p) => p.path),
    [".", "ci/complexity"],
    "not node_modules, Test data or Build output",
  );
  assert.deepEqual(
    proj.contexts.map((c) => `${c.id}:${c.kind}:${c.path}`),
    ["C-0001:project:.", "C-0002:package:.", "C-0003:package:ci/complexity"],
  );
  // A file belongs to its nearest package, files outside every package to
  // the project.
  assert.equal(fileOf(proj, "ci/complexity/run.js").contextID, "C-0003");
  assert.equal(fileOf(proj, "src/index.js").contextID, "C-0002");
});

test("files outside every package belong to the project Context", () => {
  const proj = project({
    "app/package.json": "{}",
    "app/a.js": "",
    "scripts/tool.js": "",
  });
  assert.equal(fileOf(proj, "scripts/tool.js").contextID, "C-0001");
});

test("a package Context records the pinned Node image and the container limits", () => {
  const proj = project({ "package.json": "{}" });
  const pkg = proj.contexts.find((c) => c.kind === "package");
  const n = pkg?.node;
  assert.ok(n, "package Context has no Node runtime");
  assert.equal(n.version, "24");
  assert.equal(n.source, "default");
  assert.equal(n.variant, "debian");
  assert.ok(n.image_digest.startsWith("sha256:"));
  assert.ok(n.image.includes("@sha256:"));
  assert.deepEqual(pkg.limits, { cpus: 2, memory_mb: 4096 });
});

test("a build step is detected from configs, emit settings and build scripts", () => {
  const needs: Record<string, Record<string, string>> = {
    "babel config": { "package.json": "{}", ".babelrc": "{}", "a.js": "" },
    "babel in manifest": {
      "package.json": '{"babel":{"presets":[]}}',
      "a.js": "",
    },
    "babel.config": { "package.json": "{}", "babel.config.js": "", "a.js": "" },
    webpack: { "package.json": "{}", "webpack.config.js": "", "a.js": "" },
    rollup: { "package.json": "{}", "rollup.config.mjs": "", "a.js": "" },
    vite: { "package.json": "{}", "vite.config.js": "", "a.js": "" },
    "tsconfig with ts and outDir": {
      "package.json": "{}",
      "tsconfig.json": '{"compilerOptions":{"outDir":"dist"}}',
      "src/a.ts": "",
    },
    "tsconfig with ts and rootDir": {
      "package.json": "{}",
      "tsconfig.json": '{"compilerOptions":{"rootDir":"src"}}',
      "src/a.ts": "",
    },
    "tsconfig with ts and declaration": {
      "package.json": "{}",
      "tsconfig.json": '{"compilerOptions":{"declaration":true}}',
      "src/a.mts": "",
    },
    "tsconfig with comments and trailing commas": {
      "package.json": "{}",
      "tsconfig.json":
        '{\n // emit\n "compilerOptions": {"outDir": "lib",},\n}\n',
      "a.cts": "",
    },
    "emit signal from a relative extends": {
      "package.json": "{}",
      "tsconfig.json": '{"extends":"./tsconfig.base.json"}',
      "tsconfig.base.json": '{"compilerOptions":{"outDir":"dist"}}',
      "a.ts": "",
    },
    "tsconfig with ts and a tsc build script": {
      "package.json": '{"scripts":{"build":"tsc -p ."}}',
      "tsconfig.json": "{}",
      "a.ts": "",
    },
    "tsconfig with ts and a bundler script": {
      "package.json":
        '{"scripts":{"prepare":"npm run clean && tsup src/index.ts"}}',
      "tsconfig.json": "{}",
      "a.ts": "",
    },
  };
  for (const [name, files] of Object.entries(needs)) {
    assert.notEqual(project(files).packages[0]?.buildStepReason, "", name);
  }
  const plain: Record<string, Record<string, string>> = {
    plain: { "package.json": "{}", "a.js": "" },
    "tsconfig only for editor": {
      "package.json": "{}",
      "tsconfig.json": "{}",
      "a.js": "",
    },
    "emit settings without TypeScript sources": {
      "package.json": "{}",
      "tsconfig.json": '{"compilerOptions":{"outDir":"dist"}}',
      "a.js": "",
      "a.d.ts": "",
    },
    "editor tsconfig next to a few TypeScript files": {
      "package.json": "{}",
      "tsconfig.json":
        '{"compilerOptions":{"checkJs":true,"allowJs":true,"noEmit":true,"strict":true}}',
      "a.js": "",
      "src/b.ts": "",
      "src/c.tsx": "",
    },
    "noEmit wins over an outDir": {
      "package.json": "{}",
      "tsconfig.json": '{"compilerOptions":{"outDir":"dist","noEmit":true}}',
      "src/a.ts": "",
    },
    "type check scripts only": {
      "package.json":
        '{"scripts":{"lint":"tsc --noEmit","typecheck":"tsc -p . --noEmit","test":"mocha"}}',
      "tsconfig.json": "{}",
      "src/a.ts": "",
    },
    "a package that only names tsc in a word": {
      "package.json": '{"scripts":{"build":"echo atsc ctsc"}}',
      "tsconfig.json": "{}",
      "src/a.ts": "",
    },
    "an unreadable extends is no signal": {
      "package.json": "{}",
      "tsconfig.json": '{"extends":"@tsconfig/node20/tsconfig.json"}',
      "src/a.ts": "",
    },
  };
  for (const [name, files] of Object.entries(plain)) {
    assert.equal(project(files).packages[0]?.buildStepReason, "", name);
  }
});

test("build step rules never read through a symlink out of the project or a huge file", () => {
  const outside = tempDir();
  writeFileSync(
    join(outside, "tsconfig.json"),
    '{"compilerOptions":{"outDir":"dist"}}',
  );
  writeFileSync(
    join(outside, "package.json"),
    '{"scripts":{"build":"tsc"},"babel":{}}',
  );
  const huge =
    '{"compilerOptions":{"outDir":"dist"},"x":"' + "a".repeat(2 << 20) + '"}';
  const cases: Record<string, (root: string) => void> = {
    "a symlinked folder holding the extended config": (root) => {
      symlinkSync(outside, join(root, "shared"));
      writeFileSync(
        join(root, "tsconfig.json"),
        '{"extends":"./shared/tsconfig.json"}',
      );
    },
    "a symlinked tsconfig.json": (root) => {
      symlinkSync(join(outside, "tsconfig.json"), join(root, "tsconfig.json"));
    },
    "a symlinked package.json": (root) => {
      rmSync(join(root, "package.json"));
      symlinkSync(join(outside, "package.json"), join(root, "package.json"));
      writeFileSync(join(root, "tsconfig.json"), "{}");
    },
    "a huge tsconfig.json": (root) => {
      writeFileSync(join(root, "tsconfig.json"), huge);
    },
    "a huge package.json": (root) => {
      writeFileSync(join(root, "tsconfig.json"), "{}");
      writeFileSync(
        join(root, "package.json"),
        '{"x":"' + "a".repeat(2 << 20) + '","scripts":{"build":"tsc"}}',
      );
    },
  };
  for (const [name, setup] of Object.entries(cases)) {
    const root = tempDir();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "");
    writeFileSync(join(root, "package.json"), "{}");
    setup(root);
    const p = discover(root);
    assert.equal(p.packages.length, 1, name);
    assert.equal(
      p.packages[0]?.buildStepReason,
      "",
      `${name}: what lies outside the project or is huge is not read`,
    );
  }
});

test("the build step reason names the emit signal or the script", () => {
  const signal = project({
    "package.json": "{}",
    "tsconfig.json": '{"compilerOptions":{"outDir":"dist"}}',
    "a.ts": "",
  }).packages[0]?.buildStepReason;
  assert.equal(
    signal,
    "tsconfig.json next to TypeScript sources, with the compiler option outDir",
  );
  const script = project({
    "package.json": '{"scripts":{"build":"tsc"}}',
    "tsconfig.json": "{}",
    "a.ts": "",
  }).packages[0]?.buildStepReason;
  assert.equal(
    script,
    "tsconfig.json next to TypeScript sources, and scripts.build builds them",
  );
});

test("discover never follows a symlink out of the root", () => {
  const outside = tempDir();
  writeFileSync(join(outside, "package.json"), "{}");
  const root = tempDir();
  writeFileSync(join(root, "package.json"), "{}");
  symlinkSync(outside, join(root, "linked"));
  assert.equal(discover(root).packages.length, 1);
});

test("an unreadable folder fails the discovery with Go's error text", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root reads every folder");
    return;
  }
  const root = tempDir();
  mkdirSync(join(root, "locked"), { mode: 0o000 });
  t.after(() => {
    chmodSync(join(root, "locked"), 0o755);
  });
  assert.throws(() => discover(root), {
    message: `discovery: open ${join(root, "locked")}: permission denied`,
  });
});
