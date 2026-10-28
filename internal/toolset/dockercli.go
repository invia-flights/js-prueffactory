package toolset

// DockerCLI is the official Docker CLI image (the `cli` variant of the docker
// image: the client without the daemon), pinned by the digest of its multi-arch
// index (amd64 and arm64), taken from Docker Hub on 2026-10-27. It carries the
// compose plugin, Docker Compose v5.6.1 at this pin: repository.compose runs
// `docker compose config` in it, and no daemon is needed for that. The image's
// entrypoint passes a command that starts with `docker` through unchanged.
var DockerCLI = PinnedTool{
	Name:    "docker-cli",
	Version: "29.9.2",
	Image:   Image{Repo: "docker", Tag: "29.9.2-cli", Digest: "sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb"},
}

func init() { record("docker-cli", DockerCLI.Image.String()) }
