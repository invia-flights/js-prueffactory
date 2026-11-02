// What the deployment files of a project say it starts. This part holds the
// YAML helpers that list-checks needs; the rest arrives with ticket 23 of the
// port.
import * as yaml from "../yamlv3/yaml.ts";

/** isYAMLString says whether a node is a scalar that YAML reads as a string. */
export function isYAMLString(n: yaml.Node): boolean {
  return n.kind === yaml.ScalarNode && yaml.shortTagOf(n) === "!!str";
}
