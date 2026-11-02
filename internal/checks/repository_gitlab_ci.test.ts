// repository.gitlab-ci runs natively, so these tests run it on made-up
// projects without Docker (Go: repository_gitlab_ci_test.go,
// repository_gitlab_ci_includes_test.go, repository_gitlab_ci_refs_test.go,
// repository_gitlab_ci_untrusted_test.go, repository_gitlab_ci_bomb_test.go).
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";

import { discover } from "../discovery/discovery.ts";
import { background } from "../gocompat/context.ts";
import {
  type Applicability,
  Applicable,
  type Finding,
  NotApplicable,
  SeverityError,
  SeverityNote,
  StatusCompleted,
  TrustUntrusted,
} from "../resultset/types.ts";
import { Implemented, lookup, PerProject } from "./catalog.ts";
import type { Result } from "./check.ts";
import { projectContext, writeTree } from "./checks.testutil.ts";
import { Input } from "./input.ts";
import { gitlabCI } from "./repository_gitlab_ci.ts";

const gitlabCIID = "repository.gitlab-ci";

interface GitlabRun {
  applicability: Applicability;
  reason: string;
  result: Result | null;
}

async function runGitlabCI(
  t: TestContext,
  files: Record<string, string>,
): Promise<GitlabRun> {
  const dir = writeTree(t, files);
  const proj = discover(dir);
  const ctx = projectContext(proj);
  const [applicability, reason] = gitlabCI.applicability(proj, ctx);
  if (applicability === NotApplicable) {
    return { applicability, reason, result: null };
  }
  assert.ok(gitlabCI.run);
  const result = await gitlabCI.run(
    background(),
    new Input({ project: proj, context: ctx, originalPath: dir, snapshotDir: dir }),
  );
  return { applicability, reason, result };
}

function findings(r: GitlabRun): Finding[] {
  assert.ok(r.result, `the Check was not applicable: ${r.reason}`);
  return r.result.findings ?? [];
}

function byRule(r: GitlabRun, rule: string): Finding[] {
  return findings(r).filter((f) => f.rule_id === rule);
}

function gates(r: GitlabRun): number {
  return findings(r).filter((f) => f.gate).length;
}

function line(f: Finding | undefined): number | undefined {
  return f?.locations[0]?.start?.line;
}

function assertClean(r: GitlabRun): void {
  assert.ok(r.result, `the Check was not applicable: ${r.reason}`);
  assert.equal(r.result.status, StatusCompleted, r.result.reason);
  assert.deepEqual(r.result.findings ?? [], []);
  assert.deepEqual(r.result.limitations ?? [], []);
}

const validPipeline = `stages:
  - build
  - test

build:
  stage: build
  script:
    - make

test:
  stage: test
  needs: [build]
  script:
    - make test
`;

describe("the Check", () => {
  test("is a Gate Check in the validity area for the project", () => {
    const e = lookup(gitlabCIID);
    assert.ok(e);
    assert.equal(e.status, Implemented);
    assert.equal(e.scope, PerProject);
    assert.equal(e.canFireGates, true);
    assert.equal(e.area, "validity");
  });

  test("applies only with a pipeline file at the project root", async (t) => {
    assert.equal(
      (await runGitlabCI(t, { "package.json": "{}" })).applicability,
      NotApplicable,
    );
    assert.equal(
      (await runGitlabCI(t, { "ci/.gitlab-ci.yml": validPipeline })).applicability,
      NotApplicable,
    );
    assert.equal(
      (await runGitlabCI(t, { ".gitlab-ci.yml": validPipeline })).applicability,
      Applicable,
    );
  });

  test("a valid pipeline has no Findings and records the schema hash", async (t) => {
    const r = await runGitlabCI(t, { ".gitlab-ci.yml": validPipeline });
    assertClean(r);
    const schema = r.result?.contextTools?.find((c) => c.name === "gitlab-ci-schema");
    assert.ok(schema);
    assert.equal(schema.digest?.length, 64);
    assert.ok(schema.version.startsWith("18.5.0"));
  });

  test("a schema error is a Gate at the offending line", async (t) => {
    const r = await runGitlabCI(t, {
      ".gitlab-ci.yml": "test:\n  script: make\n  allow_failure: perhaps\n",
    });
    const got = byRule(r, "gitlab-ci.schema");
    assert.equal(got.length, 1);
    const f = got[0] as Finding;
    assert.equal(f.gate, true);
    assert.equal(f.severity, SeverityError);
    assert.equal(f.confidence, "confirmed");
    assert.equal(f.check_id, gitlabCIID);
    assert.equal(f.locations[0]?.path, ".gitlab-ci.yml");
    assert.equal(line(f), 3);
    assert.ok(f.evidence[0]?.text.includes("/test/allow_failure"));
  });
});

describe("includes", () => {
  test("an error in a local include is reported in the included file", async (t) => {
    const r = await runGitlabCI(t, {
      ".gitlab-ci.yml": "include: ci/deploy.yml\n\nstages: [deploy]\n",
      "ci/deploy.yml": "deploy:\n  stage: deploy\n  script: make\n  retry: lots\n",
      "ci/unrelated.yml": "this: [is, not, included",
    });
    const got = byRule(r, "gitlab-ci.schema");
    assert.equal(got.length, 1);
    assert.equal(got[0]?.gate, true);
    assert.equal(got[0]?.locations[0]?.path, "ci/deploy.yml");
    assert.equal(line(got[0]), 4);
  });

  test("every form of a local include is resolved recursively", async (t) => {
    const job = (name: string): string => `${name}:\n  script: make\n  retry: lots\n`;
    const r = await runGitlabCI(t, {
      ".gitlab-ci.yml":
        "include:\n  - /ci/a.yml\n  - local: ci/b.yml\n  - local: ci/many/*.yml\n  - ci/deep/**/*.yml\n",
      "ci/a.yml": "include: 'ci/nested.yml'\n" + job("a"),
      "ci/nested.yml": "include: ci/a.yml\n" + job("nested"), // a cycle
      "ci/b.yml": job("b"),
      "ci/many/one.yml": job("one"),
      "ci/many/two.yml": job("two"),
      "ci/many/skip.txt": "not yaml",
      "ci/many/sub/three.yml": "broken: [",
      "ci/deep/x/y/four.yml": job("four"),
    });
    assert.equal(
      byRule(r, "gitlab-ci.schema")
        .map((f) => f.locations[0]?.path)
        .join(" "),
      "ci/a.yml ci/b.yml ci/deep/x/y/four.yml ci/many/one.yml ci/many/two.yml ci/nested.yml",
    );
  });

  test("a missing local include is a Gate at the include line", async (t) => {
    const r = await runGitlabCI(t, {
      ".gitlab-ci.yml":
        "stages: [test]\ninclude:\n  - local: ci/there.yml\n  - local: ci/missing.yml\n  - ci/nothing/*.yml\n",
      "ci/there.yml": "test:\n  script: make\n",
    });
    const got = byRule(r, "gitlab-ci.include-missing");
    assert.equal(got.length, 2);
    assert.equal(gates(r), 2);
    assert.equal(got[0]?.locations[0]?.path, ".gitlab-ci.yml");
    assert.equal(line(got[0]), 4);
    assert.ok(got[0]?.message.includes("ci/missing.yml"));
    assert.equal(line(got[1]), 5);
    assert.ok(got[1]?.message.includes("ci/nothing/*.yml"));
    assert.equal(r.result?.status, StatusCompleted);
  });

  test("includes outside the Snapshot are never followed", async (t) => {
    const r = await runGitlabCI(t, {
      ".gitlab-ci.yml":
        "include:\n  - local: ../../../../etc/passwd\n  - local: /../outside.yml\n",
    });
    assert.equal(byRule(r, "gitlab-ci.include-missing").length, 2);
  });

  test("includes that need the network are Limitations and the Run stays completed", async (t) => {
    const r = await runGitlabCI(t, {
      ".gitlab-ci.yml": `include:
  - remote: https://example.com/ci/shared.yml
  - https://example.com/ci/plain.yml
  - project: group/templates
    ref: main
    file: /ci/build.yml
  - template: Jobs/Build.gitlab-ci.yml
  - component: example.org/group/components/lint@1.0
  - local: ci/\${ENVIRONMENT}.yml
test:
  script: make
`,
    });
    assert.equal(r.result?.status, StatusCompleted);
    assert.deepEqual(findings(r), []);
    const limitations = r.result?.limitations ?? [];
    assert.equal(limitations.length, 6);
    for (const l of limitations) {
      assert.equal(l.reason_code, "include_not_resolved");
      assert.equal(l.check_id, gitlabCIID);
      assert.equal(l.path, ".gitlab-ci.yml");
    }
    [
      "https://example.com/ci/shared.yml",
      "https://example.com/ci/plain.yml",
      "group/templates",
      "Jobs/Build.gitlab-ci.yml",
      "example.org/group/components/lint@1.0",
      "ci/${ENVIRONMENT}.yml",
    ].forEach((want, i) => {
      assert.ok(limitations[i]?.message.includes(want), want);
    });
  });

  test("a !reference tag is read as a list of strings and a schema error at it is a note", async (t) => {
    const r = await runGitlabCI(t, {
      ".gitlab-ci.yml": `.setup:
  script:
    - echo setup
test:
  script:
    - !reference [.setup, script]
    - echo done
  image: !reference [.setup, image]
`,
    });
    const notes = byRule(r, "gitlab-ci.schema");
    assert.equal(gates(r), 0);
    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.severity, SeverityNote);
    assert.equal(line(notes[0]), 8);
  });
});

describe("job and stage references", () => {
  test("references to jobs and hidden jobs in any resolved file are accepted", async (t) => {
    const r = await runGitlabCI(t, {
      ".gitlab-ci.yml": `include: ci/jobs.yml
stages: [build, test]
.template:
  script: make
build:
  extends: [.template, .shared]
  stage: build
test:
  extends: .template
  stage: test
  dependencies: [build, packaged]
  needs:
    - build
    - job: packaged
      artifacts: true
`,
      "ci/jobs.yml": "packaged:\n  stage: build\n  script: make\n.shared:\n  variables:\n    A: b\n",
    });
    assertClean(r);
  });

  test("needs, dependencies and extends must name existing jobs", async (t) => {
    const r = await runGitlabCI(t, {
      ".gitlab-ci.yml": `stages: [build, test]
build:
  stage: build
  script: make
test:
  stage: test
  script: make test
  extends: .tmeplate
  dependencies: [buidl]
  needs:
    - buidl
    - job: bulid
      optional: true
    - job: elsewhere
      pipeline: "123"
`,
    });
    const got = byRule(r, "gitlab-ci.unknown-job");
    assert.equal(got.length, 3);
    assert.equal(gates(r), 3);
    [
      [8, ".tmeplate"],
      [9, "buidl"],
      [11, "buidl"],
    ].forEach(([l, text], i) => {
      assert.equal(line(got[i]), l);
      assert.ok(got[i]?.message.includes(String(text)));
      assert.equal(got[i]?.gate, true);
    });
    for (const key of ["extends", "dependencies", "needs"]) {
      assert.ok(got.some((f) => f.message.includes(key)), key);
    }
  });

  test("a stage must be declared or be a default stage", async (t) => {
    let r = await runGitlabCI(t, {
      ".gitlab-ci.yml":
        "stages: [build]\na:\n  stage: build\n  script: make\nb:\n  stage: deploy\n  script: make\nc:\n  stage: .pre\n  script: make\n",
    });
    let got = byRule(r, "gitlab-ci.unknown-stage");
    assert.equal(got.length, 1);
    assert.equal(got[0]?.gate, true);
    assert.equal(line(got[0]), 6);
    assert.ok(got[0]?.message.includes("deploy"));

    r = await runGitlabCI(t, {
      ".gitlab-ci.yml": "a:\n  stage: test\n  script: make\nb:\n  stage: publish\n  script: make\n",
    });
    got = byRule(r, "gitlab-ci.unknown-stage");
    assert.equal(got.length, 1);
    assert.ok(got[0]?.message.includes("publish"));
  });

  test("while an include is unresolved, unknown jobs are only notes", async (t) => {
    const r = await runGitlabCI(t, {
      ".gitlab-ci.yml": `include:
  - remote: https://example.com/ci/shared.yml
stages: [build]
build:
  stage: build
  extends: .from-remote
  script: make
  needs: [from-remote]
  dependencies: [also-remote]
`,
    });
    const got = byRule(r, "gitlab-ci.unknown-job");
    assert.equal(got.length, 3);
    assert.equal(gates(r), 0);
    for (const f of got) assert.equal(f.severity, SeverityNote);
    assert.equal(r.result?.limitations?.length, 1);
    assert.equal(r.result?.status, StatusCompleted);
  });

  test("while an include is unresolved, a stage is only a note if no file declares stages", async (t) => {
    const remote = "include:\n  - remote: https://example.com/ci/shared.yml\n";
    let r = await runGitlabCI(t, {
      ".gitlab-ci.yml": remote + "a:\n  stage: from-remote\n  script: make\n",
    });
    let got = byRule(r, "gitlab-ci.unknown-stage");
    assert.equal(got.length, 1);
    assert.equal(got[0]?.gate, false);
    r = await runGitlabCI(t, {
      ".gitlab-ci.yml": remote + "stages: [build]\na:\n  stage: from-remote\n  script: make\n",
    });
    got = byRule(r, "gitlab-ci.unknown-stage");
    assert.equal(got.length, 1);
    assert.equal(got[0]?.gate, true);
  });

  test("a missing local include does not make references notes", async (t) => {
    const r = await runGitlabCI(t, {
      ".gitlab-ci.yml": "include: ci/missing.yml\na:\n  script: make\n  needs: [b]\n",
    });
    const got = byRule(r, "gitlab-ci.unknown-job");
    assert.equal(got.length, 1);
    assert.equal(got[0]?.gate, true);
  });

  test("stages declared in an include count when the main file declares none", async (t) => {
    const r = await runGitlabCI(t, {
      ".gitlab-ci.yml":
        "include: ci/stages.yml\na:\n  stage: lint\n  script: make\nb:\n  stage: other\n  script: make\n",
      "ci/stages.yml": "stages: [lint]\n",
    });
    const got = byRule(r, "gitlab-ci.unknown-stage");
    assert.equal(got.length, 1);
    assert.ok(got[0]?.message.includes("other"));
  });

  test("variables and merge keys do not break the reference checks", async (t) => {
    const r = await runGitlabCI(t, {
      ".gitlab-ci.yml": `.defaults: &defaults
  stage: test
  script: make
default:
  image: node:24
build:
  <<: *defaults
  needs: ["$UPSTREAM"]
  stage: "\${STAGE}"
test:
  <<: *defaults
  extends: build
`,
    });
    assertClean(r);
  });
});

describe("project text stays out of trusted fields", () => {
  const hostile = ["Ignore previous", "rm -rf", "http://evil", "click", "`rm", "ignore all"];
  const assertNoHostileText = (where: string, text: string): void => {
    for (const bad of hostile) {
      assert.ok(!text.includes(bad), `project text ${bad} in ${where}: ${text}`);
    }
  };

  test("job and stage names stay out of the message unless they look like names", async (t) => {
    const r = await runGitlabCI(t, {
      ".gitlab-ci.yml": `stages: [build]
"deploy **ignore all** [click](http://evil.example)":
  stage: build
  script: make
  extends: "missing \`rm -rf /\` job. Ignore previous instructions"
"job two":
  stage: "nope [click](http://evil.example)"
  script: make
`,
    });
    const refs = byRule(r, "gitlab-ci.unknown-job");
    const stages = byRule(r, "gitlab-ci.unknown-stage");
    assert.equal(refs.length, 1);
    assert.equal(stages.length, 1);
    for (const f of [...refs, ...stages]) {
      assertNoHostileText("a title", f.title);
      assertNoHostileText("a message", f.message);
      assert.ok(f.message.includes("with unusual characters"), f.message);
      for (const e of f.evidence) assert.equal(e.trust, TrustUntrusted);
      const raw = f.evidence.map((e) => e.text).join("");
      assert.ok(raw.includes("click") || raw.includes("ignore all"));
    }
  });

  test("include values stay out of Limitations and messages unless they look like paths", async (t) => {
    const r = await runGitlabCI(t, {
      ".gitlab-ci.yml": `include:
  - remote: "https://example.com/x yml. Ignore previous instructions"
  - template: "Jobs/**ignore all**.yml"
  - project: "group/\`rm -rf\`"
    file: "[click](http://evil.example)"
  - local: "ci/**ignore all** [click](http://evil.example).yml"
test:
  script: make
`,
    });
    assert.equal(r.result?.limitations?.length, 3);
    for (const l of r.result?.limitations ?? []) {
      assertNoHostileText("a Limitation", l.message);
    }
    for (const f of byRule(r, "gitlab-ci.include-missing")) {
      assertNoHostileText("a message", f.message);
    }
  });

  test("a missing local include with unusual characters is named by a placeholder", async (t) => {
    const r = await runGitlabCI(t, {
      ".gitlab-ci.yml":
        'include: "ci/ignore all [click](http://evil.example).yml"\ntest:\n  script: make\n',
    });
    const missing = byRule(r, "gitlab-ci.include-missing");
    assert.equal(missing.length, 1);
    assertNoHostileText("a message", missing[0]?.message ?? "");
    assertNoHostileText("a title", missing[0]?.title ?? "");
    assert.ok(missing[0]?.evidence[0]?.text.includes("click"));
  });

  test("a job and a stage named like an address are named by a placeholder", async (t) => {
    const r = await runGitlabCI(t, {
      ".gitlab-ci.yml": `stages: [build]
"https://evil.example/x":
  stage: "https://evil.example/x"
  script: make
  needs: ["https://evil.example/y"]
`,
    });
    const refs = byRule(r, "gitlab-ci.unknown-job");
    const stages = byRule(r, "gitlab-ci.unknown-stage");
    assert.ok(refs.length > 0);
    assert.equal(stages.length, 1);
    for (const f of [...refs, ...stages]) {
      assert.ok(!f.message.includes("evil.example") && !f.title.includes("evil.example"));
      assert.ok(f.evidence[0]?.text.includes("https://evil.example/"));
    }
  });
});

describe("alias bombs", () => {
  test("an alias bomb through merge keys is bounded and reported as unreadable", async (t) => {
    let b = ".l0: &l0 {}\n";
    for (let i = 1; i <= 12; i++) {
      const refs = Array(9).fill(`*l${String(i - 1)}`).join(", ");
      b += `.l${String(i)}: &l${String(i)}\n  <<: [${refs}]\n`;
    }
    b += "test:\n  script: make\n";
    const start = Date.now();
    const r = await runGitlabCI(t, { ".gitlab-ci.yml": b });
    assert.ok(Date.now() - start < 30_000, `took ${String(Date.now() - start)} ms`);
    const got = byRule(r, "gitlab-ci.yaml");
    assert.equal(got.length, 1);
    assert.equal(got[0]?.gate, true);
    assert.ok(got[0]?.evidence[0]?.text.includes("YAML nodes"));
  });

  test("an alias bomb through plain aliases is bounded", async (t) => {
    let b = "a0: &a0 [x, x, x, x, x, x, x, x, x]\n";
    for (let i = 1; i <= 12; i++) {
      const refs = Array(9).fill(`*a${String(i - 1)}`).join(", ");
      b += `a${String(i)}: &a${String(i)} [${refs}]\n`;
    }
    const start = Date.now();
    const r = await runGitlabCI(t, { ".gitlab-ci.yml": b });
    assert.ok(Date.now() - start < 30_000, `took ${String(Date.now() - start)} ms`);
    assert.equal(byRule(r, "gitlab-ci.yaml").length, 1);
  });
});
