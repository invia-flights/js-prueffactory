package checks

import (
	"context"
	"fmt"
	"regexp"
	"strconv"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

func init() {
	Register(depsEnginesID, depsEngines{})
	registerESLintGroup(eslintGroup{
		checkID: depsEnginesID, plugins: []string{"n"}, partialOnUnparsed: true,
		rules: []eslintRuleSpec{
			{Name: "n/no-unsupported-features/es-syntax"},
			{Name: "n/no-unsupported-features/es-builtins"},
			{Name: "n/no-unsupported-features/node-builtins"},
			{Name: "n/no-deprecated-api"},
		},
		// The plugin judges syntax and APIs against this version.
		settings: func(in *Input) map[string]any {
			return map[string]any{"n": map[string]any{"version": engineNodeVersion(in.Context)}}
		},
	})
}

const depsEnginesID = "deps.engines"

// plainNodeVersion is what the plugin is given: numbers only, so that nothing
// from the project can break the config. Other values fall back to the default.
var plainNodeVersion = regexp.MustCompile(`^[0-9]+(\.[0-9]+){0,2}$`)

// engineNodeVersion is the exact Node version of the Context, which is what the
// package's code has to run on: the version of the pinned image the Context
// runs in, such as "24.22.1". The Context records only the major; a version
// that is already more exact is passed on as it is.
func engineNodeVersion(c *discovery.Context) string {
	major := toolset.DefaultNodeMajor
	variant := toolset.VariantDebian
	if c.Node != nil {
		if c.Node.Variant != "" {
			variant = c.Node.Variant
		}
		if plainNodeVersion.MatchString(c.Node.Version) {
			if m, err := strconv.Atoi(c.Node.Version); err == nil {
				major = m
			} else {
				return c.Node.Version
			}
		}
	}
	if v, ok := toolset.NodeVersion(major, variant); ok {
		return v
	}
	return fmt.Sprint(major)
}

// depsEngines reports syntax and APIs that the Context's Node version does not
// support or has deprecated, with eslint-plugin-n rules of the combined ESLint
// run. Findings are warnings.
type depsEngines struct{}

func (depsEngines) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	return eslintApplicability(c)
}

func (depsEngines) Images(c *discovery.Context) []string { return eslintImages(c) }

func (depsEngines) UsesToolset(c *discovery.Context) bool { return len(eslintImages(c)) > 0 }

func (depsEngines) Run(ctx context.Context, in *Input) *Result {
	run, failed := in.eslintRun(ctx)
	if failed != nil {
		return failed
	}
	return interpretDepsEngines(in, run)
}

func interpretDepsEngines(in *Input, run *eslintRun) *Result {
	res, _ := eslintHitsResult(in, run, depsEnginesID, func(string) string { return "warning" })
	return res
}
