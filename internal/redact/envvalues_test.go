package redact_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/redact"
)

// The rule that decides which values of a .env file or a Service environment
// are secrets. See redact.EnvRule.
func TestLooksLikeSecret(t *testing.T) {
	tests := []struct {
		name, value string
		want        bool
		why         string
	}{
		// Ordinary values are not secrets, whatever the name.
		{"GREETING", "hello", false, "a word"},
		{"REGION", "eu-central-1", false, "a region"},
		{"DB_HOST", "db.internal.example", false, "a host name"},
		{"DB_HOST", "localhost:5432", false, "a host and a port"},
		{"API_URL", "https://api.example.com/v1", false, "a URL without credentials"},
		{"PATH_PREFIX", "/srv/app/storage", false, "a path"},
		{"DATA_DIR", "./var/data/cache", false, "a relative path"},
		{"PORT", "6379", false, "a port"},
		{"NODE_ENV", "production", false, "a plain word"},
		{"FLAG", "True", false, "a boolean in any case"},
		{"BIG_NUMBER", "1234567890", false, "a number"},
		{"MODE", "ProductionMode", false, "a word in two cases"},
		{"EMPTY", "", false, "empty"},
		{"APP_NAME", "my-service-name", false, "a name with hyphens"},
		{"BANNER", "hello brave new world 12", false, "words with spaces"},
		{"NODE_IMAGE", "node:22-alpine", false, "an image reference"},
		{"VERSION", "1.2.3-beta.1", false, "a version"},

		// The name suggests a secret.
		{"DB_PASSWORD", "hunter2", true, "password"},
		{"POSTGRES_PASSWD", "swordfish", true, "passwd"},
		{"API_TOKEN", "abcd1234", true, "token"},
		{"api_key", "plainword", true, "key in lower case"},
		{"STRIPE_SECRET", "sk", false, "below the minimum length"},
		{"CLIENT_SECRET", "my-secret-value", true, "a hyphenated value under a secret name"},
		{"AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", true, "base64 with slashes under a secret name"},
		{"GOOGLE_CREDENTIALS", "eyJ0eXBlIjoic2VydmljZV9hY2NvdW50In0", true, "credentials"},
		{"AUTH_HEADER", "Bearer abc123def456", true, "auth"},
		{"PRIVATE_THING", "s3cret-stuff", true, "private"},
		{"DB_PASSWORD", "12345678", true, "a digit-only password under a secret name"},
		{"PASSWORD", "true", false, "a plain word is never a secret"},
		{"AUTH_ENABLED", "true", false, "a switch under a secret name"},
		{"AUTH_URL", "https://auth.example.com", true, "a URL under a secret name: the name decides"},
		{"WEBHOOK_TOKEN", "https://hooks.example.com/T0123/B456/xyzSECRETpart", true, "a token inside a URL path under a secret name"},
		{"API_KEY_URL", "https://api.example.com/v1?api_key=abcd1234efgh", true, "a token in a query under a secret name"},
		{"SSH_KEY_FILE", "/home/app/.ssh/id_rsa", true, "a path under a secret name: the name decides"},
		{"API_SECRET", "/Zk9sTq3vXw", true, "a secret that starts with a slash"},
		{"DATA_DIR", "https://cdn.example.com/assets", false, "a URL under an ordinary name"},
		{"STATIC_ROOT", "/srv/app/static", false, "a path under an ordinary name"},

		// The value itself passes the floor.
		{"X", "ghp_9fK3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiA", true, "mixed classes"},
		{"X", "eyJhbGciOiJIUzI1NiJ9.e30.abc123DEF456", true, "a JWT"},
		{"DB_ARGS", "hunter2supersecret", true, "long token with a digit"},
		{"X", "3f2a9c1be47d58a06f12c3d4", true, "a hex token"},
		{"X", "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----", true, "a PEM block"},
		{"X", "short1A!", false, "mixed classes but under 12 characters"},

		// A placeholder is left readable, even under a secret name, in any case.
		{"AWS_SECRET_ACCESS_KEY", "empty", false, "the word empty under a secret name"},
		{"AWS_SECRET_ACCESS_KEY", "EMPTY", false, "a placeholder in upper case"},
		{"DB_PASSWORD", "changeme", false, "changeme"},
		{"DB_PASSWORD", "Change-Me", false, "change-me in mixed case"},
		{"DB_PASSWORD", "change_me", false, "change_me"},
		{"API_TOKEN", "placeholder", false, "placeholder"},
		{"API_KEY", "dummy", false, "dummy"},
		{"API_KEY", "example", false, "example"},
		{"API_KEY", "sample", false, "sample"},
		{"API_KEY", "secret", false, "secret"},
		{"API_KEY", "password", false, "password"},
		{"API_KEY", "n/a", false, "n/a (also below the minimum length)"},
		{"API_KEY", "unset", false, "unset"},
		{"API_KEY", "undefined", false, "undefined"},
		{"API_KEY", "default", false, "default"},
		{"API_KEY", "fake", false, "fake"},
		{"API_KEY", "mock", false, "mock"},
		{"API_KEY", "todo", false, "todo"},
		{"API_KEY", "TBD!", true, "a placeholder with other characters is not one"},
		{"API_KEY", "xxx", false, "xxx"},
		{"API_KEY", "XXXXXXXXXXXX", false, "a longer run of x"},
		{"API_KEY", "0000000000", false, "one repeated digit"},
		{"API_KEY", "********", false, "one repeated symbol"},
		{"API_KEY", "xxxxxxxxxxxy", true, "a run of x with another character is not a placeholder"},
		{"API_KEY", "  empty  ", false, "a placeholder with white space around it"},
		{"API_KEY", "empty-value", true, "a placeholder inside a longer value is a secret under a secret name"},
		{"API_KEY", "ghp_9fK3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiA", true, "a real-looking secret under a secret name"},
		{"DB_URL", "postgres://app:empty@db:5432/app", true, "a URL with userinfo is never a placeholder"},

		// A URL with a password in it.
		{"DB_URL", "postgres://app:s3cret@db:5432/app", true, "userinfo with a password"},
		{"DB_URL", "postgres://app@db:5432/app", true, "userinfo without a password"},
		{"DB_URL", "postgres://user:pa:ss@db:5432/app", true, "a colon in the password"},
		{"DB_URL", "postgres://user@@db:5432/app", true, "two @ in the authority"},
		{"DB_URL", "postgres://us/er:p@ss@db", false, "a / ends the authority: no @ in it"},
		{"DB_URL", "https://example.com/users/a@b.example", false, "an @ after the authority is no userinfo"},
		{"DB_URL", "https://example.com/p?mail=a@b.example#x@y", false, "an @ in query and fragment is no userinfo"},
		{"MIRROR", "see https://u:pw99@mirror.example/x", true, "a URL inside a longer value"},
		{"REDIS", "redis://:pw99@cache:6379", true, "an empty user and a password"},
	}
	for _, tt := range tests {
		if got := redact.LooksLikeSecret(tt.name, tt.value); got != tt.want {
			t.Errorf("LooksLikeSecret(%q, %q) = %v, want %v (%s)", tt.name, tt.value, got, tt.want, tt.why)
		}
	}
}

func TestEnvRuleNamesWhatDecides(t *testing.T) {
	for _, word := range []string{"SECRET", "TOKEN", "PASSWORD", "KEY", "12 characters", "userinfo", "placeholder", "empty", "dummy", "changeme"} {
		if !strings.Contains(redact.EnvRule, word) {
			t.Errorf("EnvRule does not mention %q: %s", word, redact.EnvRule)
		}
	}
}

func TestSelectEnvRegistersOnlyValuesThatLookLikeSecrets(t *testing.T) {
	sel := redact.SelectEnv(map[string]string{
		"GREETING":    "hello",
		"DB_HOST":     "db.internal.example",
		"PREFIX":      "/srv/app",
		"POSTGRES_PW": "x",
		"DB_PASSWORD": "pw-for-tests",
		"DB_URL":      "postgres://app:s3cret@db:5432/app",
		"EMPTY":       "",
	})
	got := slices.Clone(sel.Values)
	slices.Sort(got)
	want := []string{"postgres://app:s3cret@db:5432/app", "pw-for-tests", "s3cret", "app:s3cret"}
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("Values = %q, want %q", got, want)
	}
	if want := []string{"DB_HOST", "GREETING", "POSTGRES_PW", "PREFIX"}; !slices.Equal(sel.Left, want) {
		t.Errorf("Left = %q, want %q", sel.Left, want)
	}
}

// A log line shows a value the way the program printed it: whitespace may be
// normalised and a multi-line value is printed line by line. Values that are
// registered keep these forms.
func TestEnvValuesAlsoReturnsTheNormalisedAndPerLineForms(t *testing.T) {
	got := redact.SelectEnv(map[string]string{
		"CERT_PRIVATE_KEY": "line-one-secret\n  line-two-secret\r\n\nxy",
		"SPACED_SECRET":    "two  words\there",
	}).Values
	for _, want := range []string{
		"line-one-secret\n  line-two-secret\r\n\nxy", // as written
		"line-one-secret line-two-secret xy",         // as oneLine prints it
		"line-one-secret", "line-two-secret",         // each line
		"two  words\there", "two words here",
	} {
		if !slices.Contains(got, want) {
			t.Errorf("Values = %q, missing %q", got, want)
		}
	}
	if slices.Contains(got, "xy") {
		t.Errorf("a two-character line must not be returned: %q", got)
	}
}

// A URL that holds a secret is also registered in parts, so that the secret
// does not leak where a readable URL is printed without its userinfo or query.
func TestSelectEnvRegistersThePartsOfASecretURL(t *testing.T) {
	got := redact.SelectEnv(map[string]string{
		"WEBHOOK_TOKEN": "https://hooks.example.com/services/T0123Abc9xYz/B456?token=abcd1234efgh&format=json#frag-ment9",
		"DB_URL":        "postgres://user:pa:ss@db:5432/app",
		"ODD":           "postgres://user@@db:5432/app",
	}).Values
	for _, want := range []string{
		"T0123Abc9xYz",                   // token-like path segment
		"token=abcd1234efgh&format=json", // the query string
		"abcd1234efgh",                   // the value of a parameter with a secret name
		"frag-ment9",                     // the fragment
		"user:pa:ss", "pa:ss",            // userinfo and the password after its first colon
		"user@", // userinfo of user@@host: split at the last @
	} {
		if !slices.Contains(got, want) {
			t.Errorf("Values = %q, missing %q", got, want)
		}
	}
	for _, v := range got {
		if v == "services" || v == "json" || v == "hooks.example.com" {
			t.Errorf("%q is an ordinary part and must not be registered: %q", v, got)
		}
	}
}

// Each registered value says which rule registered it, for the diagnostics
// that explain a Report that failed validation. The name of the variable is
// shown, never the value.
func TestSelectEnvNamesTheRuleThatRegisteredEachValue(t *testing.T) {
	sel := redact.SelectEnv(map[string]string{
		"DB_PASSWORD": "rootword",
		"DB_URL":      "postgres://user:pa:ss@db:5432/app",
		"RANDOM_BLOB": "aB3dE6gH9jK2mN5p",
		"PEM":         "-----BEGIN PRIVATE KEY-----\nabcdef\n-----END PRIVATE KEY-----",
	})
	for value, want := range map[string]string{
		"rootword":                          "env-secret-name (variable DB_PASSWORD)",
		"postgres://user:pa:ss@db:5432/app": "env-url-userinfo (variable DB_URL)",
		"pa:ss":                             "env-url-userinfo (variable DB_URL)",
		"aB3dE6gH9jK2mN5p":                  "env-entropy (variable RANDOM_BLOB)",
		"-----BEGIN PRIVATE KEY-----\nabcdef\n-----END PRIVATE KEY-----": "env-pem-block (variable PEM)",
	} {
		if got := sel.Sources[value]; got != want {
			t.Errorf("source of %q = %q, want %q", value, got, want)
		}
	}
	for value, source := range sel.Sources {
		if strings.Contains(source, value) && len(value) > 4 {
			t.Errorf("the source %q shows the value %q", source, value)
		}
	}
}
