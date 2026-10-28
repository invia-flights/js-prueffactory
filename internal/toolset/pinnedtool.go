package toolset

// PinnedTool is a tool that runs from one official image: its name and release
// version for the Report, and the image it runs in.
type PinnedTool struct {
	Name    string
	Version string
	Image   Image
}
