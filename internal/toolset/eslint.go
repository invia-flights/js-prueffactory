package toolset

// ESLint 10 runs the combined ESLint run of the lint, test smell, engine and
// metric Checks with a generated flat config. globals supplies the Node and
// Mocha global names for that config. The three plugins bring the rules of
// tests.smells (Mocha), deps.engines (n) and quality.metrics (SonarJS cognitive
// complexity). None of the packages has install scripts. SonarJS is licensed
// LGPL-3.0-only, which is fine for a tool that is installed and run but not
// redistributed in our binary.
func init() {
	registerNPMTool(Tool{Name: "eslint", Version: "10.13.0", License: "MIT", Package: "eslint"})
	registerNPMTool(Tool{Name: "globals", Version: "17.13.0", License: "MIT", Package: "globals"})
	registerNPMTool(Tool{Name: "eslint-plugin-mocha", Version: "12.0.2", License: "MIT", Package: "eslint-plugin-mocha"})
	registerNPMTool(Tool{Name: "eslint-plugin-n", Version: "18.5.0", License: "MIT", Package: "eslint-plugin-n"})
	registerNPMTool(Tool{Name: "eslint-plugin-sonarjs", Version: "4.2.2", License: "LGPL-3.0-only", Package: "eslint-plugin-sonarjs"})
}
