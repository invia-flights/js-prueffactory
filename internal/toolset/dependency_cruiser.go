package toolset

// dependency-cruiser finds circular imports and devDependencies imported by
// production code for modules.cycles. It has no install script.
func init() {
	registerNPMTool(Tool{Name: "dependency-cruiser", Version: "18.7.0", License: "MIT", Package: "dependency-cruiser"})
}
