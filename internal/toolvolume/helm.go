package toolvolume

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// helmChecksumMarker is what the install script prints when the downloaded
// Helm archive does not match the pinned checksum.
const helmChecksumMarker = "JSPF_HELM_CHECKSUM_MISMATCH"

// safeWord is what a pinned URL or checksum may contain, so that it can sit in
// single quotes of the install script without any escaping.
var safeWord = regexp.MustCompile(`^[A-Za-z0-9:/._-]+$`)

// helmInstallScript downloads the pinned Helm release for the architecture of
// the install container, verifies its SHA-256 and installs the binary at
// HelmBin. It stops at the first failure and never installs an unverified
// binary.
func helmInstallScript(h toolset.HelmBinary) string {
	archs := make([]string, 0, len(h.Downloads))
	for a := range h.Downloads {
		archs = append(archs, a)
	}
	sort.Strings(archs)
	cases := map[string]string{"amd64": "x86_64|amd64", "arm64": "aarch64|arm64"}

	var b strings.Builder
	b.WriteString(`case "$(uname -m)" in `)
	for _, a := range archs {
		d := h.Downloads[a]
		pattern, ok := cases[a]
		if !ok || !safeWord.MatchString(d.URL) || !safeWord.MatchString(d.SHA256) || !safeWord.MatchString(a) {
			panic(fmt.Sprintf("toolvolume: the Helm download for %q is not usable", a))
		}
		fmt.Fprintf(&b, "%s) ARCH='%s'; URL='%s'; SUM='%s';; ", pattern, a, d.URL, d.SHA256)
	}
	b.WriteString(`*) echo "no pinned Helm download for $(uname -m)" >&2; exit 1;; esac && `)
	b.WriteString(`curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o /tmp/helm.tar.gz "$URL" && `)
	b.WriteString(`{ echo "$SUM  /tmp/helm.tar.gz" | sha256sum -c - >/dev/null 2>&1 || { echo "` + helmChecksumMarker + `: the Helm archive does not match its pinned checksum" >&2; exit 1; }; } && `)
	b.WriteString(`mkdir -p /tmp/helm ` + MountPath + `/bin && tar -xzf /tmp/helm.tar.gz -C /tmp/helm "linux-$ARCH/helm" && `)
	b.WriteString(`install -m 0755 "/tmp/helm/linux-$ARCH/helm" ` + HelmBin + ` && rm -rf /tmp/helm /tmp/helm.tar.gz`)
	return b.String()
}
