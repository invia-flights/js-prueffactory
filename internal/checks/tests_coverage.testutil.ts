// Fixtures of the coverage tests: what c8 wrote for two files, and the
// stand-ins for the Docker work of the shared coverage location (Go: the
// helpers of tests_coverage_report_test.go and tests_coverage_suites_test.go).
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import type { Metric } from "../resultset/types.ts";
import { type Input } from "./input.ts";
import { useCoverageHooks } from "./tests_coverage.ts";

export const summaryTwoFiles = `{"total": {"lines":{"total":13,"covered":8,"skipped":0,"pct":61.53},"statements":{"total":13,"covered":8,"skipped":0,"pct":61.53},"functions":{"total":3,"covered":1,"skipped":0,"pct":33.33},"branches":{"total":3,"covered":2,"skipped":0,"pct":66.66},"branchesTrue":{"total":0,"covered":0,"skipped":0,"pct":"Unknown"}}
,"/work/pkg/src/index.js": {"lines":{"total":11,"covered":8,"skipped":0,"pct":72.72},"functions":{"total":2,"covered":1,"skipped":0,"pct":50},"statements":{"total":11,"covered":8,"skipped":0,"pct":72.72},"branches":{"total":2,"covered":2,"skipped":0,"pct":100}}
,"/work/pkg/src/unloaded.js": {"lines":{"total":2,"covered":0,"skipped":0,"pct":0},"functions":{"total":1,"covered":0,"skipped":0,"pct":0},"statements":{"total":2,"covered":0,"skipped":0,"pct":0},"branches":{"total":1,"covered":0,"skipped":0,"pct":0}}
}`;

export const finalTwoFiles = `{"/work/pkg/src/index.js":{"path":"/work/pkg/src/index.js","fnMap":{"0":{"name":"add","decl":{"start":{"line":3,"column":9},"end":{"line":3,"column":12}},"loc":{"start":{"line":3,"column":0},"end":{"line":5,"column":1}}},"1":{"name":"subtract","decl":{"start":{"line":7,"column":9},"end":{"line":7,"column":17}},"loc":{"start":{"line":7,"column":0},"end":{"line":9,"column":1}}}},"f":{"0":1,"1":0}},
"/work/pkg/src/unloaded.js":{"path":"/work/pkg/src/unloaded.js","fnMap":{"0":{"name":"(anonymous_0)","decl":{"start":{"line":2,"column":10},"end":{"line":2,"column":20}},"loc":{"start":{"line":2,"column":10},"end":{"line":2,"column":40}}}},"f":{"0":0}}}`;

export function metricsByName(ms: readonly Metric[]): Map<string, Metric> {
  return new Map(ms.map((m) => [m.name, m]));
}

/**
 * stubCoverageStore replaces the Docker work of the shared coverage
 * location: it counts the volumes that were made and the reports that were
 * built.
 */
export function stubCoverageStore(
  t: TestContext,
  summary: string,
): { volumes: number; reports: number } {
  const n = { volumes: 0, reports: 0 };
  const restore = useCoverageHooks({
    createVolume: () => {
      n.volumes++;
      return Promise.resolve("coverage-volume");
    },
    buildReport: (_signal, input: Input) => {
      n.reports++;
      assert.equal(
        input.coverageVolume,
        "coverage-volume",
        "the report is built from the shared volume",
      );
      return Promise.resolve([
        Buffer.from(summary),
        Buffer.from(finalTwoFiles),
      ]);
    },
  });
  t.after(restore);
  return n;
}

/** allNullWithReason checks the three metrics of a package that was not measured. */
export function allNullWithReason(
  ms: readonly Metric[] | undefined,
  contains: string,
): void {
  assert.ok(ms);
  assert.equal(ms.length, 3, "lines, branches and functions");
  for (const m of ms) {
    assert.equal(m.value, null, m.name);
    assert.ok(
      m.reason?.includes(contains),
      `${m.name}: reason ${String(m.reason)} should hold ${contains}`,
    );
  }
}
