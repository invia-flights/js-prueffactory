// The Helm binary of the toolset volume (Go: helm.go).
import { quote } from "../gocompat/fmt.ts";
import { sortStrings } from "../gocompat/strings.ts";
import type { HelmBinary } from "../toolset/helm.ts";

/** MountPath is where Checks mount the toolset volume. */
export const MountPath = "/toolset";
/** HelmBin is the Helm binary the install downloads. It is a static binary that runs in the pinned Alpine image. */
export const HelmBin = MountPath + "/bin/helm";

/**
 * helmChecksumMarker is what the install script prints when the downloaded
 * Helm archive does not match the pinned checksum.
 */
export const helmChecksumMarker = "JSPF_HELM_CHECKSUM_MISMATCH";

/**
 * safeWord is what a pinned URL or checksum may contain, so that it can sit
 * in single quotes of the install script without any escaping.
 */
const safeWord = /^[A-Za-z0-9:/._-]+$/;

const cases: Readonly<Record<string, string>> = {
  amd64: "x86_64|amd64",
  arm64: "aarch64|arm64",
};

/**
 * helmInstallScript downloads the pinned Helm release for the architecture
 * of the install container, verifies its SHA-256 and installs the binary at
 * HelmBin. It stops at the first failure and never installs an unverified
 * binary.
 */
export function helmInstallScript(h: HelmBinary): string {
  const archs = sortStrings([...h.downloads.keys()]);
  let b = `case "$(uname -m)" in `;
  for (const a of archs) {
    const d = h.downloads.get(a);
    const pattern = cases[a];
    if (
      d === undefined ||
      pattern === undefined ||
      !safeWord.test(d.url) ||
      !safeWord.test(d.sha256) ||
      !safeWord.test(a)
    ) {
      throw new Error(
        `toolvolume: the Helm download for ${quote(a)} is not usable`,
      );
    }
    b += `${pattern}) ARCH='${a}'; URL='${d.url}'; SUM='${d.sha256}';; `;
  }
  b += `*) echo "no pinned Helm download for $(uname -m)" >&2; exit 1;; esac && `;
  b += `curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o /tmp/helm.tar.gz "$URL" && `;
  b += `{ echo "$SUM  /tmp/helm.tar.gz" | sha256sum -c - >/dev/null 2>&1 || { echo "${helmChecksumMarker}: the Helm archive does not match its pinned checksum" >&2; exit 1; }; } && `;
  b += `mkdir -p /tmp/helm ${MountPath}/bin && tar -xzf /tmp/helm.tar.gz -C /tmp/helm "linux-$ARCH/helm" && `;
  b += `install -m 0755 "/tmp/helm/linux-$ARCH/helm" ${HelmBin} && rm -rf /tmp/helm /tmp/helm.tar.gz`;
  return b;
}
