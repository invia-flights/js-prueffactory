import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseRFC3339 } from "../../internal/gocompat/time.ts";
import { oracle } from "./oracle.testutil.ts";

// What json.Unmarshal of Go 1.27 says about a time.Time (generator:
// testdata/go-oracle.go.txt): time.Parse with the RFC 3339 layout, which is
// more lenient than RFC 3339 itself.
describe("times are read as Go reads a time.Time", () => {
  for (const c of oracle.times) {
    test(JSON.stringify(c.in), () => {
      let got: Date | undefined;
      let err = "";
      try {
        got = parseRFC3339(c.in);
      } catch (e) {
        err = (e as Error).message;
      }
      assert.equal(err, c.err);
      if (c.err === "") {
        assert.equal(got?.getTime(), c.unixMilli);
      }
    });
  }
});
