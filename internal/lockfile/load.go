package lockfile

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Unsupported says why the lockfile of a package cannot be used by the
// lockfile-based native Checks. Code is a stable reason code for the Report.
type Unsupported struct {
	Code   string
	Reason string
}

// Loaded is everything the lockfile Checks need to know about one package
// folder. Load never fails: every problem is a field.
type Loaded struct {
	Detection

	// Manifest is nil when package.json is missing or ManifestErr is set.
	Manifest    *Manifest
	ManifestErr error

	// LockfileName is the npm lockfile that was read, or "".
	LockfileName string
	// Lock is set only when the lockfile is usable.
	Lock *Lock
	// LockErr is set when the lockfile exists but is broken. A lockfile of an
	// unsupported version is not broken.
	LockErr error

	// Unsupported is nil exactly when Lock can be used by every lockfile Check.
	// The Checks report their Execution as unsupported with this code and
	// reason, except for a broken lockfile (Code "lockfile_invalid"), which
	// package.manifest reports as a Gate.
	Unsupported *Unsupported
}

// Load reads the package.json and the npm lockfile in dir, a package folder of
// the Snapshot.
func Load(dir string) *Loaded {
	l := &Loaded{}
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err == nil {
		l.Manifest, l.ManifestErr = ParseManifest(data)
	} else {
		l.ManifestErr = err
	}
	l.Detection = Detect(dir, l.Manifest)

	l.Unsupported = ManagerSupport(l.Detection, l.Manifest)

	if l.NPMLockfile == "" {
		if l.Unsupported == nil {
			l.Unsupported = &Unsupported{"no_lockfile", "the package has no package-lock.json or npm-shrinkwrap.json"}
		}
		return l
	}
	l.LockfileName = l.NPMLockfile
	lockData, err := os.ReadFile(filepath.Join(dir, l.NPMLockfile))
	if err != nil {
		l.LockErr = err
	} else {
		l.Lock, l.LockErr = ParseLock(lockData)
	}
	var version *UnsupportedVersionError
	switch {
	case errors.As(l.LockErr, &version):
		l.LockErr = nil
		if l.Unsupported == nil {
			l.Unsupported = &Unsupported{"lockfile_version_unsupported", fmt.Sprintf("%s: %v", l.NPMLockfile, version)}
		}
	case l.LockErr != nil:
		if l.Unsupported == nil {
			l.Unsupported = &Unsupported{"lockfile_invalid", fmt.Sprintf("%s is broken: %v", l.NPMLockfile, l.LockErr)}
		}
	}
	if l.Unsupported != nil {
		l.Lock = nil
	}
	return l
}

// ManagerSupport says whether the package manager of a package is one this
// release supports. It returns nil for npm without workspaces, and otherwise
// the code and reason that make the package unsupported for everything that
// needs its dependencies installed.
func ManagerSupport(d Detection, m *Manifest) *Unsupported {
	switch {
	case d.Manager != NPM:
		return &Unsupported{"package_manager_unsupported", fmt.Sprintf(
			"the package uses %s (%s), and js-prueffactory supports only npm", d.Manager, d.managerEvidence())}
	case m != nil && m.HasWorkspaces:
		return &Unsupported{"workspaces_unsupported",
			"the package.json has a workspaces field, and js-prueffactory does not support npm workspaces"}
	}
	return nil
}

func (d Detection) managerEvidence() string {
	switch d.Source {
	case "lockfile":
		for _, lf := range d.Lockfiles {
			if lf.Manager == d.Manager {
				return lf.Name
			}
		}
	case "packageManager":
		return "the packageManager field"
	}
	return d.Source
}
