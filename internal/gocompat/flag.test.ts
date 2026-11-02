import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { ErrHelp, FlagSet } from "./flag.ts";

// What Go's flag package does with a FlagSet that has a string, a bool and a
// list flag (see recordedFrom and the generator beside the file).
const oracle = JSON.parse(
  readFileSync(new URL("testdata/go-oracle-cli.json", import.meta.url), "utf8"),
) as {
  flag: {
    Args: string[];
    Err: string;
    Help: boolean;
    Format: string;
    Fast: boolean;
    Only: string[];
    Visited: string[];
    Rest: string[];
  }[];
};

describe("flag.FlagSet.Parse", () => {
  for (const c of oracle.flag) {
    test(JSON.stringify(c.Args), () => {
      const fs = new FlagSet();
      const format = fs.string("format", "def");
      const fast = fs.bool("fast", false);
      const only: string[] = [];
      fs.func("only", (v) => only.push(v));

      let err: unknown;
      try {
        fs.parse(c.Args);
      } catch (e) {
        err = e;
      }
      if (c.Help) {
        assert.equal(err, ErrHelp);
      } else if (c.Err !== "") {
        assert.ok(err instanceof Error && err !== ErrHelp);
        assert.equal(err.message, c.Err);
      } else {
        assert.equal(err, undefined);
        assert.deepEqual(fs.args(), c.Rest);
      }
      assert.equal(format.value, c.Format);
      assert.equal(fast.value, c.Fast);
      assert.deepEqual(only, c.Only);
      assert.deepEqual(
        ["fast", "format", "only"].filter((n) => fs.isSet(n)),
        c.Visited,
      );
    });
  }
});
