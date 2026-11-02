import assert from "node:assert/strict";
import { test } from "node:test";

import { tree } from "./checks.testutil.ts";
import { composeSets } from "./compose_sets.ts";

test("a default set is the base file with its matching override, every other file a set of its own", (t) => {
  const proj = tree(t, {
    "compose.yaml": "services: {}\n",
    "compose.override.yaml": "services: {}\n",
    "compose.prod.yaml": "services: {}\n",
    "docker-compose.yml": "services: {}\n",
    "docker-compose.override.yml": "services: {}\n",
    "docker-compose.ci.yml": "services: {}\n",
    // The second override of that base is a set of its own.
    "docker-compose.override.yaml": "services: {}\n",
    // Not in the project root, so not discovered.
    "deploy/compose.yaml": "services: {}\n",
    "compose.txt": "not a compose file\n",
    "my-compose.yaml": "not discovered either\n",
  });
  assert.deepEqual(
    composeSets(proj).map((s) => s.files),
    [
      ["compose.prod.yaml"],
      ["compose.yaml", "compose.override.yaml"],
      ["docker-compose.ci.yml"],
      ["docker-compose.override.yaml"],
      ["docker-compose.yml", "docker-compose.override.yml"],
    ],
  );
});

test("an override matches its base file in either YAML spelling", (t) => {
  const proj = tree(t, {
    "compose.yml": "services: {}\n",
    "compose.override.yaml": "services: {}\n",
  });
  assert.deepEqual(
    composeSets(proj).map((s) => s.files),
    [["compose.yml", "compose.override.yaml"]],
  );
});

test("an override without a base file is a set of its own", (t) => {
  const proj = tree(t, { "compose.override.yaml": "services: {}\n" });
  assert.deepEqual(
    composeSets(proj).map((s) => s.files),
    [["compose.override.yaml"]],
  );
});

test("a project without compose files has no sets", (t) => {
  const proj = tree(t, {
    "package.json": "{}\n",
    "deploy/compose.yaml": "services: {}\n",
  });
  assert.deepEqual(composeSets(proj), []);
});
