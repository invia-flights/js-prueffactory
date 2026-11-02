// Helpers of the Docker tests: a Driver on the real daemon whose Run ID no
// other test, process or Run shares, so tests that run in parallel against one
// daemon never see or remove each other's resources.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";

import { DefaultNodeMajor, nodeImage, VariantDebian } from "../toolset/node.ts";
import { imageRef } from "../toolset/toolset.ts";
import { Driver, env, locate, rfc3339 } from "./driver.ts";

const getenv = (k: string): string => process.env[k] ?? "";

// uniqueRunID returns a run ID nothing else shares. The tag only makes
// leftovers recognisable.
export function uniqueRunID(tag: string): string {
  const stamp = rfc3339(new Date()).replace(/[-:]/g, "");
  return `${stamp}-${tag}-${randomBytes(6).toString("hex")}`;
}

// docker runs the real CLI with an argument array and returns its status and
// output.
export function docker(...args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export const nodeRef = (): string => {
  const img = nodeImage(DefaultNodeMajor, VariantDebian);
  if (img === undefined) {
    throw new Error("no Node image");
  }
  return imageRef(img);
};

// realDriver returns a Driver with a unique Run ID and the pinned Node image,
// pulled. When the test ends, the Run's resources are removed and the test
// fails if any is left.
export async function realDriver(
  t: TestContext,
  tag: string,
): Promise<{ d: Driver; image: string; runID: string }> {
  const runID = uniqueRunID(tag);
  const base = new Driver(locate(getenv), env(getenv));
  const signal = new AbortController().signal;
  await base.preflight(signal);
  const d = base.withScope({
    runID,
    host: "test-host",
    pid: process.pid,
    deadline: new Date(Date.now() + 3_600_000),
  });
  t.after(async () => {
    await d.removeRunResources();
    assertGone(runID);
  });
  const image = nodeRef();
  await base.pull(signal, image);
  return { d, image, runID };
}

// assertGone fails when a container, network or volume of the Run is left.
export function assertGone(runID: string): void {
  for (const kind of [
    ["ps", "-a"],
    ["network", "ls"],
    ["volume", "ls"],
  ]) {
    const r = docker(
      ...kind,
      "--filter",
      "label=js-prueffactory.run-id=" + runID,
      "-q",
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout.trim(),
      "",
      `docker ${kind.join(" ")} still lists ${r.stdout}`,
    );
  }
}

export const never = new AbortController().signal;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
