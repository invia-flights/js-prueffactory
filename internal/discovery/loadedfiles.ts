import { Source, TestCode } from "./classify.ts";
import type { File, Package, Project } from "./discovery.ts";

// TestFile is a file a suite's test runner loads, as the probe of the
// installed runner reported it.
export interface TestFile {
  // contextID is the Context of the package whose suite loads the file.
  contextID: string;
  // path is the project path of the file.
  path: string;
  // suite is the origin of the suite that loads the file.
  suite: string;
  // kind says how the runner loads it: "spec" for a test file, or
  // "require", "import" or "file" for a file the runner's options name.
  kind: string;
}

// withTestFiles returns a view of the project in which the files the runners
// load are Test code. Only a Source file of the package that loads it moves:
// Test data and Build output win over Test code, and a file of another
// package, outside the project or not there at all stays as it is. The
// project itself is never changed, because Checks that do not wait for the
// probe read it at the same time; a project with nothing to move is returned
// as it is.
export function withTestFiles(
  p: Project,
  loaded: readonly TestFile[],
): Project {
  const index = fileIndex(p);
  const move = new Set<string>();
  for (const l of loaded) {
    const f = sourceFile(index, l);
    if (f) move.add(f.path);
  }
  if (move.size === 0) return p;
  const reclassify = (files: readonly File[]): File[] =>
    files.map((f) =>
      move.has(f.path) && f.class === Source
        ? { ...f, class: TestCode }
        : { ...f },
    );

  const view = Object.assign(
    Object.create(Object.getPrototypeOf(p) as object) as Project,
    p,
  );
  view.files = reclassify(p.files);
  const packages = new Map<Package, Package>();
  view.packages = p.packages.map((pkg) => {
    const copied = Object.assign(
      Object.create(Object.getPrototypeOf(pkg) as object) as Package,
      pkg,
    );
    copied.files = reclassify(pkg.files);
    packages.set(pkg, copied);
    return copied;
  });
  view.contexts = p.contexts.map((c) => ({
    ...c,
    package: c.package === null ? null : (packages.get(c.package) ?? null),
  }));
  return view;
}

// movedTestFiles lists the files of loaded that the probe turns from Source
// code into Test code in the package, once for each suite that loads them.
export function movedTestFiles(
  p: Project,
  pkg: Package,
  loaded: readonly TestFile[],
): TestFile[] {
  const index = fileIndex(p);
  const seen = new Set<string>();
  const out: TestFile[] = [];
  for (const l of loaded) {
    if (l.contextID !== pkg.contextID) continue;
    const key = JSON.stringify([l.suite, l.path]);
    if (!sourceFile(index, l) || seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

function fileIndex(p: Project): Map<string, File> {
  return new Map(p.files.map((f) => [f.path, f]));
}

// sourceFile returns the Source file a loaded file names, if there is one
// in the package of its Context.
function sourceFile(
  index: ReadonlyMap<string, File>,
  l: TestFile,
): File | null {
  const f = index.get(l.path);
  return f?.contextID === l.contextID && f.class === Source ? f : null;
}
