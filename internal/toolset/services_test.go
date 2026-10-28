package toolset_test

import (
	"regexp"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/toolset"
)

func TestEveryServiceFamilyHasOnePinnedImageAndItsOwnProbe(t *testing.T) {
	want := []string{"valkey", "redis", "postgres", "mysql", "mariadb", "mongodb", "rabbitmq"}
	digest := regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	if len(toolset.ServiceFamilies) != len(want) {
		t.Fatalf("%d families, want %d", len(toolset.ServiceFamilies), len(want))
	}
	for i, f := range toolset.ServiceFamilies {
		if f.Name != want[i] {
			t.Errorf("family %d = %q, want %q", i, f.Name, want[i])
		}
		if !digest.MatchString(f.Image.Digest) || f.Image.Tag == "" || f.Image.Repo == "" {
			t.Errorf("%s: image = %+v is not pinned by a digest", f.Name, f.Image)
		}
		if len(f.Probe) == 0 || f.Version == "" || len(f.Repos) == 0 {
			t.Errorf("%s: probe %v, version %q, repos %v", f.Name, f.Probe, f.Version, f.Repos)
		}
	}
}

func TestAServiceFamilyIsFoundByTheRepositoryOfItsOfficialImage(t *testing.T) {
	cases := map[string]string{
		"valkey/valkey": "valkey", "valkey": "valkey", "redis": "redis", "postgres": "postgres",
		"mysql": "mysql", "mariadb": "mariadb", "mongo": "mongodb", "rabbitmq": "rabbitmq",
	}
	for repo, family := range cases {
		if f, ok := toolset.ServiceFamilyOf(repo); !ok || f.Name != family {
			t.Errorf("%s = %+v, %v; want %s", repo, f, ok, family)
		}
	}
	for _, repo := range []string{"nginx", "bitnami/redis", "redis/redis-stack", ""} {
		if _, ok := toolset.ServiceFamilyOf(repo); ok {
			t.Errorf("%q is not an official test Service image", repo)
		}
	}
}

func TestServicesGetOneCPUAndOneGigabyte(t *testing.T) {
	if toolset.ServiceCPUs != 1 || toolset.ServiceMemoryMB != 1024 {
		t.Errorf("limits = %v CPUs, %d MB", toolset.ServiceCPUs, toolset.ServiceMemoryMB)
	}
}
