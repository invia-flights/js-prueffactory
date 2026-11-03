// schema.drift runs the generator scripts of a package, in a separate copy of
// the package's installed Working copy and on the Run's internal network,
// and reports the committed files whose content the generators change (Go:
// schema_drift.go).
//
// A generator script is a script of the package.json whose name points to
// generation and whose command is a plain `node <file>` call (see
// discovery's generatorScripts). Nothing else of the project's scripts runs,
// and no shell does.
import { readFileSync } from "node:fs";

import type { ContainerResult, ContainerSpec, File } from "../docker/driver.ts";
import { NetworkNone } from "../docker/driver.ts";
import { toLower } from "../gocompat/strings.ts";
import { type GoSlice, type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import {
  Applicable,
  NotApplicable,
  StatusUnsupported,
} from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { failedToRun, helperFailed } from "./helper_result.ts";
import type { Input, Result } from "./input.ts";
import {
  nodeImages,
  packageInstallID,
  unsupportedInstallReason,
  workMount,
  workPath,
} from "./package_install.ts";
import {
  type DriftCompareOutput,
  type DriftFailure,
  type DriftFile,
  driftResult,
  schemaDriftID,
} from "./schema_drift_results.ts";

export { schemaDriftID } from "./schema_drift_results.ts";

export const schemaDrift: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "schema.drift examines packages, and this is the project Context",
      ];
    }
    if (c.package.generatorScripts.length === 0) {
      return [
        NotApplicable,
        "no_generator_script: the package has no script with a generator-like name that is a plain `node <file>` call",
      ];
    }
    return [Applicable, unsupportedInstallReason(c)];
  },

  /** prerequisites asks for the install: the generators run on its result. */
  prerequisites() {
    return [packageInstallID];
  },

  usesWorkingCopy() {
    return true;
  },

  images(c) {
    if (c.package === null || c.package.generatorScripts.length === 0) {
      return [];
    }
    return nodeImages(c);
  },

  run: runSchemaDrift,
};

register(schemaDriftID, schemaDrift);

/**
 * DriftDocker holds the Docker calls of the run, so that tests can stand in
 * for the containers.
 */
export interface DriftDocker {
  createVolume(
    signal: AbortSignal,
    input: Input,
    suffix: string,
  ): Promise<string>;
  runContainer(
    signal: AbortSignal,
    input: Input,
    spec: ContainerSpec,
  ): Promise<ContainerResult>;
}

function driverOf(input: Input) {
  if (input.docker === null) {
    // Go dereferenced the nil driver here and panicked.
    throw new Error("no Docker driver is configured");
  }
  return input.docker;
}

const realDriftDocker: DriftDocker = {
  createVolume: (signal, input, suffix) =>
    driverOf(input).createVolume(signal, suffix),
  runContainer: (signal, input, spec) =>
    driverOf(input).runContainer(signal, spec),
};

let driftDocker: DriftDocker = realDriftDocker;

/** useDriftDocker replaces the Docker calls of the run and returns the restore function. */
export function useDriftDocker(d: DriftDocker): () => void {
  driftDocker = d;
  return () => {
    driftDocker = realDriftDocker;
  };
}

const schemaDriftHelper = readFileSync(
  new URL("js/schema-drift.js", import.meta.url),
);

/**
 * driftCopyMount is where the generators' own copy of the Working copy is
 * mounted. It is the same place as the Working copy's, so that paths in a
 * generator's output read like the ones of the install.
 */
const driftCopyMount = workMount;
const driftHelper = "/jspf/schema-drift.js";

const str: Schema = { kind: "string" };
const driftFileType = "checks.driftFile";
const driftFileSchema: Schema = {
  kind: "slice",
  type: "[]" + driftFileType,
  elem: {
    kind: "struct",
    type: driftFileType,
    fields: [
      { name: "path", schema: str },
      { name: "size", schema: { kind: "int" } },
      { name: "content", schema: str },
      { name: "too_large", schema: { kind: "bool" } },
    ],
  },
};
const compareSchema: Schema = {
  kind: "struct",
  type: "checks.driftCompareOutput",
  fields: [
    { name: "changed", schema: driftFileSchema },
    { name: "created", schema: driftFileSchema },
  ],
};

/** parseCompare decodes the compare helper's answer; it throws for anything else. */
function parseCompare(stdout: Uint8Array): DriftCompareOutput {
  const out = unmarshal(stdout, compareSchema) as {
    changed: GoSlice | null;
    created: GoSlice | null;
  };
  return {
    changed: (out.changed?.items() ?? []) as DriftFile[],
    created: (out.created?.items() ?? []) as DriftFile[],
  };
}

/**
 * runSchemaDrift copies the package's installed Working copy, runs the
 * generator scripts in the copy on the Run's internal network, and compares
 * what they left with the Snapshot. The generators are project code, so they
 * get what every container of the Execution phase gets and nothing more: no
 * network beyond the Run's own, the container limits of every container,
 * and a volume that belongs to this Check only. The Check's time limit bounds
 * all of them together, and a script that outlives it ends the execution as
 * timed out.
 */
async function runSchemaDrift(
  signal: AbortSignal,
  input: Input,
): Promise<Result> {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("schema.drift runs in a package Context");
  }
  const u = pkg.installUnsupported;
  if (u !== null) {
    return { status: StatusUnsupported, reasonCode: u.code, reason: u.reason };
  }
  const scripts = pkg.generatorScripts;
  const first = scripts[0];
  if (first === undefined || input.context.node === null) {
    throw new Error("schema.drift runs in a package with generator scripts");
  }
  const res: Result = {
    status: StatusUnsupported,
    command: ["node", first.file, ...first.args],
  };
  const image = input.context.node.image;
  const suffix = toLower(input.context.id);
  const helper: File = {
    path: driftHelper,
    mode: 0o644,
    content: schemaDriftHelper,
  };

  let copyVolume: string;
  try {
    copyVolume = await driftDocker.createVolume(
      signal,
      input,
      "drift-" + suffix,
    );
  } catch (err) {
    return failedToRun(res, err);
  }

  const run = async (spec: ContainerSpec): Promise<ContainerResult> =>
    driftDocker.runContainer(signal, input, spec);

  let c: ContainerResult;
  try {
    // The copy: everything of the Working copy, installed dependencies included.
    c = await run({
      name: "driftcopy-" + suffix,
      image,
      network: NetworkNone,
      cmd: ["cp", "-a", "/shared/.", driftCopyMount + "/"],
      mounts: [
        { volume: input.workVolume, path: "/shared", readOnly: true },
        { volume: copyVolume, path: driftCopyMount },
      ],
    });
  } catch (err) {
    return failedToRun(res, err);
  }
  if (c.exitCode !== 0) {
    return helperFailed(res, "working copy", c, 400);
  }

  // What the copy holds before the generators run, so that a file the
  // install or another Check changed is not taken for the generators' work.
  let before: ContainerResult;
  try {
    before = await run({
      name: "driftbefore-" + suffix,
      image,
      network: NetworkNone,
      cmd: ["node", driftHelper, "manifest", driftCopyMount],
      files: [helper],
      mounts: [{ volume: copyVolume, path: driftCopyMount, readOnly: true }],
      workDir: "/",
    });
  } catch (err) {
    return failedToRun(res, err);
  }
  if (before.exitCode !== 0) {
    return helperFailed(res, "schema drift", before, 400);
  }

  const failures: DriftFailure[] = [];
  for (const [i, s] of scripts.entries()) {
    let g: ContainerResult;
    try {
      g = await run({
        name: `drift-${suffix}-${String(i + 1)}`,
        image,
        cmd: ["node", s.file, ...s.args],
        ...(s.env.size > 0 ? { env: Object.fromEntries(s.env) } : {}),
        workDir: workPath(pkg),
        // The Run's internal network, like every container of the Execution
        // phase: a generator that needs the internet fails and is
        // reported, and never reaches it.
        network: input.network,
        mounts: [{ volume: copyVolume, path: driftCopyMount }],
      });
    } catch (err) {
      return failedToRun(res, err);
    }
    if (g.exitCode !== 0 || g.oomKilled) {
      failures.push({
        script: s,
        exitCode: g.exitCode,
        oom: g.oomKilled,
        output: Buffer.concat([g.stdout, g.stderr]),
      });
    }
  }

  let after: ContainerResult;
  try {
    after = await run({
      name: "driftcompare-" + suffix,
      image,
      network: NetworkNone,
      cmd: [
        "node",
        driftHelper,
        "compare",
        driftCopyMount,
        "/snapshot",
        "/jspf/before.json",
      ],
      files: [
        helper,
        { path: "/jspf/before.json", mode: 0o644, content: before.stdout },
      ],
      mounts: [
        { volume: copyVolume, path: driftCopyMount, readOnly: true },
        { volume: input.snapshotVolume, path: "/snapshot", readOnly: true },
      ],
      workDir: "/",
    });
  } catch (err) {
    return failedToRun(res, err);
  }
  let out: DriftCompareOutput;
  try {
    if (after.exitCode !== 0) {
      throw new Error("exit");
    }
    out = parseCompare(after.stdout);
  } catch {
    return helperFailed(res, "schema drift", after, 400);
  }

  const done = driftResult(input, scripts, failures, out);
  if (res.command) done.command = res.command;
  return done;
}
