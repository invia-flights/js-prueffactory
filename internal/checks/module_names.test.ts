import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shownSpecifier } from "./module_names.ts";

describe("shownSpecifier", () => {
  it("shows a relative path with folders named after route parameters", () => {
    const s = "./../../docs/json/flight/{flightStoreToken}/products/put/schema";
    assert.equal(shownSpecifier(s), s);
  });

  it("shows packages, scoped packages and aliases as they are", () => {
    for (const s of ["lodash", "@app/x", "~/x", "#lib/x", "node:fs"]) {
      assert.equal(shownSpecifier(s), s);
    }
  });

  it("replaces a specifier with markup, quotes or spaces", () => {
    for (const s of ["a b", "a'b", "<x>", "[a](b)", "a\nb", "$(whoami) x"]) {
      assert.equal(
        shownSpecifier(s),
        "(import specifier with unusual characters)",
      );
    }
  });
});
