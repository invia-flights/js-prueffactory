import { type Check, register } from "./check.ts";
import { lockfileApplicability } from "./lockfile_support.ts";

export const securityLicensesID = "security.licenses";

// securityLicenses lists the licenses of the lockfile. The run arrives with
// ticket 19 of the port.
export const securityLicenses: Check = {
  applicability(_p, c) {
    return lockfileApplicability(securityLicensesID, c);
  },
};

register(securityLicensesID, securityLicenses);
