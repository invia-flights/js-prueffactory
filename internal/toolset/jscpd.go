package toolset

// jscpd 5.4.2 is a Rust rewrite whose npm package ships native binaries as
// optional dependencies, so it needs no install script. The Check runs only its
// classic token mode.
func init() {
	registerNPMTool(Tool{Name: "jscpd", Version: "5.4.2", License: "MIT", Package: "jscpd"})
}
