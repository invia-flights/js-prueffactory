// deps.deprecated (Go: deps_deprecated.go).
import { trimSpace } from "../gocompat/strings.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  ConfidenceConfirmed,
  type Finding,
  KindDefect,
  type Location,
  SeverityWarning,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import { type Check, register } from "./check.ts";
import { type Input, untrusted } from "./input.ts";
import type { LockedVersion } from "./registry_data.ts";
import {
  answered,
  formatFetchedAt,
  type RegistryAnswers,
} from "./registry_answers.ts";
import {
  metric,
  registryData,
  registryDataApplicability,
  registryDataImages,
  registryDataPrerequisites,
} from "./registry_fetch.ts";

export const depsDeprecatedID = "deps.deprecated";

/**
 * depsDeprecated reports every locked package version, direct or
 * transitive, whose author marked it deprecated in the registry. The data
 * comes from the registry-data step in registry_fetch.ts, which
 * deps.outdated shares.
 *
 * A deprecation is a warning with confidence confirmed and no Gate. It is a
 * side indicator: the registry changes without the project changing, so the
 * counts never move the score. Packages the registry did not answer for are
 * counted in the metric registry_unknown and never read as not deprecated.
 */
export const depsDeprecated: Check = {
  applicability(_p, c) {
    return registryDataApplicability(depsDeprecatedID, c);
  },

  /** prerequisites asks for the install only when the package has no lockfile. */
  prerequisites(c) {
    return registryDataPrerequisites(c);
  },

  /** images tells the engine which image the registry-data step runs in. */
  images(c) {
    return registryDataImages(c);
  },

  async run(signal, input) {
    const data = await registryData(signal, input);
    if (data.fail !== null) {
      return data.failed(depsDeprecatedID, input.context.id);
    }
    const res = data.result();
    res.findings = deprecatedFindings(
      input,
      data.versions,
      data.answers,
      data.locate,
    );
    const [prod, dev] = deprecatedCounts(data.versions, data.answers);
    res.metrics = [
      metric("deprecated_prod", prod, "versions"),
      metric("deprecated_dev", dev, "versions"),
      data.unknownMetric(),
    ];
    res.limitations = data.unknownLimitations(depsDeprecatedID);
    return res;
  },
};

register(depsDeprecatedID, depsDeprecated);

/**
 * deprecatedVersions returns the locked versions whose registry entry has a
 * non-empty deprecation text, with the text.
 */
export function deprecatedVersions(
  versions: readonly LockedVersion[],
  answers: RegistryAnswers,
): [LockedVersion[], string[]] {
  const out: LockedVersion[] = [];
  const texts: string[] = [];
  for (const v of versions) {
    const a = answers.byName.get(v.name);
    if (a === undefined || !answered(a)) {
      continue;
    }
    const text = trimSpace(a.versions.get(v.version)?.deprecated ?? "");
    if (text !== "") {
      out.push(v);
      texts.push(text);
    }
  }
  return [out, texts];
}

/**
 * deprecatedCounts counts the deprecated locked versions in production and
 * in development scope.
 */
export function deprecatedCounts(
  versions: readonly LockedVersion[],
  answers: RegistryAnswers,
): [number, number] {
  const [deprecated] = deprecatedVersions(versions, answers);
  let prod = 0;
  let dev = 0;
  for (const v of deprecated) {
    if (v.scope === "dev") {
      dev++;
    } else {
      prod++;
    }
  }
  return [prod, dev];
}

/**
 * deprecatedFindings makes one warning of each deprecated locked version.
 * The message names the package, version, directness and scope. The
 * author's text is untrusted and goes into the evidence only.
 */
export function deprecatedFindings(
  input: Input,
  versions: readonly LockedVersion[],
  answers: RegistryAnswers,
  locate: (key: string) => Location,
): Finding[] {
  const [deprecated, texts] = deprecatedVersions(versions, answers);
  const date = formatFetchedAt(answers);
  return deprecated.map((v, i) => {
    const rule = "deprecated-version";
    const directness = v.direct ? "direct" : "transitive";
    const actual = `${v.name} ${v.version}`;
    const loc = locate(v.key);
    return newFinding({
      check_id: depsDeprecatedID,
      context_id: input.context.id,
      rule_id: rule,
      fingerprint: newFingerprint(depsDeprecatedID, rule, loc.path, actual),
      kind: KindDefect,
      severity: SeverityWarning,
      confidence: ConfidenceConfirmed,
      title: `${v.name} ${v.version} is marked deprecated in the registry`,
      message: `\`${v.name}\` ${v.version}, a ${directness} ${v.scope} dependency, is marked deprecated by its author in the registry. Registry data of ${date}.`,
      locations: [loc],
      actual,
      evidence: [
        untrusted("deprecation_text", texts[i] ?? "", "npm registry"),
        untrusted("dependency_scope", v.scope, "package-lock"),
        untrusted("dependency_kind", directness, "package-lock"),
        untrusted("registry_data_date", date, "npm registry"),
      ],
      reproduction: input.reproduction(depsDeprecatedID),
      limitations: [],
    });
  });
}
