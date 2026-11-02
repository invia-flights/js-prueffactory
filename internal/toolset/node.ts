import { type Image, imageString, record } from "./toolset.ts";

// Node image variants.
export const VariantDebian = "debian";
export const VariantAlpine = "alpine";

// DefaultNodeMajor is the Node major used when a package declares none.
export const DefaultNodeMajor = 24;

// nodeImages holds the Node images per supported major and variant, keyed
// "<major>/<variant>". Digests were taken from the official Docker Hub index on
// 2026-10-26. `go run ./dev/toolsetupdate` refreshes them.
const nodeImages = new Map<string, Image>([
  [
    "22/debian",
    {
      repo: "node",
      tag: "22.23.4",
      digest:
        "sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384",
    },
  ],
  [
    "22/alpine",
    {
      repo: "node",
      tag: "22.23.4-alpine",
      digest:
        "sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914",
    },
  ],
  [
    "24/debian",
    {
      repo: "node",
      tag: "24.22.1",
      digest:
        "sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a",
    },
  ],
  [
    "24/alpine",
    {
      repo: "node",
      tag: "24.22.1-alpine",
      digest:
        "sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53",
    },
  ],
  [
    "26/debian",
    {
      repo: "node",
      tag: "26.12.1",
      digest:
        "sha256:a98e6fda54fdbb22d4238054cca9a2a113bcd1191c09193a535aae22f400aa8e",
    },
  ],
  [
    "26/alpine",
    {
      repo: "node",
      tag: "26.12.1-alpine",
      digest:
        "sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797",
    },
  ],
]);

// SupportedNodeMajors lists the Node majors the tool runs projects on, lowest
// first. Node 26 joins on 2026-10-28, when it becomes LTS.
export const SupportedNodeMajors: readonly number[] = [22, 24, 26];

for (const [key, img] of nodeImages) {
  record("node/" + key, imageString(img));
}

// nodeVersion returns the exact Node version, such as "24.22.1", of the pinned
// image of a major and variant, or undefined. The variant suffix of the tag is
// not part of it.
export function nodeVersion(
  major: number,
  variant: string,
): string | undefined {
  const img = nodeImage(major, variant);
  return img?.tag.split("-")[0];
}

// nodeImage returns the pinned Node image of a major and variant, or undefined.
export function nodeImage(major: number, variant: string): Image | undefined {
  return nodeImages.get(`${String(major)}/${variant}`);
}
