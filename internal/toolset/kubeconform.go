package toolset

import (
	"fmt"
	"path"
)

// Kubeconform is the official kubeconform image, pinned by the digest of its
// multi-arch index (linux/amd64 and linux/arm64), taken from ghcr.io on
// 2026-10-27. The image holds only the binary, its entrypoint is /kubeconform.
var Kubeconform = PinnedTool{
	Name:    "kubeconform",
	Version: "0.8.0",
	Image:   Image{Repo: "ghcr.io/yannh/kubeconform", Tag: "v0.8.0", Digest: "sha256:faffaf43f95aa6425306e1ab8d6fcad72acb9049158f38e574c085ea1ec0f64e"},
}

// KubernetesVersion is the one Kubernetes version repository.kubernetes
// validates against. Raise it together with the schema files below.
const KubernetesVersion = "1.34.1"

// KubernetesSchemaFolder is the folder inside the schema volume that holds the
// files, named the way kubeconform's schema location template expects.
const KubernetesSchemaFolder = "v" + KubernetesVersion + "-standalone-strict"

// KubernetesSchemaFile is one JSON Schema of a built-in Kubernetes kind: the
// "standalone-strict" flavour that yannh/kubernetes-json-schema publishes from
// the Kubernetes OpenAPI description. Raw is the address of the file at a fixed
// commit of that repository, so its content never changes under the checksum.
type KubernetesSchemaFile struct {
	Raw    string
	SHA256 string // of the file; `go run ./dev/toolsetupdate` refreshes it
}

// Name is the file name in the schema folder, such as "deployment-apps-v1.json".
func (f KubernetesSchemaFile) Name() string { return path.Base(f.Raw) }

// KubernetesSchemas covers the built-in kinds the Check validates: Deployment,
// StatefulSet, DaemonSet, ReplicaSet, Pod, Job, CronJob, Service, Ingress,
// ConfigMap, Secret, ServiceAccount, Role, RoleBinding, ClusterRole,
// ClusterRoleBinding, HorizontalPodAutoscaler (autoscaling/v1 and v2),
// PodDisruptionBudget, NetworkPolicy, PersistentVolumeClaim and Namespace.
// Resources of any other kind are not validated.
var KubernetesSchemas = []KubernetesSchemaFile{
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/deployment-apps-v1.json", SHA256: "92b7a333a49124f5300095d3e7786ca2038b7d6e602c309f73e90631377e4b0a"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/statefulset-apps-v1.json", SHA256: "e095a9d88776fbb2e9c9312baac322c992a9f5188f81ae690bb7dc00fc3915fa"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/daemonset-apps-v1.json", SHA256: "7cd418f81561c60d06fabe9b6d1145f2aeff8ed192c0c9dc2fb2802a51f78c21"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/replicaset-apps-v1.json", SHA256: "e7e1d5b5ba58abdf69323f040bfb32a4cf795d2e27d3d7bb5f418b22d1a50df7"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/pod-v1.json", SHA256: "6527f19e223c564c2364920c7d0bfac7ec7145fc39dd317dc738482f2c16a3a2"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/job-batch-v1.json", SHA256: "967234ab9eb5477fd8e5538c83c85817a560aecc1aaf886fafbe8a4ac0972023"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/cronjob-batch-v1.json", SHA256: "fb921edacc3ded080ca322233197727f8c110254ba3514e6faade5fa06513ae4"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/service-v1.json", SHA256: "8bf019854daed511e7c174896a898173fa65d88ec5937c687a37303d4cc9351b"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/ingress-networking-v1.json", SHA256: "4e0f63ad84c2bf22565e489d1f4b885ddaa9f6bf7cff1ddd562553760afe4d79"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/configmap-v1.json", SHA256: "e0eaddebd677c08aa092b2da2264d86ac4fc34eed112b9fac2945b3f00c1e9b1"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/secret-v1.json", SHA256: "de761ccb06bd1d2c641fb57397f61b68e7ff53a384f0817ce40e5ded8cee86f3"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/serviceaccount-v1.json", SHA256: "8193d6c3561475c6d3d5c44e1faedb1df53905373d904bc17015694326d659cf"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/role-rbac-v1.json", SHA256: "dfe8fb03b1642f985b57b12edd1727b6867c13ed4b6761ef81bdd51b1d236711"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/rolebinding-rbac-v1.json", SHA256: "87ab620d0adddcd2803b92357fce2854af752326df8c5408a7588aae98b3031d"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/clusterrole-rbac-v1.json", SHA256: "0777f91c4fa08bd3989b6db8c59dad0429a63dec8f59e883ff55c947a14d0d5f"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/clusterrolebinding-rbac-v1.json", SHA256: "e2d0471b444cf7ea4fd69d7eba1b16e06215503bfbc650450c2b6ad9b40f863c"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/horizontalpodautoscaler-autoscaling-v1.json", SHA256: "22e50f236d9b04cfb2f53e46f67c3789b0b002688bbce10cd20bdddeccc09fc3"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/horizontalpodautoscaler-autoscaling-v2.json", SHA256: "613e60f54bc1d70776eb3e75fbdbc2f1250b5c1a92c88f54846c5fabd02f6f3e"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/poddisruptionbudget-policy-v1.json", SHA256: "da73f50ad0264d73f668eecaa9959da65afe2846602a7a5c8fd51f7799d6a258"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/networkpolicy-networking-v1.json", SHA256: "f6324cc464f62228b0418f438d167208e4f86c7e3677ba30f608e79a8b26ba79"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/persistentvolumeclaim-v1.json", SHA256: "5ec592cb5f004c0e24fa080dd84f48b9339cd0c82248a78d37b6a3e1b4d7ab34"},
	{Raw: "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/f7d855e49c34b039c9ef2196444910275e31e09e/v1.34.1-standalone-strict/namespace-v1.json", SHA256: "324fae677b98d1a6d54340db0c334d053e8ffbafceb3f73326e41de2610d5843"},
}

func init() {
	record("kubeconform", Kubeconform.Image.String())
	entry := "kubernetes " + KubernetesVersion
	for _, f := range KubernetesSchemas {
		entry += fmt.Sprintf(" %s=%s sha256=%s", f.Name(), f.Raw, f.SHA256)
	}
	record("kubernetes-schemas", entry)
}
