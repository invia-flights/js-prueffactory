package toolset

// Knip 6 finds unused files, exports and dependencies and undeclared or
// unresolvable imports for quality.unused. It parses with oxc, has no
// TypeScript dependency and no install script.
func init() {
	registerNPMTool(Tool{Name: "knip", Version: "6.43.0", License: "ISC", Package: "knip"})
}
