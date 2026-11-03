// The size limit Go's regexp put on include globs. The Go build turned a
// glob into a regexp with regexp.MustCompile, which panicked for one that
// regexp/syntax found "too large"; the panic ended the Check.
import assert from "node:assert/strict";
import { test } from "node:test";

import { background } from "../gocompat/context.ts";
import { projectContext, tree } from "./checks.testutil.ts";
import {
  globCompileFailure,
  globTokens,
  globTooLarge,
} from "./gitlab_ci_includes.ts";
import { Input } from "./input.ts";
import { gitlabCI } from "./repository_gitlab_ci.ts";

// For each glob unit, the smallest number of repetitions Go's regexp.Compile
// refused, recorded from Go 1.27.3 (0: none up to 20 million).
const goThresholds: [string, number][] = [
  ["a", 0],
  ["?", 3355442],
  ["*a", 1118480],
  ["?a", 1677721],
  ["**", 1677720],
  ["**/", 671089],
  ["**/a", 559241],
  ["*a?", 838860],
  [".", 0],
  ["ä", 0],
  ["a*", 1118480],
  ["aaa?", 1677720],
  ["ab*", 1118480],
  ["aaaa**/", 479349],
  ["a?b", 1677720],
  ["**/aa*", 671088],
  ["?aa", 1677720],
  ["x**y", 1118480],
  ["ä?", 1677720],
  ["aa", 0],
];

for (const [unit, threshold] of goThresholds) {
  test(`a glob of ${JSON.stringify(unit)} units is too large where Go found it too large`, () => {
    const tooLarge = (n: number): boolean =>
      globTooLarge(globTokens(Buffer.from(unit.repeat(n))));
    if (threshold === 0) {
      assert.equal(tooLarge(Math.floor(16_000_000 / unit.length)), false);
      return;
    }
    assert.equal(tooLarge(threshold), true);
    assert.equal(tooLarge(threshold - 1), false);
  });
}

test("the failure names Go's error and shows the glob only as trusted text may", () => {
  const failure = globCompileFailure("*a".repeat(1118480));
  assert.equal(
    failure?.endsWith("): error parsing regexp: expression too large"),
    true,
  );
  // The glob has a `*`, which a trusted field may show; its length does not
  // matter because shownGlob cuts it to a placeholder.
  assert.equal(failure.includes("(path with unusual characters)"), true);
  assert.equal(globCompileFailure("*a".repeat(1118479)), undefined);
  // A hostile glob never reaches the text.
  const hostile = globCompileFailure(
    "[click](http://evil.example)" + "?".repeat(3_355_442),
  );
  assert.ok(hostile !== undefined);
  assert.ok(!hostile.includes("evil.example") && !hostile.includes("click"));
  assert.ok(hostile.length < 200);
});

test("a too large include glob ends the Check like Go's panic did", async (t) => {
  const proj = tree(t, {
    ".gitlab-ci.yml": `include:\n  - local: '${"*a".repeat(1118480)}'\ntest:\n  script: make\n`,
  });
  await assert.rejects(
    gitlabCI.run(
      background(),
      new Input({
        project: proj,
        context: projectContext(proj),
        originalPath: proj.root,
        snapshotDir: proj.root,
      }),
    ),
    /^Error: regexp: Compile\(the regexp of the include glob .{1,100}\): error parsing regexp: expression too large$/,
  );
});
