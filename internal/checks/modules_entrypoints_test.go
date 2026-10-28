package checks

import (
	"slices"
	"strings"
	"testing"
)

// covered is the set of files a cruise covers in the entry-point tests.
func covered(files ...string) map[string]bool {
	out := map[string]bool{}
	for _, f := range files {
		out[f] = true
	}
	return out
}

func TestProductionEntryPoints(t *testing.T) {
	all := covered("index.js", "server.js", "lib/main.js", "lib/index.js", "lib/esm.mjs", "lib/cjs.cjs",
		"lib/node.js", "lib/features/a.js", "lib/features/b.js", "bin/cli.js", "bin/other.js", "src/start.js")
	tests := []struct {
		name     string
		manifest string
		files    map[string]bool
		want     []string
	}{
		{"main", `{"main": "server.js"}`, all, []string{"server.js"}},
		{"main with ./ and without extension", `{"main": "./lib/main"}`, all, []string{"lib/main.js"}},
		{"main naming a folder", `{"main": "lib"}`, all, []string{"lib/index.js"}},
		{"index.js when main is missing", `{"name": "x"}`, all, []string{"index.js"}},
		{"no index.js default when main is missing and index.js is not covered", `{"name": "x"}`, covered("server.js"), nil},
		{"no index.js default when main is set", `{"main": "server.js"}`, all, []string{"server.js"}},
		{"exports as a string", `{"main": "server.js", "exports": "./lib/main.js"}`, all, []string{"server.js", "lib/main.js"}},
		{"nested exports conditions", `{"main": "server.js", "exports": {
			".": {"import": "./lib/esm.mjs", "require": {"node": "./lib/node.js", "default": "./lib/cjs.cjs"}},
			"./package.json": "./package.json",
			"./internal": null,
			"./alt": ["./lib/main.js", "./lib/index.js"]}}`,
			all, []string{"server.js", "lib/cjs.cjs", "lib/esm.mjs", "lib/index.js", "lib/main.js", "lib/node.js"}},
		{"exports pattern", `{"main": "server.js", "exports": {"./features/*": "./lib/features/*.js"}}`, all,
			[]string{"server.js", "lib/features/a.js", "lib/features/b.js"}},
		{"bin as a string", `{"main": "server.js", "bin": "./bin/cli.js"}`, all, []string{"server.js", "bin/cli.js"}},
		{"bin as an object", `{"main": "server.js", "bin": {"b": "bin/other.js", "a": "bin/cli.js"}}`, all,
			[]string{"server.js", "bin/cli.js", "bin/other.js"}},
		{"start with Node options", `{"main": "server.js", "scripts": {"start": "node --max-old-space-size=4096 -r dotenv/config --enable-source-maps src/start.js --port 80"}}`,
			all, []string{"server.js", "src/start.js"}},
		{"start without extension", `{"main": "server.js", "scripts": {"start": "node src/start"}}`, all, []string{"server.js", "src/start.js"}},
		{"start that is not plain node", `{"main": "server.js", "scripts": {"start": "npm run build && node src/start.js"}}`, all, []string{"server.js"}},
		{"start that evaluates code", `{"main": "server.js", "scripts": {"start": "node -e \"require('./src/start.js')\""}}`, all, []string{"server.js"}},
		{"start through another program", `{"main": "server.js", "scripts": {"start": "nodemon src/start.js"}}`, all, []string{"server.js"}},
		{"a target that is the same file twice is listed once", `{"main": "./server.js", "exports": "./server.js", "scripts": {"start": "node server.js"}}`, all, []string{"server.js"}},
		{"missing targets are ignored", `{"main": "gone.js", "exports": {".": "./dist/index.js"}, "bin": {"x": "bin/gone.js"}, "scripts": {"start": "node gone.js"}}`, covered("server.js"), nil},
		// Node loads index.js when `main` names no file (DEP0128).
		{"index.js when main names a missing file", `{"main": "gone.js"}`, all, []string{"index.js"}},
		{"index.js when main names a missing folder", `{"main": "./gone/"}`, all, []string{"index.js"}},
		{"targets outside the package are ignored", `{"main": "../server.js", "bin": "/bin/cli.js"}`, all, nil},
		{"package.json that is not JSON", `{"main": `, all, nil},
		// Node ignores a `main` that is not a string and loads index.js.
		{"fields of the wrong type", `{"main": 3, "exports": 4, "bin": [1], "scripts": {"start": 5}}`, all, []string{"index.js"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := productionEntryPoints([]byte(tc.manifest), tc.files, func(p string) bool { return tc.files[p] })
			if strings.Join(got, ",") != strings.Join(tc.want, ",") {
				t.Errorf("entry points = %v, want %v", got, tc.want)
			}
		})
	}
}

// A `main` that names a file the cruise does not cover, such as Build output,
// is what Node loads, so index.js is no entry point then.
func TestNoIndexJSWhenMainNamesAFileTheCruiseDoesNotCover(t *testing.T) {
	onDisk := covered("index.js", "dist/server.js")

	got := productionEntryPoints([]byte(`{"main": "dist/server"}`), covered("index.js"), func(p string) bool { return onDisk[p] })

	if len(got) != 0 {
		t.Errorf("entry points = %v, want none", got)
	}
}

func TestReachedFilesNameTheFirstEntryPointThatReachesThem(t *testing.T) {
	edges := map[string][]string{
		"index.js":        {"src/app.js"},
		"src/app.js":      {"src/a.js", "src/lazy.js"},
		"src/a.js":        {"src/b.js"},
		"src/b.js":        {"src/a.js"}, // a cycle
		"bin/cli.js":      {"src/a.js", "src/cli-only.js"},
		"dev/generate.js": {"src/a.js", "dev/helper.js"},
	}

	got := reachedFrom([]string{"index.js", "bin/cli.js"}, edges)

	want := map[string]string{
		"index.js": "index.js", "src/app.js": "index.js", "src/a.js": "index.js", "src/b.js": "index.js",
		"src/lazy.js": "index.js", "bin/cli.js": "bin/cli.js", "src/cli-only.js": "bin/cli.js",
	}
	if len(got) != len(want) {
		t.Errorf("reached = %v, want %v", got, want)
	}
	for f, entry := range want {
		if got[f] != entry {
			t.Errorf("%s reached from %q, want %q", f, got[f], entry)
		}
	}
	for _, f := range []string{"dev/generate.js", "dev/helper.js"} {
		if _, ok := got[f]; ok {
			t.Errorf("%s is reached by no entry point, yet %v", f, got)
		}
	}
}

// startedEntries returns the entry points that the deployment files of a
// made-up project start in its root package, whose package.json is
// files["package.json"] and whose cruised files are covered.
func startedEntries(t *testing.T, files map[string]string, covered map[string]bool) []startedEntry {
	t.Helper()
	return deploymentEntryPoints(deploymentCommands(tree(t, files)), ".", []byte(files["package.json"]), covered)
}

func assertStarted(t *testing.T, got []startedEntry, want ...startedEntry) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Errorf("entry points = %+v, want %+v", got, want)
	}
}

func TestAHelmValuesFileThatRunsAnNPMScriptStartsTheScriptsNodeFile(t *testing.T) {
	got := startedEntries(t, map[string]string{
		"package.json":          `{"name": "svc", "scripts": {"job": "node src/jobs/job.js", "generate": "node dev/generate.js"}}`,
		"charts/svc/Chart.yaml": v2Chart,
		"charts/svc/values.yaml": "cronJobs:\n  - name: job\n    schedule: \"*/5 * * * *\"\n" +
			"    command: [ \"npm\", \"run\", \"job\" ]\n",
	}, covered("src/jobs/job.js", "dev/generate.js"))

	assertStarted(t, got, startedEntry{File: "src/jobs/job.js", DeploymentFile: "charts/svc/values.yaml", Command: "npm run job"})
}

func TestACommandWhoseScriptNameIsInItsArgsStartsTheScript(t *testing.T) {
	got := startedEntries(t, map[string]string{
		"package.json":          `{"name": "svc", "scripts": {"update_all": "node src/jobs/all.js"}}`,
		"charts/svc/Chart.yaml": v2Chart,
		"charts/svc/values-prod.yaml": "preDeploymentJob:\n  command: [ \"npm\" ]\n" +
			"  args: [ \"run\", \"update_all\" ]\n",
	}, covered("src/jobs/all.js"))

	assertStarted(t, got, startedEntry{File: "src/jobs/all.js", DeploymentFile: "charts/svc/values-prod.yaml", Command: "npm run update_all"})
}

func TestAChainedScriptStartsEachOfItsNodeFilesAndFollowsItsNPMRunSteps(t *testing.T) {
	got := startedEntries(t, map[string]string{
		"package.json": `{"name": "svc", "scripts": {
			"all": "NODE_ENV=production node --max-old-space-size=512 src/jobs/a.js && npm run b && echo done",
			"b": "node src/jobs/b && npm run all"}}`,
		"k8s/cronjob.yaml": "apiVersion: batch/v1\nkind: CronJob\nspec:\n  jobTemplate:\n    spec:\n      template:\n        spec:\n" +
			"          containers:\n            - name: all\n              command: [\"npm\", \"run-script\", \"all\"]\n",
	}, covered("src/jobs/a.js", "src/jobs/b.js"))

	assertStarted(t, got,
		startedEntry{File: "src/jobs/a.js", DeploymentFile: "k8s/cronjob.yaml", Command: "npm run-script all"},
		startedEntry{File: "src/jobs/b.js", DeploymentFile: "k8s/cronjob.yaml", Command: "npm run-script all"})
}

func TestADockerfileCommandInExecFormStartsItsNodeFile(t *testing.T) {
	got := startedEntries(t, map[string]string{
		"package.json": `{"name": "svc"}`,
		"Dockerfile":   "FROM node:22\nWORKDIR /app\nCOPY . .\nCMD [\"node\", \"worker.js\"]\n",
	}, covered("worker.js"))

	assertStarted(t, got, startedEntry{File: "worker.js", DeploymentFile: "Dockerfile", Command: "node worker.js"})
}

func TestADockerfileEntrypointRunsItsCmdAndEitherMayStartAFile(t *testing.T) {
	files := map[string]string{
		"package.json": `{"name": "svc", "scripts": {"start": "node src/server.js"}}`,
		// The ENTRYPOINT runs the CMD as its arguments.
		"Dockerfile": "FROM node:22 AS build\nCMD [\"node\", \"build.js\"]\n" +
			"FROM node:22-alpine\nWORKDIR /srv\nWORKDIR app\n" +
			"ENTRYPOINT [\"node\", \"--enable-source-maps\"]\n# the job\nCMD [ \\\n  \"/srv/app/src/job.js\" ]\n",
		// A base image's entrypoint runs the CMD; npm start runs the start script.
		"docker/web.Dockerfile": "FROM node:22\nENTRYPOINT [\"docker-entrypoint.sh\"]\nCMD npm start\n",
	}
	got := startedEntries(t, files, covered("build.js", "src/job.js", "src/server.js"))

	assertStarted(t, got,
		startedEntry{File: "src/job.js", DeploymentFile: "Dockerfile", Command: "node --enable-source-maps /srv/app/src/job.js"},
		startedEntry{File: "src/server.js", DeploymentFile: "docker/web.Dockerfile", Command: "npm start"})
}

// Only the last build stage is the image that runs. A shell-form ENTRYPOINT
// makes Docker ignore the CMD.
func TestOnlyTheLastStageOfADockerfileCountsAndAShellFormEntrypointIgnoresTheCmd(t *testing.T) {
	got := startedEntries(t, map[string]string{
		"package.json": `{"name": "svc"}`,
		"Dockerfile": "FROM node:22 AS build\nENTRYPOINT [\"node\", \"src/build.js\"]\n" +
			"FROM node:22-alpine\nCMD [\"node\", \"src/server.js\"]\n",
		"docker/job.Dockerfile": "FROM node:22\nCMD [\"node\", \"src/ignored.js\"]\nENTRYPOINT node src/job.js\n",
	}, covered("src/build.js", "src/server.js", "src/ignored.js", "src/job.js"))

	assertStarted(t, got,
		startedEntry{File: "src/server.js", DeploymentFile: "Dockerfile", Command: "node src/server.js"},
		startedEntry{File: "src/job.js", DeploymentFile: "docker/job.Dockerfile", Command: "node src/job.js"})
}

func TestNPMStartWithoutAStartScriptRunsServerJS(t *testing.T) {
	got := startedEntries(t, map[string]string{
		"package.json": `{"name": "svc"}`,
		"k8s/pod.yaml": "apiVersion: v1\nkind: Pod\nspec:\n  containers:\n    - command: [\"npm\", \"start\"]\n",
	}, covered("server.js"))

	assertStarted(t, got, startedEntry{File: "server.js", DeploymentFile: "k8s/pod.yaml", Command: "npm start"})
}

func TestHelmTemplatesThatParseAsYAMLAreRead(t *testing.T) {
	got := startedEntries(t, map[string]string{
		"package.json":          `{"name": "svc"}`,
		"charts/svc/Chart.yaml": v2Chart,
		"charts/svc/templates/job.yaml": "apiVersion: batch/v1\nkind: Job\nspec:\n  template:\n    spec:\n" +
			"      containers:\n        - command: [\"node\", \"src/migrate.js\"]\n",
		"charts/svc/templates/cron.yaml": "{{- if .Values.cron }}\napiVersion: batch/v1\nkind: CronJob\n" +
			"spec: {{ toYaml .Values.cron | nindent 2 }}\n  command: [\"node\", \"src/cron.js\"]\n{{- end }}\n",
	}, covered("src/migrate.js", "src/cron.js"))

	assertStarted(t, got, startedEntry{File: "src/migrate.js", DeploymentFile: "charts/svc/templates/job.yaml", Command: "node src/migrate.js"})
}

// A working directory inside an image says nothing sure about the package, so
// it is not matched: a Dockerfile's command belongs to the package whose folder
// most closely contains the Dockerfile, and the commands of Helm charts and
// Kubernetes manifests belong to the root package.
func TestADockerfileCommandBelongsToThePackageThatContainsItAndOtherCommandsToTheRoot(t *testing.T) {
	proj := tree(t, map[string]string{
		"package.json":                   `{"name": "root"}`,
		"services/api/package.json":      `{"name": "api"}`,
		"services/api/docker/Dockerfile": "FROM node:22\nWORKDIR /srv\nCMD [\"node\", \"api-worker.js\"]\n",
		"Dockerfile":                     "FROM node:22\nWORKDIR /usr/src/services/api\nCMD [\"node\", \"root-worker.js\"]\n",
		"deploy/api-job.yaml":            "apiVersion: batch/v1\nkind: Job\nspec:\n  containers:\n    - command: [\"node\", \"other.js\"]\n      workingDir: /app/services/api\n",
	})
	files := covered("api-worker.js", "root-worker.js", "other.js")
	commands := deploymentCommands(proj)
	api := deploymentEntryPoints(commands, "services/api", []byte(`{"name": "api"}`), files)
	root := deploymentEntryPoints(commands, ".", []byte(`{"name": "root"}`), files)

	assertStarted(t, api, startedEntry{File: "api-worker.js", DeploymentFile: "services/api/docker/Dockerfile", Command: "node api-worker.js"})
	assertStarted(t, root,
		startedEntry{File: "root-worker.js", DeploymentFile: "Dockerfile", Command: "node root-worker.js"},
		startedEntry{File: "other.js", DeploymentFile: "deploy/api-job.yaml", Command: "node other.js"})
}

func TestACommandThroughAShellIsIgnored(t *testing.T) {
	got := startedEntries(t, map[string]string{
		"package.json":          `{"name": "svc", "scripts": {"job": "node src/jobs/job.js", "piped": "node src/jobs/job.js | tee out"}}`,
		"charts/svc/Chart.yaml": v2Chart,
		"charts/svc/values.yaml": "jobs:\n  - command: [ \"sh\", \"-c\", \"npm run job\" ]\n" +
			"  - command: \"npm run job && echo done\"\n" +
			"  - command: [ \"npm\", \"run\", \"piped\" ]\n",
		"Dockerfile": "FROM node:22\nCMD npm run job > /tmp/log\n",
	}, covered("src/jobs/job.js"))

	assertStarted(t, got)
}

// `npm` and `node` may be given with their folder, in a deployment file as in
// a script.
func TestNPMGivenWithItsFolderInAScriptIsFollowed(t *testing.T) {
	got := startedEntries(t, map[string]string{
		"package.json": `{"name": "svc", "scripts": {"all": "/usr/local/bin/npm run job", "job": "/usr/local/bin/node src/jobs/job.js"}}`,
		"k8s/job.yaml": "apiVersion: batch/v1\nkind: Job\nspec:\n  containers:\n    - command: [\"/usr/local/bin/npm\", \"run\", \"all\"]\n",
	}, covered("src/jobs/job.js"))

	assertStarted(t, got, startedEntry{File: "src/jobs/job.js", DeploymentFile: "k8s/job.yaml", Command: "/usr/local/bin/npm run all"})
}

// After `cd` the files of a chain are relative to another folder, which the
// tool does not follow: such a script starts nothing, while the script that
// runs it with `npm run` keeps its own node steps.
func TestAScriptThatChangesItsWorkingDirectoryStartsNothing(t *testing.T) {
	got := startedEntries(t, map[string]string{
		"package.json": `{"name": "svc", "scripts": {
			"all": "node src/jobs/a.js && npm run sub",
			"sub": "cd tools && node src/jobs/b.js",
			"pushed": "pushd tools && node src/jobs/c.js"}}`,
		"k8s/job.yaml": "apiVersion: batch/v1\nkind: Job\nspec:\n  containers:\n" +
			"    - command: [\"npm\", \"run\", \"all\"]\n    - command: [\"npm\", \"run\", \"pushed\"]\n",
	}, covered("src/jobs/a.js", "src/jobs/b.js", "src/jobs/c.js"))

	assertStarted(t, got, startedEntry{File: "src/jobs/a.js", DeploymentFile: "k8s/job.yaml", Command: "npm run all"})
}

// Only evident deployments of the service count: deployment files in Test code
// or Test data start nothing in production.
func TestDeploymentFilesInTestCodeOrTestDataStartNothing(t *testing.T) {
	got := startedEntries(t, map[string]string{
		"package.json":                       `{"name": "svc"}`,
		"test/Dockerfile":                    "FROM node:22\nCMD [\"node\", \"src/a.js\"]\n",
		"test/k8s/job.yaml":                  "apiVersion: batch/v1\nkind: Job\nspec:\n  containers:\n    - command: [\"node\", \"src/b.js\"]\n",
		"test/fixtures/charts/x/Chart.yaml":  v2Chart,
		"test/fixtures/charts/x/values.yaml": "job:\n  command: [\"node\", \"src/c.js\"]\n",
	}, covered("src/a.js", "src/b.js", "src/c.js"))

	assertStarted(t, got)
}

// A Helm test hook runs only under `helm test`, never in production.
func TestHelmTestHooksStartNothing(t *testing.T) {
	got := startedEntries(t, map[string]string{
		"package.json":          `{"name": "svc"}`,
		"charts/svc/Chart.yaml": v2Chart,
		"charts/svc/templates/tests/connection.yaml": "apiVersion: v1\nkind: Pod\nspec:\n  containers:\n    - command: [\"node\", \"src/a.js\"]\n",
		"charts/svc/templates/smoke.yaml": "apiVersion: v1\nkind: Pod\nmetadata:\n  annotations:\n    helm.sh/hook: test\n" +
			"spec:\n  containers:\n    - command: [\"node\", \"src/b.js\"]\n" +
			"---\napiVersion: batch/v1\nkind: Job\nmetadata:\n  annotations:\n    helm.sh/hook: pre-install,pre-upgrade\n" +
			"spec:\n  template:\n    spec:\n      containers:\n        - command: [\"node\", \"src/migrate.js\"]\n",
		"k8s/check.yaml": "apiVersion: v1\nkind: Pod\nmetadata:\n  annotations:\n    \"helm.sh/hook\": post-install, test-success\n" +
			"spec:\n  containers:\n    - command: [\"node\", \"src/c.js\"]\n",
	}, covered("src/a.js", "src/b.js", "src/c.js", "src/migrate.js"))

	assertStarted(t, got, startedEntry{File: "src/migrate.js", DeploymentFile: "charts/svc/templates/smoke.yaml", Command: "node src/migrate.js"})
}

// A Dockerfile or Helm values file whose name says it is for development, a
// local run, tests or CI does not deploy the service.
func TestDockerfilesAndValuesFilesForDevelopmentLocalTestsOrCIStartNothing(t *testing.T) {
	got := startedEntries(t, map[string]string{
		"package.json":                 `{"name": "svc"}`,
		"Dockerfile.dev":               "FROM node:22\nCMD [\"node\", \"src/a.js\"]\n",
		"docker/test.Dockerfile":       "FROM node:22\nCMD [\"node\", \"src/b.js\"]\n",
		"docker/Dockerfile.ci":         "FROM node:22\nCMD [\"node\", \"src/c.js\"]\n",
		"docker/Dockerfile.prod":       "FROM node:22\nCMD [\"node\", \"src/prod.js\"]\n",
		"docker/latest.Dockerfile":     "FROM node:22\nCMD [\"node\", \"src/latest.js\"]\n",
		"charts/svc/Chart.yaml":        v2Chart,
		"charts/svc/values-local.yaml": "job:\n  command: [\"node\", \"src/d.js\"]\n",
		"charts/svc/values.test.yaml":  "job:\n  command: [\"node\", \"src/e.js\"]\n",
		"charts/svc/values_DEV.yaml":   "job:\n  command: [\"node\", \"src/f.js\"]\n",
		"charts/svc/values-live.yaml":  "job:\n  command: [\"node\", \"src/live.js\"]\n",
	}, covered("src/a.js", "src/b.js", "src/c.js", "src/d.js", "src/e.js", "src/f.js", "src/prod.js", "src/latest.js", "src/live.js"))

	assertStarted(t, got,
		startedEntry{File: "src/live.js", DeploymentFile: "charts/svc/values-live.yaml", Command: "node src/live.js"},
		startedEntry{File: "src/prod.js", DeploymentFile: "docker/Dockerfile.prod", Command: "node src/prod.js"},
		startedEntry{File: "src/latest.js", DeploymentFile: "docker/latest.Dockerfile", Command: "node src/latest.js"})
}
