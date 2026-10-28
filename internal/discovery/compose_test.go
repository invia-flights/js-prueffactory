package discovery_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
)

// Compose Services: the project's compose files tell which test Services a
// Run starts. Discovery only reads the files, never runs anything.

func serviceOf(t *testing.T, p *discovery.Project, name string) discovery.ComposeService {
	t.Helper()
	for _, s := range p.Services {
		if s.Name == name {
			return s
		}
	}
	t.Fatalf("compose service %q not discovered; have %+v", name, p.Services)
	return discovery.ComposeService{}
}

func TestAKnownImageInTheComposeFileIsATestService(t *testing.T) {
	p := project(t, map[string]string{
		"package.json": "{}",
		"docker-compose.yml": `services:
  redis:
    image: valkey/valkey:8.1-alpine
`,
	})
	s := serviceOf(t, p, "redis")
	if s.Family != "valkey" || s.NotStarted != nil || s.Declared != "valkey/valkey:8.1-alpine" {
		t.Fatalf("service = %+v", s)
	}
	if s.File != "docker-compose.yml" {
		t.Errorf("file = %q", s.File)
	}
}

func TestEveryKnownFamilyIsRecognisedByItsOfficialImageName(t *testing.T) {
	cases := map[string]string{
		"valkey":   "valkey/valkey:8.1-alpine",
		"redis":    "redis:7.2",
		"postgres": "docker.io/library/postgres:16",
		"mysql":    "mysql:8.4",
		"mariadb":  "mariadb:11.4",
		"mongodb":  "mongo:7",
		"rabbitmq": "rabbitmq:3.13-management",
	}
	for family, image := range cases {
		p := project(t, map[string]string{"compose.yaml": "services:\n  svc:\n    image: " + image + "\n"})
		if s := serviceOf(t, p, "svc"); s.Family != family || s.NotStarted != nil {
			t.Errorf("%s: service = %+v, want family %s", image, s, family)
		}
	}
}

func TestServicesThatAreNeverStartedSayWhy(t *testing.T) {
	p := project(t, map[string]string{
		"docker-compose.yml": `services:
  app:
    build: .
    image: valkey/valkey:8
  nodejs:
    image: registry.example.invalid/team/my-service:${IMAGE_VERSION:-latest}
  cache:
    image: ghcr.io/someone/redis:7
  proxy:
    image: nginx:1.27
  noimage:
    command: [npm, help]
`,
	})
	want := map[string]string{
		"app": "build_section", "nodejs": "private_registry", "cache": "private_registry",
		"proxy": "unknown_image", "noimage": "no_image",
	}
	for name, code := range want {
		s := serviceOf(t, p, name)
		if s.Family != "" || s.NotStarted == nil || s.NotStarted.Code != code {
			t.Errorf("%s = %+v, want not started with %s", name, s, code)
		}
	}
	if s := serviceOf(t, p, "nodejs"); s.Declared != "registry.example.invalid/team/my-service:latest" {
		t.Errorf("declared = %q, want the image interpolated with its default", s.Declared)
	}
}

func TestComposeFilesAreMergedLikeAnOverrideAndOnlyTheRootIsRead(t *testing.T) {
	p := project(t, map[string]string{
		"docker-compose.yml": `services:
  redis:
    image: valkey/valkey:8.1-alpine
    environment:
      A: base
      B: base
`,
		// Sorted before docker-compose.yml, but an override file still wins.
		"docker-compose.override.yml": `services:
  redis:
    ports: ["6379:6379"]
    environment:
      B: override
`,
		"sub/compose.yml":        "services:\n  hidden:\n    image: redis:7\n",
		"docker-compose.txt":     "services:\n  text:\n    image: redis:7\n",
		"my-compose.yml":         "services:\n  mine:\n    image: redis:7\n",
		"compose.override.yaml":  "services:\n  extra:\n    image: postgres:16\n",
		"docker-compose.dev.yml": "services:\n  dev:\n    image: mongo:7\n",
	})
	s := serviceOf(t, p, "redis")
	if s.Family != "valkey" || s.Env["A"] != "base" || s.Env["B"] != "override" {
		t.Errorf("redis = %+v", s)
	}
	names := map[string]bool{}
	for _, sv := range p.Services {
		names[sv.Name] = true
	}
	for _, n := range []string{"redis", "extra", "dev"} {
		if !names[n] {
			t.Errorf("service %q missing: %v", n, names)
		}
	}
	for _, n := range []string{"hidden", "text", "mine"} {
		if names[n] {
			t.Errorf("service %q was read from a file that is not a compose file of the root", n)
		}
	}
}

func TestEnvironmentIsInterpolatedFromTheDotEnvFileTheWayComposeDoesIt(t *testing.T) {
	p := project(t, map[string]string{
		".env": `# comment
export PASS=s3cret
USER_NAME="app user"
SINGLE='$not_expanded'
BASE=db
COMBINED=${BASE}-1
EMPTY=
`,
		"docker-compose.yml": `services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: ${PASS}
      POSTGRES_USER: $USER_NAME
      POSTGRES_DB: ${MISSING:-fallback}
      A: ${EMPTY-unused}
      B: ${EMPTY:-used}
      C: ${PASS:+set}
      D: ${UNSET_VAR+nope}
      E: $${ESCAPED}
      F: ${SINGLE}
      G: ${COMBINED}
`,
		"compose.yaml": `services:
  other:
    image: mysql:8.4
    environment:
      - MYSQL_ROOT_PASSWORD=${PASS}
      - PLAIN=value=with=equals
      - FROM_ENV_FILE
`,
	})
	db := serviceOf(t, p, "db")
	want := map[string]string{
		"POSTGRES_PASSWORD": "s3cret", "POSTGRES_USER": "app user", "POSTGRES_DB": "fallback",
		"A": "", "B": "used", "C": "set", "D": "", "E": "${ESCAPED}", "F": "$not_expanded", "G": "db-1",
	}
	for k, v := range want {
		if got, ok := db.Env[k]; !ok || got != v {
			t.Errorf("db env %s = %q (present %v), want %q", k, got, ok, v)
		}
	}
	if len(db.Unresolved) != 0 {
		t.Errorf("unresolved = %v", db.Unresolved)
	}
	other := serviceOf(t, p, "other")
	if other.Env["MYSQL_ROOT_PASSWORD"] != "s3cret" || other.Env["PLAIN"] != "value=with=equals" {
		t.Errorf("list form env = %v", other.Env)
	}
	if _, ok := other.Env["FROM_ENV_FILE"]; ok {
		t.Errorf("a bare name without a value in .env must not be passed: %v", other.Env)
	}
}

func TestAVariableThatCannotBeResolvedBlocksTheService(t *testing.T) {
	p := project(t, map[string]string{
		"docker-compose.yml": `services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      OTHER: ${REQUIRED:?must be set}
      FINE: ${DEFAULTED:-x}
`,
	})
	db := serviceOf(t, p, "db")
	if len(db.Unresolved) != 2 || db.Unresolved[0] != "DB_PASSWORD" || db.Unresolved[1] != "REQUIRED" {
		t.Errorf("unresolved = %v, want DB_PASSWORD and REQUIRED", db.Unresolved)
	}
}

func TestTheHostEnvironmentNeverFeedsTheInterpolation(t *testing.T) {
	t.Setenv("JSPF_HOST_SECRET", "from-the-host")
	p := project(t, map[string]string{
		"docker-compose.yml": "services:\n  db:\n    image: postgres:16\n    environment:\n      X: ${JSPF_HOST_SECRET}\n",
	})
	db := serviceOf(t, p, "db")
	if db.Env["X"] == "from-the-host" || len(db.Unresolved) != 1 {
		t.Errorf("db = %+v", db)
	}
}

func TestADifferentVersionThanThePinnedOneIsNoted(t *testing.T) {
	cases := []struct {
		image  string
		differ bool
	}{
		{"valkey/valkey:8.1-alpine", false}, // the pinned version
		{"valkey/valkey:8.1.3", false},      // a patch release of it: same series
		{"valkey/valkey:8", false},
		{"valkey/valkey", false}, // no version asked for
		{"valkey/valkey:latest", false},
		{"valkey/valkey:7.2-alpine", true},
		{"postgres:12", true},
		{"postgres:17-alpine", false},
	}
	for _, c := range cases {
		p := project(t, map[string]string{"compose.yml": "services:\n  s:\n    image: " + c.image + "\n"})
		if s := serviceOf(t, p, "s"); s.VersionDiffers != c.differ {
			t.Errorf("%s: VersionDiffers = %v, want %v", c.image, s.VersionDiffers, c.differ)
		}
	}
}

func TestServiceNamesThatCouldInjectOptionsAreNeverStarted(t *testing.T) {
	p := project(t, map[string]string{
		"compose.yml": "services:\n  \"--privileged\":\n    image: redis:7\n  \"a b\":\n    image: redis:7\n  ok_name-1.x:\n    image: redis:7\n",
	})
	for _, name := range []string{"--privileged", "a b"} {
		if s := serviceOf(t, p, name); s.NotStarted == nil || s.NotStarted.Code != "invalid_service_name" {
			t.Errorf("%q = %+v", name, s)
		}
	}
	if s := serviceOf(t, p, "ok_name-1.x"); s.NotStarted != nil {
		t.Errorf("ok name = %+v", s)
	}
}

func TestAnUnreadableComposeFileIsNoted(t *testing.T) {
	p := project(t, map[string]string{
		"compose.yml":          "services: [this is: not valid",
		"compose.override.yml": "services:\n  redis:\n    image: redis:7\n",
	})
	if len(p.ComposeProblems) != 1 || p.ComposeProblems[0].Path != "compose.yml" {
		t.Errorf("problems = %+v", p.ComposeProblems)
	}
	if serviceOf(t, p, "redis").Family != "redis" {
		t.Errorf("the readable file must still count")
	}
}
