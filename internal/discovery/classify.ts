import { split } from "../gocompat/path.ts";
import { sortStrings } from "../gocompat/strings.ts";

// FileClass is the File class of a project file.
export type FileClass = "source" | "test_code" | "test_data" | "build_output";

export const Source: FileClass = "source";
export const TestCode: FileClass = "test_code";
export const TestData: FileClass = "test_data";
export const BuildOutput: FileClass = "build_output";

const testDataFolders = new Set([
  "fixtures",
  "__fixtures__",
  "testdata",
  "__mocks__",
]);
const buildOutputFolders = new Set(["dist", "build", "coverage"]);
const testCodeFolders = new Set(["test", "tests", "__tests__", "spec"]);

// classify returns the File class of a path relative to the project root
// (with "/" separators). Test data wins over Test code, and Build output wins
// over Test code. Only folder names and the `.min.js` suffix decide here; the
// files a discovered test runner loads become Test code when runner discovery
// lands.
export function classify(rel: string): FileClass {
  const [dir, base] = split(rel);
  let data = false;
  let build = false;
  let test = false;
  for (const part of trimSlashes(dir).split("/")) {
    data ||= testDataFolders.has(part);
    build ||= buildOutputFolders.has(part);
    test ||= testCodeFolders.has(part);
  }
  if (data) return TestData;
  if (build || base.endsWith(".min.js")) return BuildOutput;
  if (test) return TestCode;
  return Source;
}

function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, "");
}

// folderNames returns the folder names that put a file into a File class,
// sorted. Source code has none.
export function folderNames(fileClass: FileClass): string[] {
  let set: ReadonlySet<string>;
  switch (fileClass) {
    case TestData:
      set = testDataFolders;
      break;
    case BuildOutput:
      set = buildOutputFolders;
      break;
    case TestCode:
      set = testCodeFolders;
      break;
    default:
      return [];
  }
  return sortStrings([...set]);
}
