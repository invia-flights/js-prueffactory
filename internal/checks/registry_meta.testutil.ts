// firstPackage of the Go meta tests (security_dependencies_test.go): a
// testdata project discovered, with its first package Context.
import { fileURLToPath } from "node:url";

import {
  type Context,
  discover,
  type Project,
} from "../discovery/discovery.ts";

export function firstPackage(name: string): [Project, Context] {
  const proj = discover(
    fileURLToPath(new URL(`../../testdata/projects/${name}`, import.meta.url)),
  );
  const c = proj.contexts[1];
  if (c === undefined) {
    throw new Error(`${name} has no package`);
  }
  return [proj, c];
}
