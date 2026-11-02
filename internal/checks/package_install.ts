// package.install (Go: package_install.go).
import type { Context, Package } from "../discovery/discovery.ts";
import { type ContainerResult, NetworkNone } from "../docker/driver.ts";
import { join } from "../gocompat/path.ts";
import { toLower, trimSpace } from "../gocompat/strings.ts";
import { goString } from "../gocompat/utf8.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  Applicable,
  type Artifact,
  ConfidenceConfirmed,
  type Finding,
  KindDefect,
  NotApplicable,
  SeverityError,
  StatusCompleted,
  StatusToolError,
  StatusUnsupported,
} from "../resultset/types.ts";
import { newArtifact, newFinding } from "../resultset/zero.ts";
import { type Check, register } from "./check.ts";
import { tail } from "./cut_text.ts";
import { failedToRun } from "./helper_result.ts";
import { type Input, type Result, untrusted } from "./input.ts";
import {
  classifyInstall,
  detailLines,
  type InstallVerdict,
  orUnknown,
} from "./package_install_npm.ts";
import {
  addTestFileProbe,
  hasTestFileProbe,
  unprobedSuiteLimitations,
} from "./test_files_probe.ts";

export const packageInstallID = "package.install";

// Where things are mounted in the install container, and the name of the
// cache volume that keeps npm's downloads between Runs.
export const workMount = "/work";
const npmCacheMount = "/npm-cache";
const npmCacheKind = "npm";
/**
 * maxInstallLog is the most of the npm log that goes into the Report. A
 * longer log keeps its end, where the error is.
 */
const maxInstallLog = 4 << 20;

/**
 * packageInstall installs a package's dependencies the way CI would, in a
 * container of the package's Context on Docker's default bridge network,
 * into the Working copy of the Run. It uses the project's own .npmrc, npm's
 * download cache volume and no host environment variables.
 *
 * The command is `npm ci --no-audit --no-fund`, or `npm install --no-audit
 * --no-fund` for a package without a lockfile, whose resulting lockfile
 * becomes an artifact. How npm's answer maps to a status and a fault is in
 * classifyInstall. Checks that need the installed dependencies list this one
 * as a prerequisite.
 */
export const packageInstall: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "package.install examines packages, and this is the project Context",
      ];
    }
    return [Applicable, unsupportedInstallReason(c)];
  },

  usesWorkingCopy() {
    return true;
  },

  images(c) {
    return nodeImages(c);
  },

  /**
   * run installs the dependencies and then probes the package's test suites
   * for the files their runners load, because the Checks that read File
   * classes wait for the end of this Check and nothing else can answer
   * before the install.
   */
  async run(signal, input) {
    const res = await install(signal, input);
    if (hasTestFileProbe(input.context)) {
      await addTestFileProbe(input, signal, res);
    } else if (input.context.package !== null) {
      const l = unprobedSuiteLimitations(input);
      if (l.length > 0) {
        (res.limitations ??= []).push(...l);
      }
    }
    return res;
  },
};

register(packageInstallID, packageInstall);

/**
 * unsupportedInstallReason explains why a package cannot be installed, for
 * list-checks, or is empty when it can. A package whose install is
 * unsupported is unsupported for everything that needs the installed
 * dependencies.
 */
export function unsupportedInstallReason(c: Context): string {
  if (c.package?.installUnsupported == null) {
    return "";
  }
  return "unsupported: " + c.package.installUnsupported.reason;
}

/**
 * nodeImages is the images answer of Checks that run npm in the package's
 * image: none for a package that cannot be installed.
 */
export function nodeImages(c: Context): string[] {
  if (
    c.package === null ||
    c.node === null ||
    c.package.installUnsupported != null
  ) {
    return [];
  }
  return [c.node.image];
}

/** workPath is the folder of a package in the Working copy. */
export function workPath(pkg: Package): string {
  return pkg.path === "." ? workMount : workMount + "/" + pkg.path;
}

/**
 * npmEnv is the only environment of an npm container. Nothing of the host's
 * environment gets in. The log is written at level http so that what the
 * install fetched is recorded.
 */
export function npmEnv(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    npm_config_update_notifier: "false",
    npm_config_progress: "false",
    npm_config_loglevel: "http",
    ...extra,
  };
}

/**
 * producedLockfileKey is where package.install leaves the lockfile it
 * produced for a package without one, for security.dependencies (Go: in
 * security_dependencies.go).
 */
export function producedLockfileKey(contextID: string): string {
  return "npm-lockfile/" + contextID;
}

async function install(signal: AbortSignal, input: Input): Promise<Result> {
  const pkg = input.context.package;
  const u = pkg?.installUnsupported;
  if (u != null) {
    return { status: StatusUnsupported, reasonCode: u.code, reason: u.reason };
  }
  const node = input.context.node;
  if (pkg === null || node === null) {
    return {
      status: StatusUnsupported,
      reason: "the package has no Node runtime to install with",
    };
  }
  const res: Result = { status: StatusCompleted };
  const drv = input.docker;
  if (drv === null) {
    return failedToRun(res, new Error("no Docker driver is configured"));
  }
  const image = node.image;
  const suffix = toLower(input.context.id);

  let cache: string;
  let v: ContainerResult;
  try {
    cache = await drv.cacheVolume(signal, npmCacheKind);
    // The npm bundled with the image, never npm@latest. Its version goes
    // into the Context.
    v = await drv.runContainer(signal, {
      name: "npmversion-" + suffix,
      image,
      cmd: ["npm", "--version"],
      env: npmEnv(),
      network: NetworkNone,
    });
  } catch (err) {
    return failedToRun(res, err);
  }
  const npmVersion = trimSpace(goString(v.stdout));
  if (v.exitCode !== 0 || npmVersion === "") {
    res.status = StatusToolError;
    res.reasonCode = "npm_missing";
    res.reason = `\`npm --version\` exited with ${String(v.exitCode)} in the Node image: ${tail(goString(v.stderr), 400)}`;
    return res;
  }
  res.npmVersion = npmVersion;

  const cmd = ["npm", "ci", "--no-audit", "--no-fund"];
  if (pkg.npmLockfile === "") {
    cmd[1] = "install";
  }
  res.command = cmd;
  let c: ContainerResult;
  try {
    c = await drv.runContainer(signal, {
      name: "install-" + suffix,
      image,
      cmd,
      env: npmEnv({ npm_config_cache: npmCacheMount }),
      workDir: workPath(pkg),
      // The install runs on Docker's default bridge, with outbound access,
      // as ADR-0004 allows in the Preparation phase.
      preparation: true,
      mounts: [
        { volume: input.workVolume, path: workMount },
        { volume: cache, path: npmCacheMount },
      ],
    });
  } catch (err) {
    return failedToRun(res, err);
  }
  res.tool = { name: "npm", version: npmVersion, exit_code: c.exitCode };
  res.artifacts = [installLogArtifact(input.context.id, cmd, c)];

  const verdict = classifyInstall(
    c.exitCode,
    c.oomKilled,
    goString(c.stderr) + "\n" + goString(c.stdout),
  );
  res.status = verdict.status;
  res.reasonCode = verdict.reasonCode;
  res.reason = verdict.reason;
  if (verdict.projectFault) {
    res.findings = [installFinding(input, verdict, cmd)];
    res.reasonCode = "";
    res.reason = "";
    return res;
  }
  if (verdict.status !== StatusCompleted || pkg.npmLockfile !== "") {
    return res;
  }

  // npm install wrote a lockfile into the Working copy. It is an artifact,
  // so the attempt can be reproduced, and later Checks can read it.
  let lock: ContainerResult;
  try {
    lock = await drv.runContainer(signal, {
      name: "lockfile-" + suffix,
      image,
      cmd: ["cat", workPath(pkg) + "/package-lock.json"],
      mounts: [{ volume: input.workVolume, path: workMount, readOnly: true }],
      network: NetworkNone,
    });
  } catch (err) {
    return failedToRun(res, err);
  }
  if (lock.exitCode !== 0) {
    res.limitations = [
      {
        reason_code: "lockfile_not_produced",
        message:
          "npm install did not write a package-lock.json, for example because the project's .npmrc sets package-lock=false",
        check_id: packageInstallID,
        path: join(pkg.path, "package.json"),
      },
    ];
    return res;
  }
  // security.dependencies scans this lockfile.
  input.shared?.put(producedLockfileKey(input.context.id), lock.stdout);
  res.artifacts.push(
    newArtifact({
      path: join(
        "artifacts",
        packageInstallID,
        input.context.id,
        "package-lock.json",
      ),
      media_type: "application/json",
      content: lock.stdout,
    }),
  );
  return res;
}

/**
 * installLogArtifact is the npm log of an install: the command, its exit
 * code and what it wrote to its two output streams.
 */
function installLogArtifact(
  contextID: string,
  cmd: readonly string[],
  c: ContainerResult,
): Artifact {
  return commandLogArtifact(
    join("artifacts", packageInstallID, contextID, "npm-install.log"),
    cmd,
    c,
  );
}

/**
 * commandLogArtifact is the log of a container's command at the given path
 * in the report folder. A log over maxInstallLog keeps its end, where the
 * error is. The output streams go in as bytes, as Go wrote them.
 */
export function commandLogArtifact(
  artifactPath: string,
  cmd: readonly string[],
  c: ContainerResult,
): Artifact {
  let content: Buffer = Buffer.concat([
    Buffer.from(
      `$ ${cmd.join(" ")}\nexit code: ${String(c.exitCode)}\n\n--- stderr ---\n`,
    ),
    c.stderr,
    Buffer.from("\n--- stdout ---\n"),
    c.stdout,
  ]);
  let truncated = false;
  if (content.length > maxInstallLog) {
    content = Buffer.concat([
      Buffer.from("[the start of this log was cut; the last 4 MiB follow]\n"),
      content.subarray(content.length - maxInstallLog),
    ]);
    truncated = true;
  }
  return newArtifact({
    path: artifactPath,
    media_type: "text/plain; charset=utf-8",
    content,
    truncated,
  });
}

/**
 * installFinding is the Gate Finding of an install that failed for a reason
 * in the project's files.
 */
function installFinding(
  input: Input,
  v: InstallVerdict,
  cmd: readonly string[],
): Finding {
  const pkg = input.context.package;
  const manifest = join(pkg?.path ?? ".", "package.json");
  const detail = detailLines(v.evidence, 4);
  return newFinding({
    check_id: packageInstallID,
    context_id: input.context.id,
    rule_id: v.rule,
    fingerprint: newFingerprint(
      packageInstallID,
      v.rule,
      manifest,
      v.npmCode + " " + detail,
    ),
    kind: KindDefect,
    severity: SeverityError,
    confidence: ConfidenceConfirmed,
    gate: true,
    title: v.title,
    message: `\`${cmd.join(" ")}\` failed with the npm error ${orUnknown(v.npmCode)}: ${detail}`,
    locations: [input.location("primary", manifest, 0, 0)],
    evidence: [untrusted("tool_output", v.evidence, "npm")],
    reproduction: input.reproduction(packageInstallID),
    limitations: [],
  });
}
