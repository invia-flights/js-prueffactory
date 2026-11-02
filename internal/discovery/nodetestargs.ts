import type { MochaArg } from "./testfiles.ts";

// nodeOptionsWithValue are the Node options that can take their value as the
// next word, so that the word is not taken for a test file.
const nodeOptionsWithValue = new Set([
  "require",
  "r",
  "import",
  "loader",
  "experimental-loader",
  "conditions",
  "C",
  "env-file",
  "disable-warning",
  "watch-path",
  "test-reporter",
  "test-reporter-destination",
  "test-name-pattern",
  "test-skip-pattern",
  "test-concurrency",
  "test-timeout",
  "test-shard",
  "test-isolation",
  "test-coverage-include",
  "test-coverage-exclude",
  "test-coverage-branches",
  "test-coverage-functions",
  "test-coverage-lines",
  "max-old-space-size",
  "stack-size",
  "title",
  "input-type",
]);

// parseNodeTestArgs splits the arguments of `node … --test …` into options
// and test file arguments. It knows which options take their value as the
// next word. Everything after `--` is a test file argument, and the `--`
// itself is an item named "--".
export function parseNodeTestArgs(args: readonly string[]): MochaArg[] {
  const out: MochaArg[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") {
      out.push({ words: [a], name: "--", value: "", file: false });
      for (const rest of args.slice(i + 1)) {
        out.push({ words: [rest], name: "", value: rest, file: true });
      }
      return out;
    }
    if (!a.startsWith("-") || a === "-") {
      out.push({ words: [a], name: "", value: a, file: true });
      continue;
    }
    const [name, value, hasValue] = cut(a.replace(/^-+/, ""), "=");
    const item: MochaArg = { words: [a], name, value, file: false };
    if (!hasValue && nodeOptionsWithValue.has(name) && i + 1 < args.length) {
      i++;
      const next = args[i] ?? "";
      item.words = [...item.words, next];
      item.value = next;
    }
    out.push(item);
  }
  return out;
}

// cut is strings.Cut.
export function cut(s: string, sep: string): [string, string, boolean] {
  const i = s.indexOf(sep);
  if (i < 0) return [s, "", false];
  return [s.slice(0, i), s.slice(i + sep.length), true];
}
