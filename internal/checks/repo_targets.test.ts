import assert from "node:assert/strict";
import { test } from "node:test";

import { tree } from "./checks.testutil.ts";
import {
  dockerfileTargets,
  openAPITargets,
  shellTargets,
} from "./repo_targets.ts";

test("Dockerfile targets are the three naming forms outside Test data", (t) => {
  const proj = tree(t, {
    Dockerfile: "FROM scratch\n",
    "docker/Dockerfile.prod": "FROM scratch\n",
    "docker/app.Dockerfile": "FROM scratch\n",
    "docker/dockerfile": "FROM scratch\n", // wrong case
    "docker/Dockerfile-notes.txt": "not one\n",
    "docker/MyDockerfile": "not one\n",
    "test/fixtures/Dockerfile": "FROM scratch\n", // Test data
    "weird [1] {a,b}*/Dockerfile": "FROM scratch\n", // glob characters stay literal
    "node_modules/dep/Dockerfile": "FROM scratch\n",
  });
  assert.deepEqual(dockerfileTargets(proj), [
    "Dockerfile",
    "docker/Dockerfile.prod",
    "docker/app.Dockerfile",
    "weird [1] {a,b}*/Dockerfile",
  ]);
});

test("shell targets come from the extension or the shebang and get a dialect", (t) => {
  const proj = tree(t, {
    "a.sh": "echo hi\n",
    "b.bash": "echo hi\n",
    "bin/run": "#!/usr/bin/env bash\necho hi\n",
    "bin/start": "#!/bin/sh\necho hi\n",
    "bin/envs": "#!/usr/bin/env -S bash -e\necho hi\n",
    "bin/node-cli": "#!/usr/bin/env node\nconsole.log(1)\n",
    "bin/py": "#!/usr/bin/python\n",
    "c.txt": "#!/bin/bash\n", // the shebang alone makes it a script
    "shebang-wins.sh": "#!/bin/bash\necho hi\n",
    "dash.sh": "#!/bin/dash\necho hi\n",
    "notes.md": "# hello\n",
    "test/fixtures/x.sh": "echo hi\n", // Test data
    "node_modules/d/x.sh": "echo hi\n",
    empty: "",
    // Go's strings.Fields splits at U+0085 and at tabs too.
    "bin/nel": "#!/usr/bin/env\u0085bash\n",
    "bin/tab": "#!/usr/bin/env\tsh\n",
  });
  const got = Object.fromEntries(
    shellTargets(proj).map((s) => [s.path, s.dialect]),
  );
  assert.deepEqual(got, {
    "a.sh": "sh",
    "b.bash": "bash",
    "bin/run": "bash",
    "bin/start": "sh",
    "bin/envs": "bash",
    "c.txt": "bash",
    "shebang-wins.sh": "bash",
    "dash.sh": "dash",
    "bin/nel": "bash",
    "bin/tab": "sh",
  });
});

test("OpenAPI targets need a top-level openapi or swagger key", (t) => {
  const proj = tree(t, {
    "api/openapi.yaml": "openapi: 3.0.3\ninfo:\n  title: x\n",
    "api/old.yml": "swagger: '2.0'\n",
    "api/spec.json": '{"openapi": "3.1.0", "info": {}}',
    "api/swagger.json": '{"swagger": "2.0"}',
    "api/quoted.yaml": '"openapi": 3.0.0\n',
    "api/nested.yaml": "servers:\n  openapi: 3.0.0\n", // not top level
    "api/other.json": '{"info": {"openapi": "3.0.0"}}', // not top level
    "api/comment.yaml": "# openapi: 3.0.0\nfoo: bar\n", // comment
    "api/notes.txt": "openapi: 3.0.0\n", // not YAML or JSON
    "api/broken.json": '{"openapi": ', // does not parse
    "test/fixtures/api.yml": "openapi: 3.0.0\n", // Test data
    "weird [x]/api.yaml": "openapi: 3.0.0\n",
    "remote.yaml":
      "openapi: 3.0.0\npaths:\n  /a:\n    $ref: 'https://example.com/a.yaml'\n",
    "local.yaml": "openapi: 3.0.0\npaths:\n  /a:\n    $ref: './a.yaml'\n",
    "remote.json":
      '{"openapi":"3.0.0","paths":{"/a":{"$ref":"http://example.com/a.json"}}}',
    // Go's (?m)^ starts a line only after "\n", and its \s has no \v.
    "cr.yaml": "x: 1\ropenapi: 3.0.0\n",
    "vt.yaml": "openapi: 3\npaths:\n  $ref:\v'https://example.com/a.yaml'\n",
    "nel.yaml":
      "openapi: 3\npaths:\n  $ref:\u0085'https://example.com/a.yaml'\n",
  });
  const got = Object.fromEntries(
    openAPITargets(proj).map((a) => [a.path, a.remoteRef]),
  );
  assert.deepEqual(got, {
    "api/openapi.yaml": false,
    "api/old.yml": false,
    "api/spec.json": false,
    "api/swagger.json": false,
    "api/quoted.yaml": false,
    "weird [x]/api.yaml": false,
    "remote.yaml": true,
    "local.yaml": false,
    "remote.json": true,
    "vt.yaml": false,
    "nel.yaml": false,
  });
});
