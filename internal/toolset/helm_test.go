package toolset_test

import (
	"regexp"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/toolset"
)

func TestHelm322IsPinnedWithChecksumsForArm64AndAmd64(t *testing.T) {
	h := toolset.Helm
	if !strings.HasPrefix(h.Version, "3.22.") {
		t.Fatalf("helm version = %q, want the 3.22 line", h.Version)
	}
	if h.License != "Apache-2.0" {
		t.Errorf("license = %q", h.License)
	}
	hex := regexp.MustCompile(`^[0-9a-f]{64}$`)
	for _, arch := range []string{"amd64", "arm64"} {
		d, ok := h.Downloads[arch]
		if !ok {
			t.Fatalf("no download for %s", arch)
		}
		if !hex.MatchString(d.SHA256) {
			t.Errorf("%s checksum = %q, want 64 hex digits", arch, d.SHA256)
		}
		want := "https://get.helm.sh/helm-v" + h.Version + "-linux-" + arch + ".tar.gz"
		if d.URL != want {
			t.Errorf("%s url = %q, want %q", arch, d.URL, want)
		}
	}
	if len(h.Downloads) != 2 {
		t.Errorf("downloads = %v, want exactly arm64 and amd64", h.Downloads)
	}
}

func TestHelmRunsInThePinnedOfficialAlpineImage(t *testing.T) {
	img := toolset.HelmRunner.Image
	if img.Repo != "alpine" || !strings.HasPrefix(img.Digest, "sha256:") || len(img.Digest) != 71 {
		t.Errorf("helm runner image = %+v, want alpine pinned by digest", img)
	}
	if toolset.HelmRunner.Name != "helm" || toolset.HelmRunner.Version != toolset.Helm.Version {
		t.Errorf("helm runner = %+v", toolset.HelmRunner)
	}
}
