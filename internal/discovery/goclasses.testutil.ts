// The Go build knew no Documentation class. The oracle tests compare what the
// Go build recorded (answers that may not be edited) with what this build
// answers, so they read the new class back into the one the Go build gave the
// file. A Documentation file was Test code below a test folder and Source
// code elsewhere: Test data and Build output win over Documentation, so they
// never need the way back.
import {
  Documentation,
  type FileClass,
  folderNames,
  Source,
  TestCode,
} from "./classify.ts";
import type { File, Project } from "./discovery.ts";

const testFolders = new Set(folderNames(TestCode));

/** goClass is the File class the Go build gave the file. */
export function goClass(f: Pick<File, "path" | "class">): FileClass {
  if (f.class !== Documentation) {
    return f.class;
  }
  const folders = f.path.split("/").slice(0, -1);
  return folders.some((part) => testFolders.has(part)) ? TestCode : Source;
}

/**
 * withGoClasses gives every file of the project the File class the Go build
 * gave it and returns the project. Use it only where a test feeds a project
 * to a Check whose recorded Go answer is compared.
 */
export function withGoClasses(proj: Project): Project {
  const files = new Set<File>(proj.files);
  for (const pkg of proj.packages) {
    for (const f of pkg.files) {
      files.add(f);
    }
  }
  for (const f of files) {
    f.class = goClass(f);
  }
  return proj;
}
