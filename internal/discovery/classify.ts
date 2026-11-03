import { ext, split } from "../gocompat/path.ts";
import { sortStrings, toLower, trim } from "../gocompat/strings.ts";

// FileClass is the File class of a project file.
export type FileClass =
  "source" | "test_code" | "test_data" | "build_output" | "documentation";

export const Source: FileClass = "source";
export const TestCode: FileClass = "test_code";
export const TestData: FileClass = "test_data";
export const BuildOutput: FileClass = "build_output";
export const Documentation: FileClass = "documentation";

const testDataFolders = new Set([
  "fixtures",
  "__fixtures__",
  "testdata",
  "__mocks__",
]);
const buildOutputFolders = new Set(["dist", "build", "coverage"]);
const testCodeFolders = new Set(["test", "tests", "__tests__", "spec"]);
const documentationFolders = new Set(["docs", "doc"]);

// proseExtensions put a file into Documentation wherever it is.
const proseExtensions = new Set([
  ".md",
  ".mdx",
  ".markdown",
  ".rst",
  ".adoc",
  ".txt",
]);

// codeExtensions are the JavaScript and TypeScript files. Below a folder named
// docs or doc they stay code, so that a runnable example is still linted and
// type-checked.
const codeExtensions = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".jsx",
  ".ts",
  ".cts",
  ".mts",
  ".tsx",
]);

// classify returns the File class of a path relative to the project root
// (with "/" separators). From the strongest: Test data, Build output,
// Documentation, Test code, Source code. Only folder names, the extension
// and the `.min.js` suffix decide here. The files a discovered test runner
// loads become Test code later, and only when they are Source code: the probe
// never moves Documentation.
//
// Documentation is a file with a prose extension (.md, .mdx, .markdown, .rst,
// .adoc, .txt) wherever it is, and any file below a folder named docs or doc
// that is not JavaScript or TypeScript. The extension is read without regard
// to case.
export function classify(rel: string): FileClass {
  const [dir, base] = split(rel);
  let data = false;
  let build = false;
  let test = false;
  let docs = false;
  for (const part of trimSlashes(dir).split("/")) {
    data ||= testDataFolders.has(part);
    build ||= buildOutputFolders.has(part);
    test ||= testCodeFolders.has(part);
    docs ||= documentationFolders.has(part);
  }
  if (data) return TestData;
  if (build || base.endsWith(".min.js")) return BuildOutput;
  const extension = toLower(ext(base));
  if (
    proseExtensions.has(extension) ||
    (docs && !codeExtensions.has(extension))
  ) {
    return Documentation;
  }
  if (test) return TestCode;
  return Source;
}

function trimSlashes(s: string): string {
  return trim(s, "/");
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
    case Documentation:
      set = documentationFolders;
      break;
    default:
      return [];
  }
  return sortStrings([...set]);
}
