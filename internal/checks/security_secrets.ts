import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";

export const secretsID = "security.secrets";

// securitySecrets scans the whole project for leaked secrets with gitleaks.
// The scan arrives with ticket 12 of the port.
export const securitySecrets: Check = {
  applicability(_p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "security.secrets scans the whole project, and this is a package Context",
      ];
    }
    return [Applicable, ""];
  },
};

register(secretsID, securitySecrets);
