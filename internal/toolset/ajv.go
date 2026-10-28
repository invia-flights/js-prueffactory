package toolset

// Ajv 8 compiles the project's JSON Schemas (schema.compile). ajv-draft-04 adds
// draft-04 and ajv-formats the standard string formats. None of them needs an
// install script.
func init() {
	registerNPMTool(Tool{Name: "ajv", Version: "8.20.0", License: "MIT", Package: "ajv"})
	registerNPMTool(Tool{Name: "ajv-draft-04", Version: "1.0.0", License: "MIT", Package: "ajv-draft-04"})
	registerNPMTool(Tool{Name: "ajv-formats", Version: "3.0.1", License: "MIT", Package: "ajv-formats"})
}
