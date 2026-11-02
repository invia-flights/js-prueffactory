import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { sortStrings } from "../gocompat/strings.ts";
import {
  EnvRule,
  looksLikeSecret,
  secretRule,
  selectEnv,
} from "./envvalues.ts";
import { goOracle } from "./oracle.testutil.ts";

// The rule that decides which values of a .env file or a Service environment
// are secrets. See EnvRule.
const cases: [name: string, value: string, want: boolean, why: string][] = [
  // Ordinary values are not secrets, whatever the name.
  ["GREETING", "hello", false, "a word"],
  ["REGION", "eu-central-1", false, "a region"],
  ["DB_HOST", "db.internal.example", false, "a host name"],
  ["DB_HOST", "localhost:5432", false, "a host and a port"],
  ["API_URL", "https://api.example.com/v1", false, "a URL without credentials"],
  ["PATH_PREFIX", "/srv/app/storage", false, "a path"],
  ["DATA_DIR", "./var/data/cache", false, "a relative path"],
  ["PORT", "6379", false, "a port"],
  ["NODE_ENV", "production", false, "a plain word"],
  ["FLAG", "True", false, "a boolean in any case"],
  ["BIG_NUMBER", "1234567890", false, "a number"],
  ["MODE", "ProductionMode", false, "a word in two cases"],
  ["EMPTY", "", false, "empty"],
  ["APP_NAME", "my-service-name", false, "a name with hyphens"],
  ["BANNER", "hello brave new world 12", false, "words with spaces"],
  ["NODE_IMAGE", "node:22-alpine", false, "an image reference"],
  ["VERSION", "1.2.3-beta.1", false, "a version"],

  // The name suggests a secret.
  ["DB_PASSWORD", "hunter2", true, "password"],
  ["POSTGRES_PASSWD", "swordfish", true, "passwd"],
  ["API_TOKEN", "abcd1234", true, "token"],
  ["api_key", "plainword", true, "key in lower case"],
  ["STRIPE_SECRET", "sk", false, "below the minimum length"],
  [
    "CLIENT_SECRET",
    "my-secret-value",
    true,
    "a hyphenated value under a secret name",
  ],
  [
    "AWS_SECRET_ACCESS_KEY",
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    true,
    "base64 with slashes under a secret name",
  ],
  [
    "GOOGLE_CREDENTIALS",
    "eyJ0eXBlIjoic2VydmljZV9hY2NvdW50In0",
    true,
    "credentials",
  ],
  ["AUTH_HEADER", "Bearer abc123def456", true, "auth"],
  ["PRIVATE_THING", "s3cret-stuff", true, "private"],
  [
    "DB_PASSWORD",
    "12345678",
    true,
    "a digit-only password under a secret name",
  ],
  ["PASSWORD", "true", false, "a plain word is never a secret"],
  ["AUTH_ENABLED", "true", false, "a switch under a secret name"],
  [
    "AUTH_URL",
    "https://auth.example.com",
    true,
    "a URL under a secret name: the name decides",
  ],
  [
    "WEBHOOK_TOKEN",
    "https://hooks.example.com/T0123/B456/xyzSECRETpart",
    true,
    "a token inside a URL path under a secret name",
  ],
  [
    "API_KEY_URL",
    "https://api.example.com/v1?api_key=abcd1234efgh",
    true,
    "a token in a query under a secret name",
  ],
  [
    "SSH_KEY_FILE",
    "/home/app/.ssh/id_rsa",
    true,
    "a path under a secret name: the name decides",
  ],
  ["API_SECRET", "/Zk9sTq3vXw", true, "a secret that starts with a slash"],
  [
    "DATA_DIR",
    "https://cdn.example.com/assets",
    false,
    "a URL under an ordinary name",
  ],
  ["STATIC_ROOT", "/srv/app/static", false, "a path under an ordinary name"],

  // The value itself passes the floor.
  ["X", "ghp_9fK3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiA", true, "mixed classes"],
  ["X", "eyJhbGciOiJIUzI1NiJ9.e30.abc123DEF456", true, "a JWT"],
  ["DB_ARGS", "hunter2supersecret", true, "long token with a digit"],
  ["X", "3f2a9c1be47d58a06f12c3d4", true, "a hex token"],
  [
    "X",
    "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----",
    true,
    "a PEM block",
  ],
  ["X", "short1A!", false, "mixed classes but under 12 characters"],

  // A placeholder is left readable, even under a secret name, in any case.
  [
    "AWS_SECRET_ACCESS_KEY",
    "empty",
    false,
    "the word empty under a secret name",
  ],
  ["AWS_SECRET_ACCESS_KEY", "EMPTY", false, "a placeholder in upper case"],
  ["DB_PASSWORD", "changeme", false, "changeme"],
  ["DB_PASSWORD", "Change-Me", false, "change-me in mixed case"],
  ["DB_PASSWORD", "change_me", false, "change_me"],
  ["API_TOKEN", "placeholder", false, "placeholder"],
  ["API_KEY", "dummy", false, "dummy"],
  ["API_KEY", "example", false, "example"],
  ["API_KEY", "sample", false, "sample"],
  ["API_KEY", "secret", false, "secret"],
  ["API_KEY", "password", false, "password"],
  ["API_KEY", "n/a", false, "n/a (also below the minimum length)"],
  ["API_KEY", "unset", false, "unset"],
  ["API_KEY", "undefined", false, "undefined"],
  ["API_KEY", "default", false, "default"],
  ["API_KEY", "fake", false, "fake"],
  ["API_KEY", "mock", false, "mock"],
  ["API_KEY", "todo", false, "todo"],
  ["API_KEY", "TBD!", true, "a placeholder with other characters is not one"],
  ["API_KEY", "xxx", false, "xxx"],
  ["API_KEY", "XXXXXXXXXXXX", false, "a longer run of x"],
  ["API_KEY", "0000000000", false, "one repeated digit"],
  ["API_KEY", "********", false, "one repeated symbol"],
  [
    "API_KEY",
    "xxxxxxxxxxxy",
    true,
    "a run of x with another character is not a placeholder",
  ],
  ["API_KEY", "  empty  ", false, "a placeholder with white space around it"],
  [
    "API_KEY",
    "empty-value",
    true,
    "a placeholder inside a longer value is a secret under a secret name",
  ],
  [
    "API_KEY",
    "ghp_9fK3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiA",
    true,
    "a real-looking secret under a secret name",
  ],
  [
    "DB_URL",
    "postgres://app:empty@db:5432/app",
    true,
    "a URL with userinfo is never a placeholder",
  ],

  // A URL with a password in it.
  [
    "DB_URL",
    "postgres://app:s3cret@db:5432/app",
    true,
    "userinfo with a password",
  ],
  ["DB_URL", "postgres://app@db:5432/app", true, "userinfo without a password"],
  [
    "DB_URL",
    "postgres://user:pa:ss@db:5432/app",
    true,
    "a colon in the password",
  ],
  ["DB_URL", "postgres://user@@db:5432/app", true, "two @ in the authority"],
  [
    "DB_URL",
    "postgres://us/er:p@ss@db",
    false,
    "a / ends the authority: no @ in it",
  ],
  [
    "DB_URL",
    "https://example.com/users/a@b.example",
    false,
    "an @ after the authority is no userinfo",
  ],
  [
    "DB_URL",
    "https://example.com/p?mail=a@b.example#x@y",
    false,
    "an @ in query and fragment is no userinfo",
  ],
  [
    "MIRROR",
    "see https://u:pw99@mirror.example/x",
    true,
    "a URL inside a longer value",
  ],
  ["REDIS", "redis://:pw99@cache:6379", true, "an empty user and a password"],
];

describe("looksLikeSecret", () => {
  // Go: TestLooksLikeSecret
  for (const [name, value, want, why] of cases) {
    test(`${name}=${JSON.stringify(value)}: ${why}`, () => {
      assert.equal(looksLikeSecret(name, value), want);
    });
  }

  // Unicode case folding in (?i), Go's rune-wise ToLower and ToUpper, Go's
  // white space and lengths in bytes: the rule Go's build chose, per input.
  for (const c of goOracle.env) {
    test(`as the Go build decides: ${c.Name}=${JSON.stringify(c.Value)}`, () => {
      assert.equal(secretRule(c.Name, c.Value), c.Rule);
    });
  }

  // Go: TestEnvRuleNamesWhatDecides
  test("EnvRule names what decides", () => {
    for (const word of [
      "SECRET",
      "TOKEN",
      "PASSWORD",
      "KEY",
      "12 characters",
      "userinfo",
      "placeholder",
      "empty",
      "dummy",
      "changeme",
    ]) {
      assert.ok(EnvRule.includes(word), `EnvRule does not mention ${word}`);
    }
  });
});

describe("selectEnv", () => {
  // Go: TestSelectEnvRegistersOnlyValuesThatLookLikeSecrets
  test("registers only values that look like secrets", () => {
    const sel = selectEnv(
      new Map([
        ["GREETING", "hello"],
        ["DB_HOST", "db.internal.example"],
        ["PREFIX", "/srv/app"],
        ["POSTGRES_PW", "x"],
        ["DB_PASSWORD", "pw-for-tests"],
        ["DB_URL", "postgres://app:s3cret@db:5432/app"],
        ["EMPTY", ""],
      ]),
    );
    assert.deepEqual(
      [...sel.values].sort(),
      [
        "postgres://app:s3cret@db:5432/app",
        "pw-for-tests",
        "s3cret",
        "app:s3cret",
      ].sort(),
    );
    assert.deepEqual(sel.left, [
      "DB_HOST",
      "GREETING",
      "POSTGRES_PW",
      "PREFIX",
    ]);
  });

  // Go: TestEnvValuesAlsoReturnsTheNormalisedAndPerLineForms
  test("also returns the normalised and per-line forms", () => {
    // A log line shows a value the way the program printed it: whitespace may
    // be normalised and a multi-line value is printed line by line. Values
    // that are registered keep these forms.
    const got = selectEnv({
      CERT_PRIVATE_KEY: "line-one-secret\n  line-two-secret\r\n\nxy",
      SPACED_SECRET: "two  words\there",
    }).values;
    for (const want of [
      "line-one-secret\n  line-two-secret\r\n\nxy", // as written
      "line-one-secret line-two-secret xy", // as oneLine prints it
      "line-one-secret",
      "line-two-secret", // each line
      "two  words\there",
      "two words here",
    ]) {
      assert.ok(
        got.includes(want),
        `values = ${JSON.stringify(got)}, missing ${JSON.stringify(want)}`,
      );
    }
    assert.ok(!got.includes("xy"), "a two-character line must not be returned");
  });

  // Go: TestSelectEnvRegistersThePartsOfASecretURL
  test("registers the parts of a secret URL", () => {
    // A URL that holds a secret is also registered in parts, so that the
    // secret does not leak where a readable URL is printed without its
    // userinfo or query.
    const got = selectEnv({
      WEBHOOK_TOKEN:
        "https://hooks.example.com/services/T0123Abc9xYz/B456?token=abcd1234efgh&format=json#frag-ment9",
      DB_URL: "postgres://user:pa:ss@db:5432/app",
      ODD: "postgres://user@@db:5432/app",
    }).values;
    for (const want of [
      "T0123Abc9xYz", // token-like path segment
      "token=abcd1234efgh&format=json", // the query string
      "abcd1234efgh", // the value of a parameter with a secret name
      "frag-ment9", // the fragment
      "user:pa:ss",
      "pa:ss", // userinfo and the password after its first colon
      "user@", // userinfo of user@@host: split at the last @
    ]) {
      assert.ok(
        got.includes(want),
        `values = ${JSON.stringify(got)}, missing ${want}`,
      );
    }
    for (const v of got) {
      assert.ok(
        v !== "services" && v !== "json" && v !== "hooks.example.com",
        `${v} is an ordinary part and must not be registered`,
      );
    }
  });

  // Go: TestSelectEnvNamesTheRuleThatRegisteredEachValue
  test("names the rule that registered each value", () => {
    // Each registered value says which rule registered it, for the
    // diagnostics that explain a Report that failed validation. The name of
    // the variable is shown, never the value.
    const sel = selectEnv({
      DB_PASSWORD: "rootword",
      DB_URL: "postgres://user:pa:ss@db:5432/app",
      RANDOM_BLOB: "aB3dE6gH9jK2mN5p",
      PEM: "-----BEGIN PRIVATE KEY-----\nabcdef\n-----END PRIVATE KEY-----",
    });
    for (const [value, want] of [
      ["rootword", "env-secret-name (variable DB_PASSWORD)"],
      [
        "postgres://user:pa:ss@db:5432/app",
        "env-url-userinfo (variable DB_URL)",
      ],
      ["pa:ss", "env-url-userinfo (variable DB_URL)"],
      ["aB3dE6gH9jK2mN5p", "env-entropy (variable RANDOM_BLOB)"],
      [
        "-----BEGIN PRIVATE KEY-----\nabcdef\n-----END PRIVATE KEY-----",
        "env-pem-block (variable PEM)",
      ],
    ] as const) {
      assert.equal(sel.sources.get(value), want, value);
    }
    for (const [value, source] of sel.sources) {
      assert.ok(
        !(source.includes(value) && value.length > 4),
        `the source ${source} shows the value ${value}`,
      );
    }
  });

  // Byte-wise name order, Go's white space, multi-line values, URL parts.
  for (const [i, c] of goOracle.selectEnv.entries()) {
    test(`as the Go build selects: environment ${String(i + 1)}`, () => {
      const sel = selectEnv(new Map(Object.entries(c.Env)));
      assert.deepEqual(sel.values, c.Values ?? []);
      assert.deepEqual(Object.fromEntries(sel.sources), c.Sources);
      assert.deepEqual(sel.left, c.Left ?? []);
    });
  }

  test("takes a plain object without touching its prototype", () => {
    const env = JSON.parse(
      '{"__proto__":"aB3dE6gH9jK2mN5p","A":"hello"}',
    ) as Record<string, string>;
    const sel = selectEnv(env);
    assert.deepEqual(sel.values, ["aB3dE6gH9jK2mN5p"]);
    assert.deepEqual(sortStrings([...sel.left]), ["A"]);
  });
});

// The regular expressions of the rule run on project text, a .env value. They
// are anchored and have no ambiguous nested repetition, so a backtracking
// engine stays linear even on inputs built to make it slow. The search for
// URLs is linear too. (Registering the parts of a value with many URLs is not:
// each URL's parts run to the end of the value, in Go as here, so selectEnv is
// only timed on values with one URL.)
describe("the rule on adversarial input", () => {
  const long = 200_000;
  const inputs: [what: string, value: string, select: boolean][] = [
    ["hostLike", "a.".repeat(long / 2) + "!", true],
    ["hostLike", "a".repeat(long) + ".", true],
    ["hostLike", "a-".repeat(long / 2) + "-", true],
    ["plainValue", "1".repeat(long) + "x", true],
    ["placeholderWord", "x".repeat(long) + "y", true],
    ["alnum", "aB1".repeat(long / 3) + "!", true],
    ["URL authorities", "a://b@".repeat(long / 6), false],
    ["URL authorities", "://".repeat(long / 3), false],
    ["URL authorities", "x://" + "@".repeat(long), true],
    [
      "URL parts",
      "x://u:p@h/" + "a/".repeat(long / 2) + "?" + "k=v&".repeat(long / 4),
      true,
    ],
    ["lines", "line\r\n".repeat(long / 6), true],
  ];
  for (const [what, value, select] of inputs) {
    test(`${what}: ${String(value.length)} characters in under a second`, () => {
      const start = performance.now();
      for (const name of ["X", "API_KEY"]) {
        looksLikeSecret(name, value);
        if (select) {
          selectEnv({ [name]: value });
        }
      }
      const ms = performance.now() - start;
      assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
    });
  }
});
