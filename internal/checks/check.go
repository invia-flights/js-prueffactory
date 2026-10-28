// Package checks holds the Catalog and the Checks themselves.
//
// To add a Check, create one file in this package named after it, such as
// package_manifest.go, with a type that implements Check, and register it in an
// init function:
//
//	func init() { Register("package.manifest", manifestCheck{}) }
//
// The Check's row in catalog.go already exists. Registering an implementation is
// what turns its catalog status from planned to implemented, so parallel work on
// different Checks touches different files. Embedded JavaScript helpers go in
// the js folder next to the Check, loaded with go:embed in the Check's own file.
package checks

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Check is the implementation of one Catalog entry.
type Check interface {
	// Applicability says whether the Check has anything to examine in a Context.
	// It works on discovery data only: no Docker, no project code. The reason
	// explains a not_applicable or unknown answer.
	Applicability(p *discovery.Project, c *discovery.Context) (resultset.Applicability, string)
	// Run performs the Check in one Context. It returns what it found and how
	// it went; the engine adds IDs, Gate counts and Outcomes.
	Run(ctx context.Context, in *Input) *Result
}

// ImageUser is implemented by Checks that run containers. The engine pulls the
// images it returns during the Preparation phase, before the Execution phase
// starts, and only streams the Snapshot into Docker when some Check needs it.
type ImageUser interface {
	// Images returns the pinned image references the Check will run in the
	// Context, or nil when it will not start a container there.
	Images(c *discovery.Context) []string
}

// PrerequisiteUser is implemented by Checks that need other Checks of the same
// Context to have completed first, such as deps.tree after package.install.
//
// The engine runs a prerequisite even when the Selection leaves it out. It then
// reports the prerequisite as not selected, without Findings or Gates, and no
// dependent starts before it has finished. A dependent whose prerequisite did
// not complete without a Gate is not run: it is reported as unsupported when
// the prerequisite was, and otherwise as blocked, with a reason code that says
// whether the project (prerequisite_failed_project) or the Run was at fault.
type PrerequisiteUser interface {
	// Prerequisites returns the IDs of the Checks that must complete in the
	// same Context before the Check starts. Prerequisites of prerequisites
	// are followed.
	Prerequisites(c *discovery.Context) []string
}

// RunsAfterUser is implemented by Checks that are scheduled after other Checks
// of the same Context without needing them to succeed: they read what those
// leave in the Run, such as the shared first run of a test suite. The engine
// runs the other Check even when the Selection leaves it out, reports it as not
// selected, and starts the dependent after it has finished, whatever its
// status.
type RunsAfterUser interface {
	// RunsAfter returns the IDs of the Checks that run before the Check in the
	// same Context.
	RunsAfter(c *discovery.Context) []string
}

// OrderedAfterUser is implemented by Checks that read what another Check of the
// same Context leaves in the Run when that Check runs, such as
// runtime.unhandled-rejections after the repeat runs of tests.flaky. Unlike
// RunsAfterUser it never makes the other Check run: the scheduler only keeps
// the order when the Selection has both.
type OrderedAfterUser interface {
	// OrderedAfter returns the IDs of the Checks that run before the Check in
	// the same Context, when they run at all.
	OrderedAfter(c *discovery.Context) []string
}

// WorkingCopyUser is implemented by Checks that use the Working copy: the
// writable copy of the Snapshot in a run-owned volume, where dependencies are
// installed. The engine creates it when a Check that runs a container uses it,
// and passes it as Input.WorkVolume.
type WorkingCopyUser interface {
	UsesWorkingCopy() bool
}

// ToolsetUser is implemented by Checks that run tools from the toolset volume.
// The engine fills the volume during the Preparation phase when any planned
// Check in any Context uses the toolset.
type ToolsetUser interface {
	// UsesToolset says whether the Check will mount the toolset volume in the
	// Context. It works on discovery data only.
	UsesToolset(c *discovery.Context) bool
}

// AdvisoryDBUser is implemented by Checks that scan with the offline advisory
// database. The engine downloads or refreshes the database during the
// Preparation phase, under the host-side lock, when any planned Check in any
// Context uses it.
type AdvisoryDBUser interface {
	// UsesAdvisoryDB says whether the Check will mount the advisory database
	// volume in the Context. It works on discovery data only.
	UsesAdvisoryDB(c *discovery.Context) bool
}

// KubernetesSchemaUser is implemented by Checks that validate with the
// Kubernetes schemas. The engine fetches them into their cache volume during
// the Preparation phase, under the host-side lock, when any planned Check in
// any Context uses them.
type KubernetesSchemaUser interface {
	// UsesKubernetesSchemas says whether the Check will mount the schema volume
	// in the Context. It works on discovery data only.
	UsesKubernetesSchemas(c *discovery.Context) bool
}

// TestCodeNoter is implemented by Checks whose Findings in Test code say so in
// their message. A Check cannot tell itself whether a co-located spec is Test
// code, because the test file probe of its package may still be running when
// it returns. The engine learns the File class when it assembles the Report,
// sets in_test_code there and appends the note to the message.
type TestCodeNoter interface {
	// TestCodeNote returns the sentence to append to the message of a Finding
	// whose primary location is Test code, or "" to leave it as it is.
	TestCodeNote(f resultset.Finding) string
}

// Input is everything a Check execution may use.
type Input struct {
	Project *discovery.Project
	Context *discovery.Context

	// OriginalPath is the absolute path of the Original, for re-run commands.
	OriginalPath string
	// SnapshotDir is the host-side copy of the Snapshot, for native Checks.
	SnapshotDir string
	// Docker creates the containers of the Run. SnapshotVolume holds the
	// Snapshot and Network is the Run's internal Execution-phase network.
	Docker         *docker.Driver
	SnapshotVolume string
	Network        string
	// WorkVolume holds the Working copy, with the installed dependencies of
	// every package whose install completed. Empty when no Check of the Run
	// uses the Working copy.
	WorkVolume string
	// SnapshotTar writes the Snapshot as a tar archive, for Checks that need
	// their own copy of it in a volume.
	SnapshotTar func(io.Writer) error

	// --- toolset volume (ticket 14) ---
	// ToolsetVolume names the volume that holds the pinned npm tools; mount it
	// read-only at toolvolume.MountPath. It is empty when the Preparation phase
	// could not provide it, and ToolsetError then says why.
	ToolsetVolume string
	ToolsetError  string
	// --- end toolset volume ---

	// --- advisory database (ticket 26) ---
	// AdvisoryVolume names the volume that holds the offline advisory
	// database; mount it read-only at toolvolume.AdvisoryMountPath. It is empty
	// when the Preparation phase could not provide it, and AdvisoryError then
	// says why. AdvisoryDate is when the database was downloaded, and
	// AdvisoryWarning is set when it is older than a day because the refresh
	// failed.
	AdvisoryVolume  string
	AdvisoryDate    time.Time
	AdvisoryWarning string
	AdvisoryError   string
	// --- end advisory database ---

	// --- Kubernetes schemas ---
	// KubernetesSchemaVolume names the volume that holds the Kubernetes
	// schemas; mount it read-only at toolvolume.KubernetesSchemaMountPath. It
	// is empty when the Preparation phase could not provide it, and
	// KubernetesSchemaError then says why.
	KubernetesSchemaVolume string
	KubernetesSchemaError  string
	// --- end Kubernetes schemas ---

	// RedactText removes the secret values the Run knows from a text, such as
	// the log of a Service that echoes a value of the project's .env file. Nil
	// means nothing is redacted. It is safe for concurrent use.
	RedactText func(string) string

	// Selection is what the Run covers, for Checks that share a step with other
	// Checks and switch on only the parts of selected ones. Nil means all.
	Selection *Selection
	// Shared holds the results that Checks of the Run share. Nil means no
	// sharing.
	Shared *Shared

	// suiteIndex says which suite of the package's tests the Input is bound to
	// (see forSuite). Zero for an Input that was not bound.
	suiteIndex int
	// repeat is set on an Input bound to a further run of a suite (see
	// forRepeat). Nil for the shared first run.
	repeat *repeatRun
	// coverageVolume is the run-owned volume that every suite of the package
	// writes raw V8 coverage into when tests.coverage is selected, and
	// coverageError says why there is none (see runSuites).
	coverageVolume, coverageError string
}

// Result is what one Check execution reports.
type Result struct {
	Status      resultset.ExecStatus
	ReasonCode  string
	Reason      string
	Findings    []resultset.Finding
	Metrics     []resultset.Metric
	Limitations []resultset.Limitation
	// Inventory is the part of the Report's Inventory this execution
	// contributes. The engine appends every execution's slices to the Report.
	Inventory *resultset.Inventory
	// Artifacts are files the Check adds to the report folder. Give each a key
	// in ID that is unique within the Check; the engine fills CheckID and
	// Finalize assigns the final ID and the digest.
	Artifacts []resultset.Artifact
	// TestCases are the test cases of a suite execution, passed ones included.
	// Their Findings are positions in Findings; the engine turns them into
	// finding IDs.
	TestCases []SuiteTestCase
	Tool      *resultset.Tool
	// ToolRefs are the pinned tools the Check ran. The engine records them in
	// the Context the Check ran in.
	ToolRefs []resultset.ToolRef
	// Command is the command the Check ran, as an argument array.
	Command []string
	// NPMVersion is the npm version of the Context's image, when the Check
	// found it. The engine records it in the Context.
	NPMVersion string
	// RegistryDataDate is when the registry data the Check read was fetched, or
	// the zero time. The engine records the oldest of them in the Report.
	RegistryDataDate time.Time
	// Redact holds secret values the Check found. The engine redacts them from
	// everything it writes, whether or not the Check is selected. They live
	// in memory only and never enter the Report.
	Redact []string
	// ContextTools are the tools the Check used. The engine records them in
	// the Context of the execution.
	ContextTools []resultset.ToolRef

	// coverage is what a test suite run recorded for tests.coverage, which
	// shares the run with tests.existing. It never leaves the package.
	coverage *coverageRun
	// Services are the test Services the execution started or failed to start,
	// one per compose service, with its own Context as the only Context ID.
	// The engine merges them over the executions into the Report's services.
	Services []resultset.Service

	// suite is what a test run left for the Checks that read the same run,
	// such as runtime.warnings. Only tests.existing sets it.
	suite *suiteRun
	// mayNeed are the compose Services the suite of the run may need and the
	// Run did not start, as markServicesNotStarted found them. The Checks that
	// read the run note them on their Findings.
	mayNeed []string
	// parts are the results of the suites of a package with several, in list
	// order. Only the merged result of such a package has them.
	parts []*Result

	// KeepsStatus says that the Check watched its own limits and its status
	// stands even when the Budget or the time limit ended the execution. The
	// engine otherwise replaces the status of an execution that did not
	// complete with the reason it ended (budget_exhausted, timed_out). A
	// cancellation by the user is always left to the engine.
	KeepsStatus bool
}

// registry maps Check IDs to implementations. It is filled by init functions.
var registry = map[string]Check{}

// Register makes an implementation of a catalog Check available. It panics for
// an ID that is not in the Catalog or is registered twice, because both are
// programming errors found by any test run.
func Register(id string, c Check) {
	if _, ok := Lookup(id); !ok {
		panic(fmt.Sprintf("checks: %q is not in the Catalog", id))
	}
	if _, dup := registry[id]; dup {
		panic(fmt.Sprintf("checks: %q registered twice", id))
	}
	registry[id] = c
}

// Implementation returns the registered implementation, or nil.
func Implementation(id string) Check { return registry[id] }

// Catalog returns every Check in catalog order with its current status.
func Catalog() []Entry {
	out := make([]Entry, 0, len(catalog))
	for _, m := range catalog {
		out = append(out, entryOf(m))
	}
	return out
}

// Lookup returns one Catalog entry.
func Lookup(id string) (Entry, bool) {
	for _, m := range catalog {
		if m.id == id {
			return entryOf(m), true
		}
	}
	return Entry{}, false
}

// ImplementedIDs returns the IDs of the implemented Checks in catalog order.
func ImplementedIDs() []string {
	var ids []string
	for _, e := range Catalog() {
		if e.Status == Implemented {
			ids = append(ids, e.ID)
		}
	}
	return ids
}

func entryOf(m meta) Entry {
	family := m.id
	for i := 0; i < len(m.id); i++ {
		if m.id[i] == '.' {
			family = m.id[:i]
			break
		}
	}
	status := Planned
	if _, ok := registry[m.id]; ok {
		status = Implemented
	}
	return Entry{
		ID: m.id, Family: family, Description: m.desc, Scope: m.scope,
		CanFireGates: m.gates, Area: m.area, Status: status, SkippedByFast: skippedByFast[m.id],
	}
}
