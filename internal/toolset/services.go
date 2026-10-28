package toolset

import "fmt"

// Limits of a Service container (spec: every project or tool container gets 2
// CPUs and 4 GB, each Service container 1 CPU and 1 GB).
const (
	ServiceCPUs     = 1.0
	ServiceMemoryMB = 1024
)

// ServiceFamily is one family of test Services the Run can start from a
// project's compose file: the official image names that belong to it, the one
// pinned image the Run starts for it, and the probe that tells when it is up.
type ServiceFamily struct {
	// Name is the family as the Report shows it.
	Name string
	// Repos are the repository names of the family's official images on Docker
	// Hub, without registry host and without the "library/" prefix.
	Repos []string
	// Image is the pinned image, by the digest of its multi-arch index.
	Image Image
	// Version is the version series of the pinned image, for comparing it with
	// the version a compose file asks for.
	Version string
	// Probe is the command, run inside the Service container, that exits 0 once
	// the Service answers on the network. It uses the family's own client.
	// Probes connect over TCP on 127.0.0.1, because the entrypoints of some
	// images run a temporary server on a Unix socket while they initialise.
	Probe []string
}

// ServiceFamilies lists the families in the order the Report lists them. The
// digests were taken from Docker Hub on 2026-10-26.
var ServiceFamilies = []ServiceFamily{
	{
		Name: "valkey", Repos: []string{"valkey/valkey", "valkey"}, Version: "8.1",
		Image: Image{Repo: "valkey/valkey", Tag: "8.1-alpine", Digest: "sha256:081c2f5cb575efc901aa80ff9cdbd1ec6a301682fd35e1ebb4b0990a4a4a8507"},
		Probe: []string{"sh", "-c", "valkey-cli -h 127.0.0.1 ping | grep -q -e PONG -e NOAUTH"},
	},
	{
		Name: "redis", Repos: []string{"redis"}, Version: "8.2",
		Image: Image{Repo: "redis", Tag: "8.2-alpine", Digest: "sha256:d1389b3f3f981460b9b0918c4d7390c6e9decb8c69b9f09a02e1b6fd7554ade7"},
		Probe: []string{"sh", "-c", "redis-cli -h 127.0.0.1 ping | grep -q -e PONG -e NOAUTH"},
	},
	{
		Name: "postgres", Repos: []string{"postgres"}, Version: "17",
		Image: Image{Repo: "postgres", Tag: "17-alpine", Digest: "sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b"},
		Probe: []string{"pg_isready", "-h", "127.0.0.1"},
	},
	{
		Name: "mysql", Repos: []string{"mysql"}, Version: "8.4",
		Image: Image{Repo: "mysql", Tag: "8.4", Digest: "sha256:76f0358884cb92d9a086d24e5671c38048d3fef40f2588703d73eb55392d6b69"},
		Probe: []string{"mysqladmin", "ping", "-h", "127.0.0.1", "--silent"},
	},
	{
		Name: "mariadb", Repos: []string{"mariadb"}, Version: "11.4",
		Image: Image{Repo: "mariadb", Tag: "11.4", Digest: "sha256:250e1609e93c0e6aecf64bfbab2d84d5e89d2481540fe77447ff6c855c3b1873"},
		Probe: []string{"mariadb-admin", "ping", "-h", "127.0.0.1", "--silent"},
	},
	{
		Name: "mongodb", Repos: []string{"mongo"}, Version: "8.0",
		Image: Image{Repo: "mongo", Tag: "8.0", Digest: "sha256:4a4ab5d4834207389e0d7270fac988e21ffedccecba77991a552f755df229907"},
		Probe: []string{"mongosh", "--quiet", "--host", "127.0.0.1", "--eval", "db.adminCommand('ping').ok ? 0 : quit(1)"},
	},
	{
		Name: "rabbitmq", Repos: []string{"rabbitmq"}, Version: "4.1",
		Image: Image{Repo: "rabbitmq", Tag: "4.1-alpine", Digest: "sha256:3dd4ce7606f9fbf2e2dbca90a02f29c19c5cdf66bf15cdf5237430e3614128ca"},
		Probe: []string{"rabbitmq-diagnostics", "-q", "ping"},
	},
}

// ServiceFamilyOf returns the family whose official image has the repository
// name, such as "valkey/valkey" or "mongo".
func ServiceFamilyOf(repo string) (ServiceFamily, bool) {
	for _, f := range ServiceFamilies {
		for _, r := range f.Repos {
			if r == repo {
				return f, true
			}
		}
	}
	return ServiceFamily{}, false
}

// ServiceFamilyNamed returns the family with the Report name, such as "mongodb".
func ServiceFamilyNamed(name string) (ServiceFamily, bool) {
	for _, f := range ServiceFamilies {
		if f.Name == name {
			return f, true
		}
	}
	return ServiceFamily{}, false
}

func init() {
	record("services/limits", fmt.Sprintf("%v cpus, %d MB", ServiceCPUs, ServiceMemoryMB))
	for _, f := range ServiceFamilies {
		record("service/"+f.Name, f.Image.String())
	}
}
