package discovery_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
)

// A package whose test environment points at a compose Service the Run does
// not start (an unknown family, a private registry, a build section) is
// marked: tests that need it will fail for reasons outside the project. The
// check is a heuristic over env files and Test code, read as text.

const composeWithMinio = `services:
  redis:
    image: valkey/valkey:8.1-alpine
  minio:
    image: quay.io/minio/minio:latest
  app:
    build: .
`

func refsOf(t *testing.T, p *discovery.Project) []discovery.ServiceRef {
	t.Helper()
	for _, pkg := range p.Packages {
		if pkg.Path == "." {
			return pkg.ServiceRefs
		}
	}
	t.Fatal("no root package")
	return nil
}

func TestAnEnvFileUrlHostNamingAServiceThatIsNotStartedMarksThePackage(t *testing.T) {
	p := project(t, map[string]string{
		"package.json":       `{"scripts":{"test":"mocha"}}`,
		"docker-compose.yml": composeWithMinio,
		"test/.test.env":     "PORT=1\nTRANSLATION_HOST=http://minio:9000/translations\n",
	})

	refs := refsOf(t, p)

	if len(refs) != 1 || refs[0] != (discovery.ServiceRef{Service: "minio", File: "test/.test.env", Line: 2}) {
		t.Fatalf("refs = %+v", refs)
	}
}

func TestAServiceTheRunStartsIsNeverAReference(t *testing.T) {
	p := project(t, map[string]string{
		"package.json":       `{}`,
		"docker-compose.yml": composeWithMinio,
		".env":               "REDIS_URL=redis://redis:6379\n",
	})

	if refs := refsOf(t, p); len(refs) != 0 {
		t.Fatalf("refs = %+v, want none", refs)
	}
}

func TestOnlyAWholeHostNameCounts(t *testing.T) {
	p := project(t, map[string]string{
		"package.json":       `{}`,
		"docker-compose.yml": composeWithMinio,
		".env":               "A=http://minio-seed:9000\nB=http://minio.example.com/x\nC=see://minio2/\nD=http://xminio:1\n",
	})

	if refs := refsOf(t, p); len(refs) != 0 {
		t.Fatalf("refs = %+v, want none", refs)
	}
}

func TestAnExactEnvValueNamingAServiceCounts(t *testing.T) {
	p := project(t, map[string]string{
		"package.json":       `{}`,
		"docker-compose.yml": composeWithMinio,
		"config/test.env":    "# comment\nexport S3_HOST=\"minio\"\n",
	})

	refs := refsOf(t, p)

	if len(refs) != 1 || refs[0] != (discovery.ServiceRef{Service: "minio", File: "config/test.env", Line: 2}) {
		t.Fatalf("refs = %+v", refs)
	}
}

func TestTestCodeNamingAServiceAsAUrlHostCounts(t *testing.T) {
	p := project(t, map[string]string{
		"package.json":       `{}`,
		"docker-compose.yml": composeWithMinio,
		"test/s3.test.js":    "const url = 'http://minio:9000/x'\n",
	})

	refs := refsOf(t, p)

	if len(refs) != 1 || refs[0] != (discovery.ServiceRef{Service: "minio", File: "test/s3.test.js", Line: 1}) {
		t.Fatalf("refs = %+v", refs)
	}
}

func TestSourceCodeAndInstalledPackagesAreNotSearched(t *testing.T) {
	p := project(t, map[string]string{
		"package.json":                 `{}`,
		"docker-compose.yml":           composeWithMinio,
		"src/client.js":                "const url = 'http://minio:9000/x'\n",
		"node_modules/x/config.env":    "A=http://minio:9000\n",
		"node_modules/x/test/index.js": "http://minio:9000",
	})

	if refs := refsOf(t, p); len(refs) != 0 {
		t.Fatalf("refs = %+v, want none", refs)
	}
}

func TestEnvFilesAtAnyDepthBelongToTheirNearestPackage(t *testing.T) {
	p := project(t, map[string]string{
		"package.json":              `{}`,
		"docker-compose.yml":        composeWithMinio,
		"packages/api/package.json": `{}`,
		"packages/api/.env.test":    "S3=http://minio:9000\n",
	})

	if refs := refsOf(t, p); len(refs) != 0 {
		t.Fatalf("root refs = %+v, want none", refs)
	}
	var api *discovery.Package
	for _, pkg := range p.Packages {
		if pkg.Path == "packages/api" {
			api = pkg
		}
	}
	if api == nil || len(api.ServiceRefs) != 1 || api.ServiceRefs[0].File != "packages/api/.env.test" {
		t.Fatalf("api refs = %+v", api)
	}
}

func TestAServiceWithABuildSectionIsAlsoRecognised(t *testing.T) {
	p := project(t, map[string]string{
		"package.json":       `{}`,
		"docker-compose.yml": composeWithMinio,
		".env":               "API=http://app:3000/\n",
	})

	refs := refsOf(t, p)

	if len(refs) != 1 || refs[0].Service != "app" {
		t.Fatalf("refs = %+v", refs)
	}
}
