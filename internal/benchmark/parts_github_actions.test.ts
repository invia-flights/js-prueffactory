import { describe } from "node:test";

import {
  atPath,
  type FindingMod,
} from "../resultset/resultsettest/scored.testutil.ts";
import { KindHint, SeverityNote } from "../resultset/types.ts";
import { partTable } from "./benchmark.testutil.ts";

// Expected values are worked out by hand: n_eff sums 1 + log2(count) over the
// rules, and S = 100 * 2^(-n_eff / x50) with x50 = 3.

const asNote: FindingMod = (f) => {
  f.severity = SeverityNote;
  f.kind = KindHint;
};

// Go: TestTheGitHubActionsPartDampsFindingsAtWarningLevelOrAbove (the cases),
// TestTheGitHubActionsPartIsDroppedWithoutWorkflows (the last test).
describe("the GitHub Actions part damps Findings at warning level or above", () => {
  const c = "repository.github-actions";
  const ci = atPath(".github/workflows/ci.yml");
  partTable(
    "github_actions",
    c,
    { label: "GitHub Actions", x50: 3, unit: "hits" },
    [
      {
        name: "clean workflows",
        build: () => undefined,
        raw: 0,
        nEff: 0,
        want: 100,
      },
      {
        name: "a Gate and a warning of different rules",
        build: (p) => {
          p.add(c, "actionlint.job-needs", true, ci);
          p.add(c, "zizmor.template-injection", false, ci);
        },
        raw: 2,
        nEff: 2,
        want: 62.99605249474366,
      },
      {
        name: "four warnings of one rule weigh 3",
        build: (p) => {
          for (let i = 0; i < 4; i++) {
            p.add(c, "zizmor.unpinned-uses", false, ci);
          }
        },
        raw: 4,
        nEff: 3,
        want: 50,
      },
      {
        name: "notes do not count",
        build: (p) => {
          p.add(c, "zizmor.excessive-permissions", false, ci, asNote);
          p.add(c, "zizmor.template-injection", false, ci, asNote);
        },
        raw: 0,
        nEff: 0,
        want: 100,
      },
    ],
  );
});
