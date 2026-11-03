// The test Services of a suite without Docker (Go: services_test.go).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ComposeService,
  type Context,
  Project,
} from "../discovery/discovery.ts";
import {
  ServiceBlocked,
  ServiceNotStarted,
  StatusBlocked,
} from "../resultset/types.ts";
import { newContext } from "../resultset/zero.ts";
import { Input } from "./input.ts";
import {
  redactedLogTail,
  testServices,
  unresolvedServices,
} from "./services.ts";
import { utf8Length } from "../gocompat/strings.ts";

function service(fields: Partial<ComposeService>): ComposeService {
  return {
    name: "",
    file: "",
    declared: "",
    family: "",
    notStarted: null,
    env: null,
    unresolved: [],
    versionDiffers: false,
    definedIn: "",
    build: false,
    command: null,
    entrypoint: null,
    dependsOn: [],
    ...fields,
  };
}

function inputWithServices(...services: ComposeService[]): Input {
  const project = new Project("/p");
  project.services = services;
  const context: Context = { ...newContext({ id: "C-0002" }), package: null };
  return new Input({ project, context });
}

function redactWith(...secrets: string[]): (s: string) => string {
  return (s) => {
    for (const v of secrets) s = s.replaceAll(v, "[REDACTED]");
    return s;
  };
}

// The log is redacted whole, before it is cut and its whitespace is
// normalised, so a secret that the cut or the normalising would have changed
// is still found.
test("a Service log is redacted before it is cut at the tail boundary", () => {
  const secret = "hunter2-straddles-the-boundary";
  // A cut of the raw text at its last 400 characters would end inside the
  // secret and leave "...the-boundary" behind.
  const logs =
    "head\n" + "y".repeat(10) + secret + "\n" + "z".repeat(380) + "\n";

  const got = redactedLogTail(logs, redactWith(secret), 400);

  for (const part of ["hunter2", "straddles", "boundary"]) {
    assert.ok(!got.includes(part), `tail ${got} leaks part of the secret`);
  }
  assert.ok(utf8Length(got) <= 400);
  assert.ok(got.endsWith("z".repeat(380)));

  // With room for it, the redacted line stays and shows the placeholder.
  const short = "head\n" + "y".repeat(10) + secret + "\nlast line\n";
  const tail = redactedLogTail(short, redactWith(secret), 400);
  assert.ok(tail.includes("yyyyyyyyyy[REDACTED]"), tail);
  assert.ok(tail.endsWith("last line"));
});

test("the tail is cut at a line boundary", () => {
  const logs =
    "d".repeat(60) + "\n" + "a".repeat(200) + "\n" + "b".repeat(150) + "\n";
  assert.equal(
    redactedLogTail(logs, redactWith(), 400),
    "a".repeat(200) + " " + "b".repeat(150),
  );
});

test("a multi-line secret is redacted before whitespace is normalised", () => {
  const secret = "-----BEGIN KEY-----\nabcdefgh\n-----END KEY-----";
  const got = redactedLogTail(
    "starting\nthe key is " + secret + "\ndone\n",
    redactWith(secret),
    400,
  );
  assert.ok(!got.includes("abcdefgh"));
  assert.ok(got.includes("the key is [REDACTED]"), got);
});

test("a long last line is still shortened after redaction", () => {
  assert.equal(
    redactedLogTail("z".repeat(1000), redactWith(), 400).length,
    400,
  );
});

test("a cut inside a character keeps Go's bytes, one U+FFFD per byte cut off", () => {
  // Go: text[len(text)-max:] of "ä" + 399 x's starts with the second byte of ä.
  assert.equal(
    redactedLogTail("ä" + "x".repeat(399), null, 400),
    "�" + "x".repeat(399),
  );
});

test("only startable Services are test Services", () => {
  const p = new Project("/p");
  p.services = [
    service({ name: "a", family: "valkey" }),
    service({
      name: "b",
      family: "valkey",
      notStarted: { code: "build_section", reason: "" },
    }),
    service({ name: "c" }),
  ];
  assert.deepEqual(
    testServices(p).map((s) => s.name),
    ["a"],
  );
});

test("a suite with an unresolved variable is blocked without Docker", () => {
  const input = inputWithServices(
    service({
      name: "db",
      family: "postgres",
      declared: "postgres:17",
      unresolved: ["DB_PASSWORD"],
    }),
    service({ name: "redis", family: "valkey", declared: "valkey/valkey:8.1" }),
  );

  const res = unresolvedServices(input);

  assert.ok(res);
  assert.equal(res.status, StatusBlocked);
  assert.equal(res.reasonCode, "service_variable_unresolved");
  assert.ok(res.reason?.includes("DB_PASSWORD"));
  const byName = new Map(
    (res.services ?? []).map((s) => [s.compose_service, s]),
  );
  assert.equal(byName.get("db")?.status, ServiceBlocked);
  assert.equal(byName.get("redis")?.status, ServiceNotStarted);
  assert.deepEqual(byName.get("db")?.context_ids, ["C-0002"]);
});

test("a suite with resolved Services is not blocked", () => {
  const input = inputWithServices(service({ name: "redis", family: "valkey" }));
  assert.equal(unresolvedServices(input), null);
});
