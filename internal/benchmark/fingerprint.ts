import { createHash } from "node:crypto";

import { marshal } from "../gocompat/json.ts";
import { compareBytes, sortStrings } from "../gocompat/strings.ts";
import {
  type BenchmarkFingerprint,
  type FingerprintFields,
  FingerprintFieldsShape,
  type RuntimeFingerprint,
  type Set,
} from "../resultset/types.ts";

// Names of the Context tools that carry fingerprint inputs. They are recorded
// by lint.correctness (the generated ESLint config), security.patterns (the
// tool-owned rules), security.dependencies (the date of the advisory data),
// repository.gitlab-ci (the CI schema hash) and repository.kubernetes (the
// Kubernetes version of the schemas).
const toolESLintConfig = "eslint-config";
const toolSecurityRules = "prueffactory-security-rules";
const toolAdvisoryDB = "osv-advisory-database";
const toolTypeScript6 = "typescript6";
const toolGitLabCISchema = "gitlab-ci-schema";
const toolKubernetesSchemas = "kubernetes-schemas";
const toolTypedLintRules = "typed-lint-rules";
const shortFingerprintLen = 12;

/** sortedKeys returns the members of a set in byte order. */
function sortedKeys(set: ReadonlySet<string>): string[] {
  return sortStrings([...set]);
}

/** first is the first member in byte order, or null for an empty set. */
function first(set: ReadonlySet<string>): string | null {
  return sortedKeys(set)[0] ?? null;
}

/**
 * fingerprint builds the Benchmark fingerprint: the identity of everything
 * that shapes a score. Scores are comparable only between Runs with equal
 * fingerprints. It reads tool and runtime facts and nothing about the
 * project's own results, so two attempts at one project share a fingerprint
 * when they ran in the same environment.
 *
 * It lists distinct values and not one entry per Context, so that an attempt
 * that adds a package does not change the fingerprint by that alone.
 */
export function fingerprint(s: Set, profileID: string): BenchmarkFingerprint {
  const digests = new globalThis.Set<string>();
  const eslint = new globalThis.Set<string>();
  const securityRules = new globalThis.Set<string>();
  const advisory = new globalThis.Set<string>();
  const typescript6 = new globalThis.Set<string>();
  const gitlabSchemas = new globalThis.Set<string>();
  const kubernetesVersions = new globalThis.Set<string>();
  const typedLintRules = new globalThis.Set<string>();
  const runtimes = new Map<string, RuntimeFingerprint>();

  for (const c of s.contexts) {
    if (c.node !== null) {
      if (c.node.image_digest !== "") {
        digests.add(c.node.image_digest);
      }
      const rt: RuntimeFingerprint = {
        node_version: c.node.version,
        npm_version: c.npm_version ?? "",
      };
      runtimes.set(JSON.stringify([rt.node_version, rt.npm_version]), rt);
    }
    for (const t of c.tools) {
      if (t.name === toolESLintConfig && t.digest !== null) {
        eslint.add(t.digest);
      } else if (t.name === toolSecurityRules && t.digest !== null) {
        securityRules.add(t.digest);
      } else if (t.name === toolAdvisoryDB) {
        advisory.add(t.version);
      } else if (t.name === toolTypeScript6) {
        typescript6.add(t.version);
      } else if (t.name === toolGitLabCISchema && t.digest !== null) {
        gitlabSchemas.add(t.digest);
      } else if (t.name === toolKubernetesSchemas) {
        kubernetesVersions.add(t.version);
      } else if (t.name === toolTypedLintRules && t.digest !== null) {
        typedLintRules.add(t.digest);
      } else if (t.digest?.startsWith("sha256:")) {
        digests.add(t.digest);
      }
    }
  }
  for (const svc of s.services) {
    if (svc.image_digest !== null && svc.image_digest !== "") {
      digests.add(svc.image_digest);
    }
  }

  const f: FingerprintFields = {
    profile_id: profileID,
    catalog_version: s.profiles.catalog_version,
    toolset_version: s.profiles.toolset_version,
    image_digests: sortedKeys(digests),
    eslint_config_hashes: sortedKeys(eslint),
    security_rule_hashes: sortedKeys(securityRules),
    advisory_database_date: first(advisory),
    typescript6_version: first(typescript6),
    gitlab_ci_schema_hash: first(gitlabSchemas),
    kubernetes_schema_version: first(kubernetesVersions),
    typed_lint_rules_hash: first(typedLintRules),
    runtimes: [...runtimes.values()].sort(
      (a, b) =>
        compareBytes(a.node_version, b.node_version) ||
        compareBytes(a.npm_version, b.npm_version),
    ),
  };

  // json.Marshal: compact, with HTML escaping.
  const canonical = marshal(f, FingerprintFieldsShape, { escapeHTML: true });
  const hash = createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex")
    .slice(0, shortFingerprintLen);
  return { hash, fields: f };
}
