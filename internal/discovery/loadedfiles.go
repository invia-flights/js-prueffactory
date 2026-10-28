package discovery

// TestFile is a file a suite's test runner loads, as the probe of the
// installed runner reported it.
type TestFile struct {
	// ContextID is the Context of the package whose suite loads the file.
	ContextID string
	// Path is the project path of the file.
	Path string
	// Suite is the origin of the suite that loads the file.
	Suite string
	// Kind says how the runner loads it: "spec" for a test file, or "require",
	// "import" or "file" for a file the runner's options name.
	Kind string
}

// WithTestFiles returns a view of the project in which the files the runners
// load are Test code. Only a Source file of the package that loads it moves:
// Test data and Build output win over Test code, and a file of another package,
// outside the project or not there at all stays as it is. The project itself is
// never changed, because Checks that do not wait for the probe read it at the
// same time; a project with nothing to move is returned as it is.
func (p *Project) WithTestFiles(loaded []TestFile) *Project {
	index := p.fileIndex()
	move := map[string]bool{}
	for _, l := range loaded {
		if f, ok := sourceFile(index, l); ok {
			move[f.Path] = true
		}
	}
	if len(move) == 0 {
		return p
	}
	reclassify := func(files []File) []File {
		out := make([]File, len(files))
		copy(out, files)
		for i := range out {
			if move[out[i].Path] && out[i].Class == Source {
				out[i].Class = TestCode
			}
		}
		return out
	}

	view := *p
	view.Files = reclassify(p.Files)
	packages := map[*Package]*Package{}
	view.Packages = make([]*Package, len(p.Packages))
	for i, pkg := range p.Packages {
		copied := *pkg
		copied.Files = reclassify(pkg.Files)
		packages[pkg] = &copied
		view.Packages[i] = &copied
	}
	view.Contexts = make([]Context, len(p.Contexts))
	copy(view.Contexts, p.Contexts)
	for i := range view.Contexts {
		if pkg := view.Contexts[i].Package; pkg != nil {
			view.Contexts[i].Package = packages[pkg]
		}
	}
	return &view
}

// MovedTestFiles lists the files of loaded that the probe turns from Source
// code into Test code in the package, once for each suite that loads them.
func (p *Project) MovedTestFiles(pkg *Package, loaded []TestFile) []TestFile {
	type key struct{ suite, path string }
	index := p.fileIndex()
	seen := map[key]bool{}
	var out []TestFile
	for _, l := range loaded {
		if l.ContextID != pkg.ContextID {
			continue
		}
		if _, ok := sourceFile(index, l); !ok || seen[key{l.Suite, l.Path}] {
			continue
		}
		seen[key{l.Suite, l.Path}] = true
		out = append(out, l)
	}
	return out
}

func (p *Project) fileIndex() map[string]File {
	index := make(map[string]File, len(p.Files))
	for _, f := range p.Files {
		index[f.Path] = f
	}
	return index
}

// sourceFile returns the Source file a loaded file names, if there is one in
// the package of its Context.
func sourceFile(index map[string]File, l TestFile) (File, bool) {
	f, ok := index[l.Path]
	return f, ok && f.ContextID == l.ContextID && f.Class == Source
}
