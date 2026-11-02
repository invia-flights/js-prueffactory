import { ext, join } from "../gocompat/path.ts";
import { Source, TestCode } from "./classify.ts";
import type { File, Package } from "./discovery.ts";
import { buildScript, hasBabelKey, tsEmitSignal } from "./tsemit.ts";

// buildStepReason returns why a package needs a build step before its
// JavaScript can run, or "" when it does not. Signs are a Babel config, a
// bundler config, or a tsconfig.json next to TypeScript sources that also
// shows an emit signal (see tsEmitSignal and buildScript). A tsconfig.json
// that is only there for the editor, next to a few TypeScript files in a
// JavaScript package, is no sign: the JavaScript runs as it is.
export function buildStepReason(
  root: string,
  pkg: Package,
  files: readonly File[],
): string {
  let hasTS = false;
  let tsconfig = false;
  for (const f of files) {
    const rel = f.packageRel;
    if (!rel.includes("/")) {
      // files directly in the package folder
      const reason = configReason(rel);
      if (reason !== "") return reason;
      if (rel === "tsconfig.json") tsconfig = true;
    }
    if ((f.class === Source || f.class === TestCode) && isTypeScript(rel)) {
      hasTS = true;
    }
  }
  const folder = join(root, pkg.path);
  if (tsconfig && hasTS) {
    const signal = tsEmitSignal(root, folder);
    if (signal !== "") {
      return "tsconfig.json next to TypeScript sources, with " + signal;
    }
    const script = buildScript(root, join(folder, "package.json"));
    if (script !== "") {
      return `tsconfig.json next to TypeScript sources, and ${script} builds them`;
    }
  }
  if (hasBabelKey(root, join(folder, "package.json"))) {
    return "Babel configuration in package.json";
  }
  return "";
}

function configReason(name: string): string {
  if (
    name === ".babelrc" ||
    name.startsWith(".babelrc.") ||
    name.startsWith("babel.config.")
  ) {
    return "Babel config " + name;
  }
  if (name === ".swcrc") return "SWC config " + name;
  if (name === ".parcelrc") return "Parcel config " + name;
  for (const bundler of ["webpack", "rollup", "vite", "esbuild", "tsup"]) {
    if (name.startsWith(bundler + ".config.")) return "bundler config " + name;
  }
  return "";
}

// isTypeScript says whether a file is TypeScript source: .ts, .tsx, .mts or
// .cts, but not a declaration file, which only describes JavaScript.
export function isTypeScript(rel: string): boolean {
  if (
    rel.endsWith(".d.ts") ||
    rel.endsWith(".d.mts") ||
    rel.endsWith(".d.cts")
  ) {
    return false;
  }
  return [".ts", ".tsx", ".mts", ".cts"].includes(ext(rel));
}
