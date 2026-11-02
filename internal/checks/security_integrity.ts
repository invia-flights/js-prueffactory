import { type Check, register } from "./check.ts";
import { lockfileApplicability } from "./lockfile_support.ts";

export const securityIntegrityID = "security.integrity";

// securityIntegrity reads the integrity hashes and URLs of the lockfile. The
// run arrives with ticket 19 of the port.
export const securityIntegrity: Check = {
  applicability(_p, c) {
    return lockfileApplicability(securityIntegrityID, c);
  },
};

register(securityIntegrityID, securityIntegrity);
