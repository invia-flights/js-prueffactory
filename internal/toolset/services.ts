import { type Image, imageString, record } from "./toolset.ts";

// Limits of a Service container (spec: every project or tool container gets 2
// CPUs and 4 GB, each Service container 1 CPU and 1 GB).
export const ServiceCPUs = 1.0;
export const ServiceMemoryMB = 1024;

// ServiceFamily is one family of test Services the Run can start from a
// project's compose file: the official image names that belong to it, the one
// pinned image the Run starts for it, and the probe that tells when it is up.
export interface ServiceFamily {
  // name is the family as the Report shows it.
  readonly name: string;
  // repos are the repository names of the family's official images on Docker
  // Hub, without registry host and without the "library/" prefix.
  readonly repos: readonly string[];
  // image is the pinned image, by the digest of its multi-arch index.
  readonly image: Image;
  // version is the version series of the pinned image, for comparing it with
  // the version a compose file asks for.
  readonly version: string;
  // probe is the command, run inside the Service container, that exits 0 once
  // the Service answers on the network. It uses the family's own client.
  // Probes connect over TCP on 127.0.0.1, because the entrypoints of some
  // images run a temporary server on a Unix socket while they initialise.
  readonly probe: readonly string[];
}

// ServiceFamilies lists the families in the order the Report lists them. The
// digests were taken from Docker Hub on 2026-10-26.
export const ServiceFamilies: readonly ServiceFamily[] = [
  {
    name: "valkey",
    repos: ["valkey/valkey", "valkey"],
    version: "8.1",
    image: {
      repo: "valkey/valkey",
      tag: "8.1-alpine",
      digest:
        "sha256:081c2f5cb575efc901aa80ff9cdbd1ec6a301682fd35e1ebb4b0990a4a4a8507",
    },
    probe: [
      "sh",
      "-c",
      "valkey-cli -h 127.0.0.1 ping | grep -q -e PONG -e NOAUTH",
    ],
  },
  {
    name: "redis",
    repos: ["redis"],
    version: "8.2",
    image: {
      repo: "redis",
      tag: "8.2-alpine",
      digest:
        "sha256:d1389b3f3f981460b9b0918c4d7390c6e9decb8c69b9f09a02e1b6fd7554ade7",
    },
    probe: [
      "sh",
      "-c",
      "redis-cli -h 127.0.0.1 ping | grep -q -e PONG -e NOAUTH",
    ],
  },
  {
    name: "postgres",
    repos: ["postgres"],
    version: "17",
    image: {
      repo: "postgres",
      tag: "17-alpine",
      digest:
        "sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b",
    },
    probe: ["pg_isready", "-h", "127.0.0.1"],
  },
  {
    name: "mysql",
    repos: ["mysql"],
    version: "8.4",
    image: {
      repo: "mysql",
      tag: "8.4",
      digest:
        "sha256:76f0358884cb92d9a086d24e5671c38048d3fef40f2588703d73eb55392d6b69",
    },
    probe: ["mysqladmin", "ping", "-h", "127.0.0.1", "--silent"],
  },
  {
    name: "mariadb",
    repos: ["mariadb"],
    version: "11.4",
    image: {
      repo: "mariadb",
      tag: "11.4",
      digest:
        "sha256:250e1609e93c0e6aecf64bfbab2d84d5e89d2481540fe77447ff6c855c3b1873",
    },
    probe: ["mariadb-admin", "ping", "-h", "127.0.0.1", "--silent"],
  },
  {
    name: "mongodb",
    repos: ["mongo"],
    version: "8.0",
    image: {
      repo: "mongo",
      tag: "8.0",
      digest:
        "sha256:4a4ab5d4834207389e0d7270fac988e21ffedccecba77991a552f755df229907",
    },
    probe: [
      "mongosh",
      "--quiet",
      "--host",
      "127.0.0.1",
      "--eval",
      "db.adminCommand('ping').ok ? 0 : quit(1)",
    ],
  },
  {
    name: "rabbitmq",
    repos: ["rabbitmq"],
    version: "4.1",
    image: {
      repo: "rabbitmq",
      tag: "4.1-alpine",
      digest:
        "sha256:3dd4ce7606f9fbf2e2dbca90a02f29c19c5cdf66bf15cdf5237430e3614128ca",
    },
    probe: ["rabbitmq-diagnostics", "-q", "ping"],
  },
];

// serviceFamilyOf returns the family whose official image has the repository
// name, such as "valkey/valkey" or "mongo".
export function serviceFamilyOf(repo: string): ServiceFamily | undefined {
  return ServiceFamilies.find((f) => f.repos.includes(repo));
}

// serviceFamilyNamed returns the family with the Report name, such as "mongodb".
export function serviceFamilyNamed(name: string): ServiceFamily | undefined {
  return ServiceFamilies.find((f) => f.name === name);
}

record(
  "services/limits",
  `${String(ServiceCPUs)} cpus, ${String(ServiceMemoryMB)} MB`,
);
for (const f of ServiceFamilies) {
  record("service/" + f.name, imageString(f.image));
}
