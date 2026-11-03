// Seam B for the run of schema.drift (Go: schema_drift_run_test.go): which
// containers start, where and in which order. The containers are stood in
// for and answer like Docker does.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import type { ContainerResult, ContainerSpec } from "../docker/driver.ts";
import { impl, packageContext, tree } from "./checks.testutil.ts";
import { Input, type Result } from "./input.ts";
import { useDriftDocker } from "./schema_drift.ts";
import { assertUnreadable } from "./unreadable_output.testutil.ts";
import {
  ruleDriftChanged,
  ruleDriftCreated,
  ruleDriftFailed,
} from "./schema_drift_results.ts";

/**
 * DriftStub records the containers of a run and answers them: the generator
 * scripts by their file name, the two helper steps with canned output.
 */
interface DriftStub {
  volumes: string[];
  specs: ContainerSpec[];
  exit: Record<string, number>;
  /** manifest is what the manifest step prints, compare what the compare step prints. */
  manifest: string;
  compare: string;
  compareExit: number;
}

function answer(
  exitCode: number,
  stdout: string,
  stderr = "",
): ContainerResult {
  return {
    exitCode,
    oomKilled: false,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    stoppedAfterGrace: false,
  };
}

function stubDriftContainers(t: TestContext, s: DriftStub): void {
  const restore = useDriftDocker({
    createVolume(_signal, _input, suffix) {
      s.volumes.push(suffix);
      return Promise.resolve("jspf-run-" + suffix);
    },
    runContainer(_signal, _input, spec) {
      s.specs.push(spec);
      const cmd = spec.cmd ?? [];
      if (cmd[1] === "/jspf/schema-drift.js" && cmd[2] === "manifest") {
        return Promise.resolve(answer(0, s.manifest));
      }
      if (cmd[1] === "/jspf/schema-drift.js" && cmd[2] === "compare") {
        return Promise.resolve(answer(s.compareExit, s.compare));
      }
      if (cmd[0] === "node") {
        const file = cmd[1] ?? "";
        return Promise.resolve(
          answer(s.exit[file] ?? 0, `out of ${file}\n`, `err of ${file}\n`),
        );
      }
      return Promise.resolve(answer(0, ""));
    },
  });
  t.after(restore);
}

function driftRunInput(t: TestContext, scripts: string): Input {
  const proj = tree(t, {
    "package.json": `{"name":"demo","scripts":{${scripts}}}`,
    "schemas/a.json": '{"a":1}',
  });
  return new Input({
    project: proj,
    context: packageContext(proj, "."),
    snapshotDir: proj.root,
    originalPath: "/original",
    snapshotVolume: "jspf-run-snapshot",
    workVolume: "jspf-run-work",
    network: "jspf-run-net",
  });
}

async function run(input: Input): Promise<Result> {
  const r = await impl("schema.drift").run(new AbortController().signal, input);
  assert.ok(r);
  return r;
}

function stub(fields: Partial<DriftStub> = {}): DriftStub {
  return {
    volumes: [],
    specs: [],
    exit: {},
    manifest: '{"files":{}}',
    compare: '{"changed":[],"created":[]}',
    compareExit: 0,
    ...fields,
  };
}

test("generators run one after another in name order in their own copy on the internal network", async (t) => {
  const s = stub();
  stubDriftContainers(t, s);
  const input = driftRunInput(
    t,
    '"swagger2schema":"node b.js --x","codegen":"API=1 node a.js","gen:schema":"node c.cjs"',
  );

  const res = await run(input);

  assert.equal(res.status, "completed", res.reason);
  const ran: string[] = [];
  for (const spec of s.specs) {
    const cmd = spec.cmd ?? [];
    if (cmd[0] === "node" && !(cmd[1] ?? "").startsWith("/jspf/")) {
      ran.push(cmd.slice(1).join(" "));
      // The Run's internal network.
      assert.equal(spec.network, input.network, cmd.join(" "));
    }
    for (const m of spec.mounts ?? []) {
      if (m.volume === input.workVolume) {
        assert.equal(
          m.readOnly,
          true,
          `${cmd.join(" ")} mounts the shared Working copy writable`,
        );
      }
      if (m.volume === input.snapshotVolume) {
        assert.equal(
          m.readOnly,
          true,
          `${cmd.join(" ")} mounts the Snapshot writable`,
        );
      }
    }
    assert.ok(
      spec.network !== undefined &&
        spec.network !== "" &&
        spec.preparation !== true,
      `${cmd.join(" ")} has outbound access`,
    );
  }
  // Name order: codegen, gen:schema, swagger2schema.
  assert.deepEqual(ran, ["a.js", "c.cjs", "b.js --x"]);
  assert.equal(s.volumes.length, 1, "one copy for the package");
  const a = s.specs.find((x) => x.cmd?.[0] === "node" && x.cmd[1] === "a.js");
  assert.equal(a?.env?.API, "1");
  assert.equal(a.workDir, "/work");
});

test("a failing generator does not stop the others and is reported", async (t) => {
  const s = stub({ exit: { "a.js": 1 } });
  stubDriftContainers(t, s);

  const res = await run(
    driftRunInput(t, '"gen:a":"node a.js","gen:b":"node b.js"'),
  );

  assert.deepEqual(
    [res.status, res.reasonCode],
    ["partial", "generator_failed"],
  );
  const ran = s.specs.filter(
    (x) =>
      x.cmd?.[0] === "node" && (x.cmd[1] === "a.js" || x.cmd[1] === "b.js"),
  );
  assert.equal(ran.length, 2);
  const failed = (res.findings ?? []).filter(
    (f) => f.rule_id === ruleDriftFailed,
  );
  assert.equal(failed.length, 1);
  const text = failed[0]?.evidence[0]?.text ?? "";
  assert.ok(text.includes("out of a.js") && text.includes("err of a.js"), text);
});

test("the compare result of the copy becomes Findings", async (t) => {
  const content = Buffer.from('{"a":2}').toString("base64");
  stubDriftContainers(
    t,
    stub({
      compare: `{"changed":[{"path":"schemas/a.json","size":7,"content":"${content}"}],"created":[{"path":"schemas/new.json","size":3}]}`,
    }),
  );

  const res = await run(driftRunInput(t, '"gen:schema":"node gen.js"'));

  assert.equal(res.status, "completed");
  const rules = (res.findings ?? []).map((f) => f.rule_id);
  assert.deepEqual(rules.sort(), [ruleDriftChanged, ruleDriftCreated].sort());
  assert.deepEqual(res.command, ["node", "gen.js"]);
});

// An answer of the helper that is not its document says nothing about the
// generators' work: a tool problem with the raw output kept, and never a
// changed or created file.
const compareGood = '{"changed":[],"created":[]}';
const compareBad: Record<string, string> = {
  "a changed JSON shape": '{"modified":[{"path":"schemas/a.json"}]}',
  "files of another type": '{"changed":{"schemas/a.json":1},"created":[]}',
  "files with other keys":
    '{"changed":[{"file":"schemas/a.json","bytes":7}],"created":[]}',
  "truncated output": compareGood.slice(0, 15),
  "plain text": "not json",
};
for (const [what, out] of Object.entries(compareBad)) {
  test(`schema.drift: ${what} from the compare step is a tool problem with the raw output kept`, async (t) => {
    stubDriftContainers(t, stub({ compare: out }));

    const res = await run(driftRunInput(t, '"gen:schema":"node gen.js"'));

    assertUnreadable(res, {
      status: "tool_error",
      check: "schema.drift",
      context: "C-0002",
      call: "compare",
      stdout: out,
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

const manifestBad: Record<string, string> = {
  "a changed JSON shape": '{"hashes":{"schemas/a.json":"abc"}}',
  "files of another type": '{"files":["schemas/a.json"]}',
  "plain text": "usage: schema-drift.js manifest <root>",
};
for (const [what, out] of Object.entries(manifestBad)) {
  test(`schema.drift: ${what} from the manifest step is a tool problem with the raw output kept`, async (t) => {
    const s = stub({ manifest: out });
    stubDriftContainers(t, s);

    const res = await run(driftRunInput(t, '"gen:schema":"node gen.js"'));

    assertUnreadable(res, {
      status: "tool_error",
      check: "schema.drift",
      context: "C-0002",
      call: "manifest",
      stdout: out,
    });
    assert.deepEqual(res.findings ?? [], []);
    assert.ok(
      !s.specs.some((x) => x.cmd?.[0] === "node" && x.cmd[1] === "gen.js"),
      "no generator ran after the manifest was unreadable",
    );
  });
}

test("a compare step that exits with an error stays a helper failure", async (t) => {
  stubDriftContainers(t, stub({ compareExit: 1 }));

  const res = await run(driftRunInput(t, '"gen:schema":"node gen.js"'));

  assert.deepEqual(
    [res.status, res.reasonCode],
    ["tool_error", "helper_failed"],
  );
});
