package toolset

import (
	"fmt"
	"strings"
)

// Node image variants.
const (
	VariantDebian = "debian"
	VariantAlpine = "alpine"
)

// DefaultNodeMajor is the Node major used when a package declares none.
const DefaultNodeMajor = 24

type nodeKey struct {
	major   int
	variant string
}

// nodeImages holds the Node images per supported major and variant. Digests
// were taken from the official Docker Hub index on 2026-10-26. `go run
// ./dev/toolsetupdate` refreshes them.
var nodeImages = map[nodeKey]Image{
	{22, VariantDebian}: {Repo: "node", Tag: "22.23.4", Digest: "sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384"},
	{22, VariantAlpine}: {Repo: "node", Tag: "22.23.4-alpine", Digest: "sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914"},
	{24, VariantDebian}: {Repo: "node", Tag: "24.22.1", Digest: "sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a"},
	{24, VariantAlpine}: {Repo: "node", Tag: "24.22.1-alpine", Digest: "sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53"},
	{26, VariantDebian}: {Repo: "node", Tag: "26.12.1", Digest: "sha256:a98e6fda54fdbb22d4238054cca9a2a113bcd1191c09193a535aae22f400aa8e"},
	{26, VariantAlpine}: {Repo: "node", Tag: "26.12.1-alpine", Digest: "sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797"},
}

// SupportedNodeMajors lists the Node majors the tool runs projects on, lowest
// first. Node 26 joins on 2026-10-28, when it becomes LTS.
var SupportedNodeMajors = []int{22, 24, 26}

func init() {
	for k, img := range nodeImages {
		record(fmt.Sprintf("node/%d/%s", k.major, k.variant), img.String())
	}
}

// NodeVersion returns the exact Node version, such as "24.22.1", of the pinned
// image of a major and variant. The variant suffix of the tag is not part of it.
func NodeVersion(major int, variant string) (string, bool) {
	img, ok := nodeImages[nodeKey{major, variant}]
	if !ok {
		return "", false
	}
	v, _, _ := strings.Cut(img.Tag, "-")
	return v, true
}

// NodeImage returns the pinned Node image of a major and variant.
func NodeImage(major int, variant string) (Image, bool) {
	img, ok := nodeImages[nodeKey{major, variant}]
	return img, ok
}
