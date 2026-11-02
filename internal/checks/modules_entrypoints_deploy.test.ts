import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import { tree } from "./checks.testutil.ts";
import {
  deploymentCommands,
  deploymentEntryPoints,
  type StartedEntry,
  yamlCommands,
} from "./modules_entrypoints_deploy.ts";
import { yamlDocuments } from "./kubernetes_manifests.ts";

const v2Chart = "apiVersion: v2\nname: app\nversion: 0.1.0\n";

function covered(...files: string[]): Set<string> {
  return new Set(files);
}

/**
 * startedEntries returns the entry points that the deployment files of a
 * made-up project start in its root package, whose package.json is
 * files["package.json"] and whose cruised files are covered.
 */
function startedEntries(
  t: TestContext,
  files: Record<string, string>,
  files2: Set<string>,
): StartedEntry[] {
  return deploymentEntryPoints(
    deploymentCommands(tree(t, files)),
    ".",
    Buffer.from(files["package.json"] ?? ""),
    files2,
  );
}

function entry(
  file: string,
  deploymentFile: string,
  command: string,
): StartedEntry {
  return { file, deploymentFile, command };
}

void test("a Helm values file that runs an npm script starts the script's node file", (t) => {
  const got = startedEntries(
    t,
    {
      "package.json": `{"name": "svc", "scripts": {"job": "node src/jobs/job.js", "generate": "node dev/generate.js"}}`,
      "charts/svc/Chart.yaml": v2Chart,
      "charts/svc/values.yaml":
        'cronJobs:\n  - name: job\n    schedule: "*/5 * * * *"\n' +
        '    command: [ "npm", "run", "job" ]\n',
    },
    covered("src/jobs/job.js", "dev/generate.js"),
  );
  assert.deepEqual(got, [
    entry("src/jobs/job.js", "charts/svc/values.yaml", "npm run job"),
  ]);
});

void test("a command whose script name is in its args starts the script", (t) => {
  const got = startedEntries(
    t,
    {
      "package.json": `{"name": "svc", "scripts": {"update_all": "node src/jobs/all.js"}}`,
      "charts/svc/Chart.yaml": v2Chart,
      "charts/svc/values-prod.yaml":
        'preDeploymentJob:\n  command: [ "npm" ]\n' +
        '  args: [ "run", "update_all" ]\n',
    },
    covered("src/jobs/all.js"),
  );
  assert.deepEqual(got, [
    entry(
      "src/jobs/all.js",
      "charts/svc/values-prod.yaml",
      "npm run update_all",
    ),
  ]);
});

void test("a chained script starts each of its node files and follows its npm run steps", (t) => {
  const got = startedEntries(
    t,
    {
      "package.json": `{"name": "svc", "scripts": {
			"all": "NODE_ENV=production node --max-old-space-size=512 src/jobs/a.js && npm run b && echo done",
			"b": "node src/jobs/b && npm run all"}}`,
      "k8s/cronjob.yaml":
        "apiVersion: batch/v1\nkind: CronJob\nspec:\n  jobTemplate:\n    spec:\n      template:\n        spec:\n" +
        '          containers:\n            - name: all\n              command: ["npm", "run-script", "all"]\n',
    },
    covered("src/jobs/a.js", "src/jobs/b.js"),
  );
  assert.deepEqual(got, [
    entry("src/jobs/a.js", "k8s/cronjob.yaml", "npm run-script all"),
    entry("src/jobs/b.js", "k8s/cronjob.yaml", "npm run-script all"),
  ]);
});

void test("a Dockerfile command in exec form starts its node file", (t) => {
  const got = startedEntries(
    t,
    {
      "package.json": `{"name": "svc"}`,
      Dockerfile:
        'FROM node:22\nWORKDIR /app\nCOPY . .\nCMD ["node", "worker.js"]\n',
    },
    covered("worker.js"),
  );
  assert.deepEqual(got, [entry("worker.js", "Dockerfile", "node worker.js")]);
});

void test("a Dockerfile entrypoint runs its cmd and either may start a file", (t) => {
  const got = startedEntries(
    t,
    {
      "package.json": `{"name": "svc", "scripts": {"start": "node src/server.js"}}`,
      // The ENTRYPOINT runs the CMD as its arguments.
      Dockerfile:
        'FROM node:22 AS build\nCMD ["node", "build.js"]\n' +
        "FROM node:22-alpine\nWORKDIR /srv\nWORKDIR app\n" +
        'ENTRYPOINT ["node", "--enable-source-maps"]\n# the job\nCMD [ \\\n  "/srv/app/src/job.js" ]\n',
      // A base image's entrypoint runs the CMD; npm start runs the start script.
      "docker/web.Dockerfile":
        'FROM node:22\nENTRYPOINT ["docker-entrypoint.sh"]\nCMD npm start\n',
    },
    covered("build.js", "src/job.js", "src/server.js"),
  );
  assert.deepEqual(got, [
    entry(
      "src/job.js",
      "Dockerfile",
      "node --enable-source-maps /srv/app/src/job.js",
    ),
    entry("src/server.js", "docker/web.Dockerfile", "npm start"),
  ]);
});

// Only the last build stage is the image that runs. A shell-form ENTRYPOINT
// makes Docker ignore the CMD.
void test("only the last stage of a Dockerfile counts and a shell-form entrypoint ignores the cmd", (t) => {
  const got = startedEntries(
    t,
    {
      "package.json": `{"name": "svc"}`,
      Dockerfile:
        'FROM node:22 AS build\nENTRYPOINT ["node", "src/build.js"]\n' +
        'FROM node:22-alpine\nCMD ["node", "src/server.js"]\n',
      "docker/job.Dockerfile":
        'FROM node:22\nCMD ["node", "src/ignored.js"]\nENTRYPOINT node src/job.js\n',
    },
    covered("src/build.js", "src/server.js", "src/ignored.js", "src/job.js"),
  );
  assert.deepEqual(got, [
    entry("src/server.js", "Dockerfile", "node src/server.js"),
    entry("src/job.js", "docker/job.Dockerfile", "node src/job.js"),
  ]);
});

void test("npm start without a start script runs server.js", (t) => {
  const got = startedEntries(
    t,
    {
      "package.json": `{"name": "svc"}`,
      "k8s/pod.yaml":
        'apiVersion: v1\nkind: Pod\nspec:\n  containers:\n    - command: ["npm", "start"]\n',
    },
    covered("server.js"),
  );
  assert.deepEqual(got, [entry("server.js", "k8s/pod.yaml", "npm start")]);
});

void test("Helm templates that parse as YAML are read", (t) => {
  const got = startedEntries(
    t,
    {
      "package.json": `{"name": "svc"}`,
      "charts/svc/Chart.yaml": v2Chart,
      "charts/svc/templates/job.yaml":
        "apiVersion: batch/v1\nkind: Job\nspec:\n  template:\n    spec:\n" +
        '      containers:\n        - command: ["node", "src/migrate.js"]\n',
      "charts/svc/templates/cron.yaml":
        "{{- if .Values.cron }}\napiVersion: batch/v1\nkind: CronJob\n" +
        'spec: {{ toYaml .Values.cron | nindent 2 }}\n  command: ["node", "src/cron.js"]\n{{- end }}\n',
    },
    covered("src/migrate.js", "src/cron.js"),
  );
  assert.deepEqual(got, [
    entry(
      "src/migrate.js",
      "charts/svc/templates/job.yaml",
      "node src/migrate.js",
    ),
  ]);
});

// A working directory inside an image says nothing sure about the package, so
// it is not matched: a Dockerfile's command belongs to the package whose
// folder most closely contains the Dockerfile, and the commands of Helm
// charts and Kubernetes manifests belong to the root package.
void test("a Dockerfile command belongs to the package that contains it and other commands to the root", (t) => {
  const proj = tree(t, {
    "package.json": `{"name": "root"}`,
    "services/api/package.json": `{"name": "api"}`,
    "services/api/docker/Dockerfile":
      'FROM node:22\nWORKDIR /srv\nCMD ["node", "api-worker.js"]\n',
    Dockerfile:
      'FROM node:22\nWORKDIR /usr/src/services/api\nCMD ["node", "root-worker.js"]\n',
    "deploy/api-job.yaml":
      'apiVersion: batch/v1\nkind: Job\nspec:\n  containers:\n    - command: ["node", "other.js"]\n      workingDir: /app/services/api\n',
  });
  const files = covered("api-worker.js", "root-worker.js", "other.js");
  const commands = deploymentCommands(proj);
  const api = deploymentEntryPoints(
    commands,
    "services/api",
    Buffer.from(`{"name": "api"}`),
    files,
  );
  const root = deploymentEntryPoints(
    commands,
    ".",
    Buffer.from(`{"name": "root"}`),
    files,
  );
  assert.deepEqual(api, [
    entry(
      "api-worker.js",
      "services/api/docker/Dockerfile",
      "node api-worker.js",
    ),
  ]);
  assert.deepEqual(root, [
    entry("root-worker.js", "Dockerfile", "node root-worker.js"),
    entry("other.js", "deploy/api-job.yaml", "node other.js"),
  ]);
});

void test("a command through a shell is ignored", (t) => {
  const got = startedEntries(
    t,
    {
      "package.json": `{"name": "svc", "scripts": {"job": "node src/jobs/job.js", "piped": "node src/jobs/job.js | tee out"}}`,
      "charts/svc/Chart.yaml": v2Chart,
      "charts/svc/values.yaml":
        'jobs:\n  - command: [ "sh", "-c", "npm run job" ]\n' +
        '  - command: "npm run job && echo done"\n' +
        '  - command: [ "npm", "run", "piped" ]\n',
      Dockerfile: "FROM node:22\nCMD npm run job > /tmp/log\n",
    },
    covered("src/jobs/job.js"),
  );
  assert.deepEqual(got, []);
});

// `npm` and `node` may be given with their folder, in a deployment file as in
// a script.
void test("npm given with its folder in a script is followed", (t) => {
  const got = startedEntries(
    t,
    {
      "package.json": `{"name": "svc", "scripts": {"all": "/usr/local/bin/npm run job", "job": "/usr/local/bin/node src/jobs/job.js"}}`,
      "k8s/job.yaml":
        'apiVersion: batch/v1\nkind: Job\nspec:\n  containers:\n    - command: ["/usr/local/bin/npm", "run", "all"]\n',
    },
    covered("src/jobs/job.js"),
  );
  assert.deepEqual(got, [
    entry("src/jobs/job.js", "k8s/job.yaml", "/usr/local/bin/npm run all"),
  ]);
});

// After `cd` the files of a chain are relative to another folder, which the
// tool does not follow: such a script starts nothing, while the script that
// runs it with `npm run` keeps its own node steps.
void test("a script that changes its working directory starts nothing", (t) => {
  const got = startedEntries(
    t,
    {
      "package.json": `{"name": "svc", "scripts": {
			"all": "node src/jobs/a.js && npm run sub",
			"sub": "cd tools && node src/jobs/b.js",
			"pushed": "pushd tools && node src/jobs/c.js"}}`,
      "k8s/job.yaml":
        "apiVersion: batch/v1\nkind: Job\nspec:\n  containers:\n" +
        '    - command: ["npm", "run", "all"]\n    - command: ["npm", "run", "pushed"]\n',
    },
    covered("src/jobs/a.js", "src/jobs/b.js", "src/jobs/c.js"),
  );
  assert.deepEqual(got, [
    entry("src/jobs/a.js", "k8s/job.yaml", "npm run all"),
  ]);
});

// Only evident deployments of the service count: deployment files in Test
// code or Test data start nothing in production.
void test("deployment files in Test code or Test data start nothing", (t) => {
  const got = startedEntries(
    t,
    {
      "package.json": `{"name": "svc"}`,
      "test/Dockerfile": 'FROM node:22\nCMD ["node", "src/a.js"]\n',
      "test/k8s/job.yaml":
        'apiVersion: batch/v1\nkind: Job\nspec:\n  containers:\n    - command: ["node", "src/b.js"]\n',
      "test/fixtures/charts/x/Chart.yaml": v2Chart,
      "test/fixtures/charts/x/values.yaml":
        'job:\n  command: ["node", "src/c.js"]\n',
    },
    covered("src/a.js", "src/b.js", "src/c.js"),
  );
  assert.deepEqual(got, []);
});

// A Helm test hook runs only under `helm test`, never in production.
void test("Helm test hooks start nothing", (t) => {
  const got = startedEntries(
    t,
    {
      "package.json": `{"name": "svc"}`,
      "charts/svc/Chart.yaml": v2Chart,
      "charts/svc/templates/tests/connection.yaml":
        'apiVersion: v1\nkind: Pod\nspec:\n  containers:\n    - command: ["node", "src/a.js"]\n',
      "charts/svc/templates/smoke.yaml":
        "apiVersion: v1\nkind: Pod\nmetadata:\n  annotations:\n    helm.sh/hook: test\n" +
        'spec:\n  containers:\n    - command: ["node", "src/b.js"]\n' +
        "---\napiVersion: batch/v1\nkind: Job\nmetadata:\n  annotations:\n    helm.sh/hook: pre-install,pre-upgrade\n" +
        'spec:\n  template:\n    spec:\n      containers:\n        - command: ["node", "src/migrate.js"]\n',
      "k8s/check.yaml":
        'apiVersion: v1\nkind: Pod\nmetadata:\n  annotations:\n    "helm.sh/hook": post-install, test-success\n' +
        'spec:\n  containers:\n    - command: ["node", "src/c.js"]\n',
    },
    covered("src/a.js", "src/b.js", "src/c.js", "src/migrate.js"),
  );
  assert.deepEqual(got, [
    entry(
      "src/migrate.js",
      "charts/svc/templates/smoke.yaml",
      "node src/migrate.js",
    ),
  ]);
});

// A Dockerfile or Helm values file whose name says it is for development, a
// local run, tests or CI does not deploy the service.
void test("Dockerfiles and values files for development, local, tests or CI start nothing", (t) => {
  const got = startedEntries(
    t,
    {
      "package.json": `{"name": "svc"}`,
      "Dockerfile.dev": 'FROM node:22\nCMD ["node", "src/a.js"]\n',
      "docker/test.Dockerfile": 'FROM node:22\nCMD ["node", "src/b.js"]\n',
      "docker/Dockerfile.ci": 'FROM node:22\nCMD ["node", "src/c.js"]\n',
      "docker/Dockerfile.prod": 'FROM node:22\nCMD ["node", "src/prod.js"]\n',
      "docker/latest.Dockerfile":
        'FROM node:22\nCMD ["node", "src/latest.js"]\n',
      "charts/svc/Chart.yaml": v2Chart,
      "charts/svc/values-local.yaml": 'job:\n  command: ["node", "src/d.js"]\n',
      "charts/svc/values.test.yaml": 'job:\n  command: ["node", "src/e.js"]\n',
      "charts/svc/values_DEV.yaml": 'job:\n  command: ["node", "src/f.js"]\n',
      "charts/svc/values-live.yaml":
        'job:\n  command: ["node", "src/live.js"]\n',
    },
    covered(
      "src/a.js",
      "src/b.js",
      "src/c.js",
      "src/d.js",
      "src/e.js",
      "src/f.js",
      "src/prod.js",
      "src/latest.js",
      "src/live.js",
    ),
  );
  assert.deepEqual(got, [
    entry("src/live.js", "charts/svc/values-live.yaml", "node src/live.js"),
    entry("src/prod.js", "docker/Dockerfile.prod", "node src/prod.js"),
    entry("src/latest.js", "docker/latest.Dockerfile", "node src/latest.js"),
  ]);
});

// The commands of a mapping come after those of the mappings inside it, as in
// the recursive walk of Go, and a document nested as deep as yaml.v3 allows is
// walked without recursion.
void test("YAML commands are listed inner mappings first and deep documents are walked", () => {
  const docs = yamlDocuments(
    Buffer.from(
      'outer:\n  command: ["node", "outer.js"]\n  inner:\n    command: ["node", "inner.js"]\n',
    ),
  );
  assert.deepEqual(
    yamlCommands("f.yaml", docs).map((c) => c.argv.join(" ")),
    ["node inner.js", "node outer.js"],
  );

  const depth = 3000;
  const deep = yamlDocuments(
    Buffer.from(
      "[".repeat(depth) + '{command: ["node", "deep.js"]}' + "]".repeat(depth),
    ),
  );
  assert.deepEqual(
    yamlCommands("deep.yaml", deep).map((c) => c.argv.join(" ")),
    ["node deep.js"],
  );
});
