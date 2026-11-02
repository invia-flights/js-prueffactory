// package.manifest parses each package's package.json and lockfile on the
// host-side Snapshot copy (Go: package_manifest.go). It needs no container,
// so it has no images. The parsing lives in internal/lockfile, which the other
// lockfile Checks share.
//
// Gates: a package.json or lockfile that does not parse, a manifest
// dependency the lockfile lacks, and a specifier that differs from the
// lockfile's. Warnings: no lockfile, and lockfiles of several package
// managers. A lockfile that this release cannot read (version 1, another
// package manager, workspaces) is no defect: the Check is partial and says
// why.
import { base, join } from "../gocompat/path.ts";
import {
  check as checkConsistency,
  type Mismatch,
  SpecifierMismatch,
  MissingDependency,
} from "../lockfile/consistency.ts";
import { type Loaded, load } from "../lockfile/load.ts";
import { SyntaxError } from "../lockfile/lockfile.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  Applicable,
  ConfidenceConfirmed,
  type Finding,
  KindDefect,
  type Limitation,
  type Location,
  type Metric,
  NotApplicable,
  SeverityError,
  SeverityWarning,
  StatusCompleted,
  StatusPartial,
  StatusToolError,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import { type Check, register } from "./check.ts";
import type { Input, Result } from "./input.ts";

export const packageManifestID = "package.manifest";

// Rule IDs of package.manifest.
const ruleManifestInvalid = "manifest-invalid";
const ruleLockfileInvalid = "lockfile-invalid";
const ruleMissingDependency = "lockfile-missing-dependency";
const ruleSpecifierMismatch = "lockfile-specifier-mismatch";
const ruleLockfileMissing = "lockfile-missing";
const ruleMultipleLockfiles = "lockfile-multiple-managers";
const packageManagerMetricID = "package_manager";

export const packageManifest: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "package.manifest examines packages, and this is the project Context",
      ];
    }
    return [Applicable, ""];
  },

  run(_signal, input) {
    return Promise.resolve(runManifest(input));
  },
};

register(packageManifestID, packageManifest);

function runManifest(input: Input): Result {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("package.manifest runs in package Contexts only");
  }
  const res: Result & { findings: Finding[] } = {
    status: StatusCompleted,
    findings: [],
  };
  const rel = (name: string): string => join(pkg.path, name);
  const dir =
    pkg.path === "." ? input.snapshotDir : join(input.snapshotDir, pkg.path);
  const loaded = load(dir);

  if (loaded.manifestErr !== null) {
    if (!(loaded.manifestErr instanceof SyntaxError)) {
      return readFailure(res, rel("package.json"), loaded.manifestErr);
    }
    res.findings.push(
      syntaxFinding(
        input,
        ruleManifestInvalid,
        rel("package.json"),
        "package.json does not parse",
        loaded.manifestErr,
      ),
    );
  }
  if (loaded.lockErr !== null) {
    if (!(loaded.lockErr instanceof SyntaxError)) {
      return readFailure(res, rel(loaded.lockfileName), loaded.lockErr);
    }
    res.findings.push(
      syntaxFinding(
        input,
        ruleLockfileInvalid,
        rel(loaded.lockfileName),
        "The lockfile is broken",
        loaded.lockErr,
      ),
    );
  }

  if (loaded.manifest !== null && loaded.lock !== null) {
    for (const m of checkConsistency(loaded.manifest, loaded.lock)) {
      res.findings.push(
        mismatchFinding(input, m, rel("package.json"), loaded.lockfileName),
      );
    }
  }
  if (loaded.lockfiles.length === 0) {
    res.findings.push(noLockfileFinding(input, rel("package.json")));
  }
  if (loaded.managers().length > 1) {
    res.findings.push(multipleLockfilesFinding(input, loaded, rel));
  }

  res.metrics = [packageManagerMetric(loaded)];

  // A lockfile the Check cannot read is a gap, not a defect. A missing or
  // broken lockfile is already reported as a Finding above.
  const u = loaded.unsupported;
  if (u !== null && u.code !== "no_lockfile" && u.code !== "lockfile_invalid") {
    res.status = StatusPartial;
    res.reasonCode = u.code;
    res.reason = u.reason;
    const lim: Limitation = {
      reason_code: u.code,
      message: u.reason,
      check_id: packageManifestID,
      path: loaded.lockfileName === "" ? null : rel(loaded.lockfileName),
    };
    res.limitations = [lim];
  }
  return res;
}

// readFailure turns a file that exists but cannot be read into a tool error.
function readFailure(res: Result, file: string, err: Error): Result {
  res.status = StatusToolError;
  res.reasonCode = "read_failed";
  res.reason = `cannot read ${file}: ${err.message}`;
  return res;
}

// manifestFinding fills the fields every package.manifest Finding shares.
function manifestFinding(
  input: Input,
  rule: string,
  fingerprintText: string,
  file: string,
): Finding {
  return newFinding({
    check_id: packageManifestID,
    context_id: input.context.id,
    rule_id: rule,
    fingerprint: newFingerprint(packageManifestID, rule, file, fingerprintText),
    kind: KindDefect,
    confidence: ConfidenceConfirmed,
    reproduction: input.reproduction(packageManifestID),
  });
}

function syntaxFinding(
  input: Input,
  rule: string,
  file: string,
  title: string,
  se: SyntaxError,
): Finding {
  const f = manifestFinding(input, rule, title, file);
  f.severity = SeverityError;
  f.gate = true;
  f.title = title;
  f.message = `npm cannot read this file, so nothing can be installed from it: ${se.detail}.`;
  f.locations = [input.location("primary", file, se.line, se.column)];
  return f;
}

function mismatchFinding(
  input: Input,
  m: Mismatch,
  manifestFile: string,
  lockName: string,
): Finding {
  const rule =
    m.kind === SpecifierMismatch
      ? ruleSpecifierMismatch
      : ruleMissingDependency;
  const f = manifestFinding(
    input,
    rule,
    m.section + " " + m.name,
    manifestFile,
  );
  f.severity = SeverityError;
  f.gate = true;
  f.expected = m.specifier;
  f.locations = [input.location("primary", manifestFile, 0, 0)];
  if (m.kind === MissingDependency) {
    f.title = "The lockfile does not contain a dependency of package.json";
    f.message = `${base(manifestFile)} declares ${m.name}@${m.specifier} in ${m.section}, but ${lockName} does not install it, so \`npm ci\` fails.`;
    f.actual = "not in " + lockName;
  } else {
    f.title = "A dependency specifier differs from the lockfile";
    f.message = `${base(manifestFile)} declares ${m.name}@${m.specifier} in ${m.section}, but ${lockName} records ${m.lockSpecifier}, so \`npm ci\` fails.`;
    f.actual = m.lockSpecifier;
  }
  return f;
}

function noLockfileFinding(input: Input, manifestFile: string): Finding {
  const f = manifestFinding(
    input,
    ruleLockfileMissing,
    "no lockfile",
    manifestFile,
  );
  f.severity = SeverityWarning;
  f.title = "The package has no lockfile";
  f.message =
    "Without a lockfile, `npm install` resolves the newest matching versions, so two Runs can install different code. Commit a package-lock.json.";
  f.locations = [input.location("primary", manifestFile, 0, 0)];
  return f;
}

function multipleLockfilesFinding(
  input: Input,
  l: Loaded,
  rel: (name: string) => string,
): Finding {
  const names: string[] = [];
  const locations: Location[] = [];
  for (const lf of l.lockfiles) {
    names.push(lf.name);
    const role = locations.length === 0 ? "primary" : "related";
    locations.push(input.location(role, rel(lf.name), 0, 0));
  }
  const f = manifestFinding(
    input,
    ruleMultipleLockfiles,
    names.join(" "),
    rel("package.json"),
  );
  f.severity = SeverityWarning;
  f.title = "Lockfiles of several package managers";
  f.message = `The package holds ${names.join(", ")}. Only one of them is kept up to date, and it is unclear which versions are meant. Treated as a ${l.manager} package.`;
  f.locations = locations;
  return f;
}

// packageManagerMetric records the detected manager. The Report schema has
// no field for it yet, so it goes into a Metric without a value and with the
// answer as its reason.
function packageManagerMetric(l: Loaded): Metric {
  let by: string;
  switch (l.source) {
    case "lockfile":
      by =
        "found by " +
        l.lockfiles
          .filter((lf) => lf.manager === l.manager)
          .map((lf) => lf.name)
          .join(", ");
      break;
    case "packageManager":
      by = "found by the packageManager field";
      break;
    case "deno.json":
      by = "found by deno.json";
      break;
    default:
      by = "assumed: no lockfile and no packageManager field";
  }
  return {
    id: "",
    check_id: "",
    context_id: "",
    name: packageManagerMetricID,
    value: null,
    reason: `${l.manager} (${by})`,
    unit: "name",
  };
}
