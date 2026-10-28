package checks

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func init() { Register(packageInstallScriptsID, packageInstallScripts{}) }

const packageInstallScriptsID = "package.install-scripts"

// packageInstallScripts lists the lockfile entries that have `hasInstallScript`,
// the dependencies that run code when they are installed, and records whether
// the project declares an `allowScripts` policy for them, in package.json or
// .npmrc. It is native, reads the host-side Snapshot copy and is a side
// indicator: it reports Metrics and no Findings, because a dependency with an
// install script is no defect (fsevents has one).
//
// Metrics: `install_scripts` (the number of entries), `allow_scripts_policy`
// (1 when a policy is declared, otherwise 0) and one `install_script:<entry>`
// with value 1 for each lockfile entry that has the script.
type packageInstallScripts struct{}

func (packageInstallScripts) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	return lockfileApplicability(packageInstallScriptsID, c)
}

func (packageInstallScripts) Run(_ context.Context, in *Input) *Result {
	lock, unsupported := loadPackageLockfile(in)
	if unsupported != nil {
		return unsupported
	}
	policy := declaresAllowScripts(in, lock.Dir)
	res := &Result{Status: resultset.StatusCompleted}
	one := 1.0
	for _, key := range lock.Keys() {
		e := lock.Loaded.Lock.Packages[key]
		if !e.HasInstallScript || e.Link {
			continue
		}
		res.Metrics = append(res.Metrics, resultset.Metric{Name: "install_script:" + key, Value: &one, Unit: "packages"})
	}
	count, flag := float64(len(res.Metrics)), 0.0
	if policy {
		flag = 1
	}
	policyReason := "no allowScripts policy in package.json or .npmrc"
	if policy {
		policyReason = "allowScripts policy declared"
	}
	res.Metrics = append([]resultset.Metric{
		{Name: "install_scripts", Value: &count, Unit: "packages"},
		{Name: "allow_scripts_policy", Value: &flag, Reason: &policyReason, Unit: "flag"},
	}, res.Metrics...)
	return res
}

// declaresAllowScripts reports whether the package.json has an `allowScripts`
// field or the .npmrc sets `allow-scripts` (in the dashed, camel case or list
// form).
func declaresAllowScripts(in *Input, pkgDir string) bool {
	if data, err := os.ReadFile(filepath.Join(pkgDir, "package.json")); err == nil {
		var doc struct {
			AllowScripts json.RawMessage `json:"allowScripts"`
		}
		if json.Unmarshal(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf")), &doc) == nil {
			if raw := bytes.TrimSpace(doc.AllowScripts); len(raw) > 0 && string(raw) != "null" {
				return true
			}
		}
	}
	for _, kv := range readNpmrc(in, pkgDir) {
		key := strings.NewReplacer("-", "", "_", "", "[]", "").Replace(strings.ToLower(kv.key))
		if key == "allowscripts" {
			return true
		}
	}
	return false
}
