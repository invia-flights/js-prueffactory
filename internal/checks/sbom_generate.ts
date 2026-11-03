// sbom.generate (Go: sbom_generate.go).
import { join } from "../gocompat/path.ts";
import { compareBytes, toLower } from "../gocompat/strings.ts";
import * as json from "../gocompat/unmarshal.ts";
import { goString } from "../gocompat/utf8.ts";
import type { Lock } from "../lockfile/lockfile.ts";
import { quote } from "../resultset/quote.ts";
import {
  type Limitation,
  NotApplicable,
  StatusCompleted,
  StatusInfrastructureError,
  StatusToolError,
  StatusUnsupported,
} from "../resultset/types.ts";
import { newArtifact, newLimitation } from "../resultset/zero.ts";
import { type Check, register } from "./check.ts";
import { tail } from "./cut_text.ts";
import { packageFolder } from "./eslint_run.ts";
import { failedToRun } from "./helper_result.ts";
import type { Result } from "./input.ts";
import { npmEnv } from "./package_install.ts";
import { maxProjectFileBytes, readCapped } from "./readcap.ts";
import {
  metric,
  registryDataApplicability,
  registryDataImages,
  registryDataPrerequisites,
  unknownList,
} from "./registry_fetch.ts";
import { dependencyLockfile } from "./security_dependencies.ts";
import { packageName } from "./security_dependencies_osv.ts";
import { oneLine } from "./test_report.ts";
import { UnreadableOutput, unreadableResult } from "./tool_output.ts";

export const sbomGenerateID = "sbom.generate";

/** sbomMediaType is the media type of a CycloneDX document in JSON. */
const sbomMediaType = "application/vnd.cyclonedx+json";

// The SBOM container sees the package's manifest and lockfile here, and
// nothing else of the project.
const sbomDir = "/sbom";
const sbomManifest = sbomDir + "/package.json";
const sbomLockfile = sbomDir + "/package-lock.json";

/**
 * sbomArgs is the command line after npm. --package-lock-only makes npm read
 * the lockfile and look at no installed tree, so the SBOM describes what is
 * locked, whether or not an install happened.
 */
const sbomArgs = ["sbom", "--sbom-format", "cyclonedx", "--package-lock-only"];

/**
 * sbomGenerate writes a CycloneDX SBOM of a package as an artifact, with the
 * `npm sbom` of the package's own Node image. It reads the package's
 * lockfile, or for a package without one the lockfile its install produced,
 * which is why the Check then lists package.install as a prerequisite.
 *
 * It is an observation: no Findings, no Gates, no part of the score and no
 * side indicator. Lockfile entries that lack `resolved` or `integrity` give
 * the SBOM components without a download location or hash, and are listed
 * as a Limitation.
 */
export const sbomGenerate: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        sbomGenerateID +
          " describes the dependencies of a package, and this is the project Context",
      ];
    }
    // The same preconditions as the registry-data step: a Node version the
    // tool runs, and a lockfile or an install that can produce one.
    return registryDataApplicability(sbomGenerateID, c);
  },

  /** prerequisites asks for the install only when the package has no lockfile. */
  prerequisites(c) {
    return registryDataPrerequisites(c);
  },

  /** images tells the engine which image run will use. */
  images(c) {
    return registryDataImages(c);
  },

  async run(signal, input) {
    const pkg = input.context.package;
    const command = ["npm", ...sbomArgs];
    const res: Result = { status: StatusCompleted, command };
    if (pkg === null) {
      throw new Error("sbom.generate needs a package Context");
    }
    const u = pkg.nodeChoice.unsupported;
    if (u !== null) {
      res.status = StatusUnsupported;
      res.reasonCode = u.code;
      res.reason = u.reason;
      return res;
    }
    const [src, unsupported] = dependencyLockfile(input);
    if (src === null) {
      return unsupported;
    }
    const node = input.context.node;
    const drv = input.docker;
    if (node === null || drv === null) {
      res.status = StatusInfrastructureError;
      res.reasonCode = "docker_setup_failed";
      res.reason = "the SBOM step has no Node image to run in";
      return res;
    }

    // npm names the root component after the folder it runs in and reads
    // its metadata from package.json. A package.json that cannot be read
    // gives an SBOM of the lockfile alone.
    let manifest: Uint8Array = Buffer.from("{}");
    try {
      manifest = readCapped(
        join(packageFolder(input), "package.json"),
        maxProjectFileBytes,
      );
    } catch {
      // keep "{}"
    }
    let c;
    try {
      c = await drv.runContainer(signal, {
        name: "sbom-" + toLower(input.context.id),
        image: node.image,
        cmd: command,
        env: npmEnv(),
        workDir: sbomDir,
        network: input.network,
        files: [
          { path: sbomManifest, mode: 0o644, content: manifest },
          { path: sbomLockfile, mode: 0o644, content: src.raw },
        ],
      });
    } catch (err) {
      return failedToRun(res, err);
    }
    res.tool = {
      name: "npm sbom",
      version: input.context.npm_version,
      exit_code: c.exitCode,
    };
    if (c.exitCode !== 0 || c.oomKilled) {
      res.status = StatusToolError;
      res.reasonCode = "npm_sbom_failed";
      res.reason = `\`npm sbom\` exited with ${String(c.exitCode)}: ${quote(oneLine(tail(goString(c.stderr), 400), 400))}`;
      if (c.oomKilled) {
        res.reason = "`npm sbom` ran out of memory: " + res.reason;
      }
      return res;
    }
    // A document that is not the CycloneDX JSON npm documents says nothing
    // about the lockfile: a tool problem, with the raw output kept.
    let components: number;
    try {
      components = sbomComponents(c.stdout);
    } catch (err) {
      return unreadableResult(
        res,
        sbomGenerateID,
        input.context.id,
        "npm sbom",
        "sbom",
        c,
        err instanceof UnreadableOutput
          ? err.summary
          : "it is not the CycloneDX document that npm sbom documents",
      );
    }

    res.status = StatusCompleted;
    res.metrics = [metric("sbom_components", components, "components")];
    res.artifacts = [
      newArtifact({
        id: "sbom-" + input.context.id,
        path:
          "artifacts/" +
          sbomGenerateID +
          "/" +
          input.context.id +
          "-sbom.cdx.json",
        media_type: sbomMediaType,
        content: c.stdout,
      }),
    ];
    res.limitations = sbomLimitations(src.lock, src.path);
    return res;
  },
};

register(sbomGenerateID, sbomGenerate);

const bomSchema: json.Schema = {
  kind: "struct",
  type: 'struct { BOMFormat string "json:\\"bomFormat\\""; Components []json.RawMessage "json:\\"components\\"" }',
  fields: [
    { name: "bomFormat", schema: { kind: "string" } },
    {
      name: "components",
      schema: {
        kind: "slice",
        type: "[]json.RawMessage",
        elem: { kind: "raw" },
      },
    },
  ],
};

/**
 * sbomComponents counts the components of a CycloneDX document. The root
 * component of the package is in the metadata and is no component. npm
 * leaves the list out when a package has no dependencies. It throws for a
 * document that is no CycloneDX JSON.
 */
export function sbomComponents(doc: Uint8Array): number {
  let bom: { bomFormat: string; components: json.GoSlice | null };
  try {
    bom = json.unmarshal(doc, bomSchema) as typeof bom;
  } catch {
    throw new UnreadableOutput(
      `\`npm sbom\` wrote no JSON document: ${quote(oneLine(tail(goString(doc), 200), 200))}`,
      "it is not the JSON document that npm sbom documents",
    );
  }
  if (bom.bomFormat !== "CycloneDX") {
    throw new UnreadableOutput(
      "`npm sbom` wrote a JSON document that is not CycloneDX",
      "its JSON document is not a CycloneDX document",
    );
  }
  return bom.components?.len ?? 0;
}

/**
 * incompleteLockEntries counts the lockfile entries of downloaded packages
 * without `resolved` or without `integrity`, and names them as
 * name@version, sorted, one name per version. Links, the folders they point
 * at and the root package are the project's own code and nothing was
 * downloaded for them.
 */
export function incompleteLockEntries(lock: Lock): [number, string[]] {
  const seen = new Set<string>();
  let count = 0;
  for (const [key, e] of lock.packages) {
    if (key === "" || e.link || !key.includes("node_modules/")) {
      continue;
    }
    if (e.resolved !== "" && e.integrity !== "") {
      continue;
    }
    count++;
    let name = packageName(key, e);
    if (e.version !== "") {
      name += "@" + e.version;
    }
    seen.add(name);
  }
  return [count, [...seen].sort(compareBytes)];
}

/**
 * sbomLimitations is the Limitation for incomplete lockfile entries, or
 * none. The names are text of the project: they go in as quoted text, up to
 * 20.
 */
export function sbomLimitations(
  lock: Lock,
  lockfilePath: string,
): Limitation[] {
  const [count, names] = incompleteLockEntries(lock);
  if (count === 0) {
    return [];
  }
  const [, list] = unknownList(names);
  const subject =
    count === 1
      ? "1 lockfile entry has"
      : `${String(count)} lockfile entries have`;
  return [
    newLimitation({
      reason_code: "sbom_entries_incomplete",
      check_id: sbomGenerateID,
      path: lockfilePath,
      message: `${subject} no \`resolved\` URL or no \`integrity\` hash, so their components in the SBOM are incomplete: ${list}`,
    }),
  ];
}
