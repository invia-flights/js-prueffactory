// all loads every file of the toolset table, so that version() hashes the
// whole table. In Go every file of the package recorded its entries in init;
// a TypeScript module records them only once it is imported. Code that needs
// the toolset version imports version from here, never from toolset.ts.
// A new file of the table gets its import here; the oracle test checks that
// the table is complete.
import "./actionlint.ts";
import "./ajv.ts";
import "./c8.ts";
import "./dependency_cruiser.ts";
import "./dockercli.ts";
import "./eslint.ts";
import "./gitleaks.ts";
import "./hadolint.ts";
import "./helm.ts";
import "./jscpd.ts";
import "./knip.ts";
import "./kubeconform.ts";
import "./njsscan.ts";
import "./node.ts";
import "./npmtools.ts";
import "./osvscanner.ts";
import "./redocly.ts";
import "./services.ts";
import "./shellcheck.ts";
import "./typescript.ts";
import "./zizmor.ts";

export { version } from "./toolset.ts";
