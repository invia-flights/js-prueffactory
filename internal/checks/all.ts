// all loads every Check implementation, so that the registry in check.ts is
// complete. In Go every Check registered itself in an init function of the
// package; a TypeScript module registers only once it is imported. Code that
// asks implementation() imports this module. A new Check file gets its import
// here; a test checks that every implemented Catalog Check is registered.
import "./api_lint.ts";
import "./artifacts_structured.ts";
import "./clones.ts";
import "./deps_deprecated.ts";
import "./deps_engines.ts";
import "./file_class_readers.ts";
import "./deps_outdated.ts";
import "./lint_correctness.ts";
import "./lint_existing.ts";
import "./lint_typed.ts";
import "./modules_cycles.ts";
import "./package_deps_tree.ts";
import "./package_install.ts";
import "./package_install_scripts.ts";
import "./package_manifest.ts";
import "./quality_metrics.ts";
import "./quality_size.ts";
import "./quality_suppressions.ts";
import "./quality_unused.ts";
import "./repository_compose.ts";
import "./repository_dockerfile.ts";
import "./repository_github_actions.ts";
import "./repository_gitlab_ci.ts";
import "./repository_helm.ts";
import "./repository_kubernetes.ts";
import "./repository_shell.ts";
import "./runtime_unhandled_rejections.ts";
import "./runtime_warnings.ts";
import "./sbom_generate.ts";
import "./schema_compile.ts";
import "./schema_drift.ts";
import "./security_dependencies.ts";
import "./security_integrity.ts";
import "./security_licenses.ts";
import "./security_patterns.ts";
import "./security_secrets.ts";
import "./syntax_parse.ts";
import "./tests_coverage.ts";
import "./tests_existing.ts";
import "./tests_flaky.ts";
import "./tests_smells.ts";
import "./types_javascript.ts";
import "./types_strictness.ts";
