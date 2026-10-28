package toolset_test

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/toolset"
)

func TestEverySupportedNodeMajorHasAPinnedImagePerVariant(t *testing.T) {
	if want := []int{22, 24, 26}; !slices.Equal(toolset.SupportedNodeMajors, want) {
		t.Fatalf("supported majors = %v, want %v", toolset.SupportedNodeMajors, want)
	}
	digest := regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	seen := map[string]bool{}
	for _, major := range toolset.SupportedNodeMajors {
		for _, variant := range []string{toolset.VariantDebian, toolset.VariantAlpine} {
			img, ok := toolset.NodeImage(major, variant)
			if !ok {
				t.Errorf("no image for Node %d %s", major, variant)
				continue
			}
			if !digest.MatchString(img.Digest) || seen[img.Digest] {
				t.Errorf("Node %d %s: digest %q is malformed or repeated", major, variant, img.Digest)
			}
			seen[img.Digest] = true
			if !strings.HasPrefix(img.Tag, strconv.Itoa(major)+".") || strings.Contains(img.Tag, "alpine") != (variant == toolset.VariantAlpine) {
				t.Errorf("Node %d %s: tag %q does not match", major, variant, img.Tag)
			}
		}
	}
	if _, ok := toolset.NodeImage(20, toolset.VariantDebian); ok {
		t.Error("Node 20 is not supported and must have no image")
	}
}
