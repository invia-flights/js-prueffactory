// A tool whose output cannot be read is a tool problem (spec "Trustworthy
// gates", ticket 04). Every adapter of the description, pipeline and
// deployment Checks gets a changed JSON shape, truncated output and plain text
// where it expects its tool's documented output. Each case ends tool_error (or
// partial when other files could be read) with the reason code
// tool_output_unreadable, makes no Finding, and keeps the raw output as
// artifacts that the reason names. The tools run as stood-in containers that
// answer like Docker does.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import type {
  ContainerResult,
  ContainerSpec,
  Driver,
} from "../docker/driver.ts";
import { catalog } from "./catalog.ts";
import { projectContext, runCheck, tree } from "./checks.testutil.ts";
import { Input, type InputFields, type Result } from "./input.ts";
import { resolve } from "./selection.ts";
import { maxRawOutputBytes } from "./tool_output.ts";

/** Answer is what a stood-in container prints. */
interface Answer {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

function container(a: Answer): ContainerResult {
  return {
    exitCode: a.exitCode ?? 0,
    oomKilled: false,
    stdout: Buffer.from(a.stdout ?? ""),
    stderr: Buffer.from(a.stderr ?? ""),
    stoppedAfterGrace: false,
  };
}

function stubDocker(answer: (spec: ContainerSpec) => Answer): Driver {
  return {
    runContainer: (_signal: AbortSignal, spec: ContainerSpec) =>
      Promise.resolve(container(answer(spec))),
  } as unknown as Driver;
}

async function run(
  t: TestContext,
  id: string,
  files: Record<string, string>,
  answer: (spec: ContainerSpec) => Answer,
  fields: Partial<InputFields> = {},
): Promise<Result> {
  const proj = tree(t, files);
  return runCheck(
    id,
    new Input({
      project: proj,
      context: projectContext(proj),
      originalPath: proj.root,
      snapshotDir: proj.root,
      snapshotVolume: "jspf-run-snapshot",
      network: "jspf-run-net",
      toolsetVolume: "jspf-toolset",
      kubernetesSchemaVolume: "jspf-k8s-schemas",
      docker: stubDocker(answer),
      ...fields,
    }),
  );
}

/** rawOf is the content of the artifact at a path of a Result, as text. */
function rawOf(res: Result, path: string): string | undefined {
  const a = (res.artifacts ?? []).find((x) => x.path === path);
  return a?.content == null ? undefined : Buffer.from(a.content).toString();
}

/**
 * assertUnreadable checks what every unreadable case shows: the status, the
 * reason code, no Finding at all, and the raw stdout and stderr of the call as
 * artifacts that the reason names.
 */
function assertUnreadable(
  res: Result,
  expected: {
    status: "tool_error" | "partial";
    check: string;
    call: string;
    stdout: string;
    stderr?: string;
  },
): void {
  assert.deepEqual(
    [res.status, res.reasonCode],
    [expected.status, "tool_output_unreadable"],
    res.reason ?? "",
  );
  assert.deepEqual(
    (res.findings ?? []).filter((f) => f.gate),
    [],
    "a reading failure is never a Gate",
  );
  const base = `artifacts/${expected.check}/C-0001/${expected.call}`;
  assert.equal(rawOf(res, `${base}.stdout.txt`), expected.stdout);
  assert.equal(rawOf(res, `${base}.stderr.txt`), expected.stderr ?? "");
  for (const a of res.artifacts ?? []) {
    assert.equal(a.maxBytes, maxRawOutputBytes, a.path);
  }
  assert.ok(
    (res.reason ?? "").includes(`${base}.stdout.txt`) &&
      (res.reason ?? "").includes(`${base}.stderr.txt`),
    `the reason names the artifacts: ${res.reason ?? ""}`,
  );
}

// --- hadolint ---

const dockerfile = { Dockerfile: "FROM node:24\n" };
const hadolintGood =
  '[{"code":"DL3006","column":1,"file":"/snapshot/Dockerfile","level":"warning","line":1,"message":"Always tag the version of an image explicitly"}]';

const hadolintBad: Record<string, string> = {
  "a changed JSON shape": '[{"rule":"DL3006","severity":"warning"}]',
  "an object instead of the array": '{"results":[]}',
  "truncated output": hadolintGood.slice(0, 60),
  "plain text": "hadolint: unknown option '-f'",
};

for (const [what, out] of Object.entries(hadolintBad)) {
  test(`repository.dockerfile: ${what} is a tool problem with the raw output kept`, async (t) => {
    const res = await run(t, "repository.dockerfile", dockerfile, () => ({
      stdout: out,
      stderr: "some message",
    }));
    assertUnreadable(res, {
      status: "tool_error",
      check: "repository.dockerfile",
      call: "hadolint-1",
      stdout: out,
      stderr: "some message",
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

test("repository.dockerfile: output that is read is still read", async (t) => {
  const res = await run(t, "repository.dockerfile", dockerfile, () => ({
    stdout: hadolintGood,
  }));
  assert.equal(res.status, "completed");
  assert.equal(res.findings?.length, 1);
  assert.deepEqual(res.artifacts ?? [], []);
});

test("repository.dockerfile: when only one of several calls is unreadable the Check is partial and keeps what was read", async (t) => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 101; i++) {
    files[`Dockerfile.${String(i).padStart(3, "0")}`] = "FROM node:24\n";
  }
  const res = await run(t, "repository.dockerfile", files, (spec) =>
    spec.name === "hadolint-2"
      ? { stdout: "boom" }
      : {
          stdout: hadolintGood.replace(
            "/snapshot/Dockerfile",
            "/snapshot/Dockerfile.000",
          ),
        },
  );
  assertUnreadable(res, {
    status: "partial",
    check: "repository.dockerfile",
    call: "hadolint-2",
    stdout: "boom",
  });
  assert.equal(res.findings?.length, 1, "the readable call keeps its Finding");
});

// --- ShellCheck ---

const shellFiles = { "run.sh": "#!/bin/sh\necho $1\n" };
const shellcheckGood =
  '{"comments":[{"file":"/snapshot/run.sh","line":2,"endLine":2,"column":6,"endColumn":8,"level":"info","code":2086,"message":"Double quote to prevent globbing and word splitting.","fix":null}]}';

const shellcheckBad: Record<string, string> = {
  "a changed JSON shape": '{"results":[{"path":"/snapshot/run.sh"}]}',
  "a comment with other keys":
    '{"comments":[{"path":"/snapshot/run.sh","severity":"error"}]}',
  "truncated output": shellcheckGood.slice(0, 50),
  "plain text": "shellcheck: /snapshot/run.sh: openBinaryFile: does not exist",
};

for (const [what, out] of Object.entries(shellcheckBad)) {
  test(`repository.shell: ${what} is a tool problem with the raw output kept`, async (t) => {
    const res = await run(t, "repository.shell", shellFiles, () => ({
      stdout: out,
    }));
    assertUnreadable(res, {
      status: "tool_error",
      check: "repository.shell",
      call: "shellcheck-sh-1",
      stdout: out,
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

// --- Redocly ---

const openapi =
  'openapi: 3.0.3\ninfo:\n  title: Orders\n  version: "1.0.0"\npaths: {}\n';
const redoclyGood =
  '{"totals":{"errors":0,"warnings":0,"ignored":0},"version":"2.70.0","problems":[]}';

const redoclyBad: Record<string, string> = {
  "a changed JSON shape": '{"totals":{},"version":"3.0.0","issues":[]}',
  "truncated output": redoclyGood.slice(0, 40),
  "plain text": "Something went wrong with the lint run.",
};

for (const [what, out] of Object.entries(redoclyBad)) {
  test(`api.lint: ${what} is a tool problem with the raw output kept`, async (t) => {
    const res = await run(t, "api.lint", { "openapi.yaml": openapi }, () => ({
      stdout: out,
      stderr: "warning text",
    }));
    assertUnreadable(res, {
      status: "tool_error",
      check: "api.lint",
      call: "redocly-1",
      stdout: out,
      stderr: "warning text",
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

test("api.lint: one unreadable file among readable ones makes the Check partial", async (t) => {
  const res = await run(
    t,
    "api.lint",
    { "a.yaml": openapi, "b.yaml": openapi },
    (spec) =>
      (spec.cmd ?? []).includes("b.yaml")
        ? { stdout: "not json" }
        : { stdout: redoclyGood },
  );
  assertUnreadable(res, {
    status: "partial",
    check: "api.lint",
    call: "redocly-2",
    stdout: "not json",
  });
});

// A C0 control character, which YAML 1.2 forbids and the native parser of
// artifacts.structured rejects as Redocly does.
const brokenOpenAPI =
  'openapi: 3.0.3\ninfo:\n  title: Orders\n  version: "1.0.0"\n  description: "broken \u0001 here"\npaths: {}\n';

test("api.lint: a file that the native parser rejects too is still blamed on the file when Redocly prints no report", async (t) => {
  const res = await run(
    t,
    "api.lint",
    { "openapi.yaml": brokenOpenAPI },
    () => ({ stderr: "Failed to parse API description" }),
    { selection: resolve(catalog(), ["api.lint"], []) },
  );
  assert.equal(res.status, "completed");
  assert.deepEqual(
    (res.findings ?? []).map((f) => [f.rule_id, f.severity]),
    [["unparseable", "error"]],
  );
  assert.deepEqual(res.artifacts ?? [], []);
});

test("api.lint: a report of another shape is never blamed on the file, even when the native parser rejects it", async (t) => {
  const res = await run(
    t,
    "api.lint",
    { "openapi.yaml": brokenOpenAPI },
    () => ({ stdout: '{"issues":[]}' }),
    { selection: resolve(catalog(), ["api.lint"], []) },
  );
  assertUnreadable(res, {
    status: "tool_error",
    check: "api.lint",
    call: "redocly-1",
    stdout: '{"issues":[]}',
  });
  assert.deepEqual(res.findings ?? [], []);
});

// --- Ajv (schema.compile) ---

const schemaFiles = {
  "schema.json":
    '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}',
};
const ajvGood =
  '{"version":"8.20.0","schemas":[{"path":"schema.json","draft":"draft-07","lax":null,"strict":null,"remote":[]}]}';

const ajvBad: Record<string, string> = {
  "a changed JSON shape": '{"version":"9.0.0","results":[]}',
  "a result without the documented keys":
    '{"version":"8.20.0","schemas":[{"file":"schema.json"}]}',
  "truncated output": ajvGood.slice(0, 70),
  "plain text": "Error: Cannot find module 'ajv'",
};

for (const [what, out] of Object.entries(ajvBad)) {
  test(`schema.compile: ${what} is a tool problem with the raw output kept`, async (t) => {
    const res = await run(t, "schema.compile", schemaFiles, () => ({
      stdout: out,
    }));
    assertUnreadable(res, {
      status: "tool_error",
      check: "schema.compile",
      call: "schema-compile",
      stdout: out,
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

test("schema.compile: a helper that exits with an error is still a helper failure", async (t) => {
  const res = await run(t, "schema.compile", schemaFiles, () => ({
    exitCode: 1,
    stderr: "crash",
  }));
  assert.deepEqual(
    [res.status, res.reasonCode],
    ["tool_error", "helper_failed"],
  );
});

// --- Helm ---

const chart = {
  "chart/Chart.yaml": "apiVersion: v2\nname: demo\nversion: 0.1.0\n",
  "chart/templates/cm.yaml":
    "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n",
};

test("repository.helm: a failed `helm lint` that prints none of its messages is a tool problem", async (t) => {
  const res = await run(t, "repository.helm", chart, (spec) => {
    const sub = (spec.cmd ?? [])[1];
    return sub === "lint"
      ? { exitCode: 1, stdout: "", stderr: "Error: the tool lost its way" }
      : { stdout: "---\n# Source: demo/templates/cm.yaml\nkind: ConfigMap\n" };
  });
  // The render of the chart could be read, so the Check is partial.
  assertUnreadable(res, {
    status: "partial",
    check: "repository.helm",
    call: "helm-1",
    stdout: "",
    stderr: "Error: the tool lost its way",
  });
  assert.deepEqual(res.findings ?? [], []);
});

test("repository.helm: a failed `helm template` without any message is a tool problem", async (t) => {
  const res = await run(t, "repository.helm", chart, (spec) => {
    const sub = (spec.cmd ?? [])[1];
    return sub === "template"
      ? { exitCode: 1, stdout: "", stderr: "" }
      : {
          stdout: "==> Linting chart\n\n1 chart(s) linted, 0 chart(s) failed\n",
        };
  });
  assertUnreadable(res, {
    status: "partial",
    check: "repository.helm",
    call: "helm-render-1",
    stdout: "",
  });
  assert.deepEqual(res.findings ?? [], []);
});

test("repository.helm: a chart that Helm says does not render is still the chart's fault", async (t) => {
  const res = await run(t, "repository.helm", chart, (spec) => {
    const sub = (spec.cmd ?? [])[1];
    return sub === "template"
      ? {
          exitCode: 1,
          stderr: "Error: template: demo/templates/cm.yaml:1: bad",
        }
      : {
          stdout: "==> Linting chart\n\n1 chart(s) linted, 0 chart(s) failed\n",
        };
  });
  assert.equal(res.status, "completed");
  assert.equal(res.findings?.length, 1);
  assert.equal(res.findings[0]?.rule_id, "helm.template");
});

// --- kubeconform ---

const manifest = {
  "deploy.yaml":
    "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n",
};
const kubeconformGood =
  '{"resources":[{"filename":"/snapshot/deploy.yaml","kind":"Deployment","name":"web","version":"apps/v1","status":"statusValid","msg":""}]}';

const kubeconformBad: Record<string, string> = {
  "a changed JSON shape":
    '{"results":[{"file":"/snapshot/deploy.yaml","state":"invalid"}]}',
  "records with other keys":
    '{"resources":[{"file":"/snapshot/deploy.yaml","state":"invalid"}]}',
  "a status it does not document": kubeconformGood.replace("statusValid", "ok"),
  "truncated output": kubeconformGood.slice(0, 60),
  "plain text": "kubeconform: could not open the schema location",
};

for (const [what, out] of Object.entries(kubeconformBad)) {
  test(`repository.kubernetes: ${what} is a tool problem with the raw output kept`, async (t) => {
    const res = await run(t, "repository.kubernetes", manifest, () => ({
      stdout: out,
    }));
    assertUnreadable(res, {
      status: "tool_error",
      check: "repository.kubernetes",
      call: "kubeconform-1",
      stdout: out,
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

// --- actionlint and zizmor ---

const workflow = {
  ".github/workflows/ci.yml":
    "on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
};
const actionlintGood =
  '[{"message":"bad","filepath":".github/workflows/ci.yml","line":3,"column":5,"kind":"syntax-check","snippet":""}]';
const zizmorGood = "[]";

const actionlintBad: Record<string, string> = {
  "a changed JSON shape": '{"errors":[]}',
  "records with other keys":
    '[{"msg":"bad","file":".github/workflows/ci.yml"}]',
  "truncated output": actionlintGood.slice(0, 40),
  "plain text": "actionlint: unknown flag -format",
};

for (const [what, out] of Object.entries(actionlintBad)) {
  test(`repository.github-actions: ${what} from actionlint is a tool problem with the raw output kept`, async (t) => {
    const res = await run(t, "repository.github-actions", workflow, (spec) =>
      spec.name === "actionlint-1" ? { stdout: out } : { stdout: zizmorGood },
    );
    // zizmor could be read, so some of the Check's calls were.
    assertUnreadable(res, {
      status: "partial",
      check: "repository.github-actions",
      call: "actionlint-1",
      stdout: out,
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

test("repository.github-actions: empty output with exit code 1 from actionlint cannot be read", async (t) => {
  const res = await run(t, "repository.github-actions", workflow, (spec) =>
    spec.name === "actionlint-1"
      ? { exitCode: 1, stdout: "", stderr: "" }
      : { stdout: zizmorGood },
  );
  assertUnreadable(res, {
    status: "partial",
    check: "repository.github-actions",
    call: "actionlint-1",
    stdout: "",
  });
});

const zizmorBad: Record<string, string> = {
  "a changed JSON shape": '{"findings":[]}',
  "records with other keys": '[{"id":"template-injection","severity":"High"}]',
  "truncated output": '[{"ident":"template-injection","desc":"',
  "plain text": "zizmor: no such option",
};

for (const [what, out] of Object.entries(zizmorBad)) {
  test(`repository.github-actions: ${what} from zizmor is a tool problem with the raw output kept`, async (t) => {
    const res = await run(t, "repository.github-actions", workflow, (spec) =>
      spec.name === "zizmor-1" ? { stdout: out } : { stdout: "" },
    );
    assertUnreadable(res, {
      status: "partial",
      check: "repository.github-actions",
      call: "zizmor-1",
      stdout: out,
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

// --- docker compose config ---

const compose = { "compose.yaml": "services:\n  web:\n    image: nginx\n" };

test("repository.compose: an exit code 1 without any message is a tool problem", async (t) => {
  const res = await run(t, "repository.compose", compose, () => ({
    exitCode: 1,
  }));
  assertUnreadable(res, {
    status: "tool_error",
    check: "repository.compose",
    call: "compose-1",
    stdout: "",
  });
  assert.deepEqual(res.findings ?? [], []);
});

for (const [what, stderr] of Object.entries({
  "the CLI that does not know the compose command":
    "docker: unknown command: docker compose\n",
  "usage text":
    "unknown shorthand flag: 'q' in -q\n\nUsage:  docker compose [OPTIONS]\n",
})) {
  test(`repository.compose: ${what} is a tool problem, not an invalid compose set`, async (t) => {
    const res = await run(t, "repository.compose", compose, () => ({
      exitCode: 1,
      stderr,
    }));
    assertUnreadable(res, {
      status: "tool_error",
      check: "repository.compose",
      call: "compose-1",
      stdout: "",
      stderr,
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

test("repository.compose: a message that compose prints about the set is still the set's fault", async (t) => {
  const res = await run(t, "repository.compose", compose, () => ({
    exitCode: 1,
    stderr:
      "validating /snapshot/compose.yaml: services.web.image must be a string\n",
  }));
  assert.equal(res.status, "completed");
  assert.equal(res.findings?.length, 1);
  assert.equal(res.findings[0]?.rule_id, "compose.invalid");
});
