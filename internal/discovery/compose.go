package discovery

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// ComposeService is one service of the project's compose files: either a test
// Service the Run starts for its test suites, or one it never starts.
type ComposeService struct {
	// Name is the compose service name. It is the host name tests reach the
	// Service under.
	Name string
	// File is the compose file whose entry names the image, relative to the
	// project root.
	File string
	// Declared is the image as the compose file names it, interpolated as far
	// as the project's .env file allows.
	Declared string
	// Family is the test Service family, such as "valkey", or "" for a service
	// that is not a test Service.
	Family string
	// NotStarted says why the Run never starts the service. It is nil for a test
	// Service the Run starts, also when its variables are unresolved.
	NotStarted *Unsupported
	// Env holds the service's `environment` entries, interpolated from the
	// project's .env file. Only test Services have it.
	Env map[string]string
	// Unresolved names the variables of Env that neither the .env file nor a
	// default can answer, sorted. The service is blocked while there are any.
	Unresolved []string
	// VersionDiffers is true when the compose file asks for another version
	// than the pinned one.
	VersionDiffers bool
}

// Startable says whether the Run starts the service, unresolved variables aside.
func (s ComposeService) Startable() bool { return s.Family != "" && s.NotStarted == nil }

// ComposeProblem is a compose file that could not be read.
type ComposeProblem struct {
	Path   string
	Reason string
}

const maxComposeBytes = 1 << 20

// composeFile matches the compose files of the project root.
var composeFile = regexp.MustCompile(`^(docker-compose|compose)[^/]*\.ya?ml$`)

// IsComposeFile says whether a project root file name is one of the compose
// files that discovery reads.
func IsComposeFile(name string) bool { return composeFile.MatchString(name) }

var serviceName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$`)

var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// readCompose reads the compose files in the project root, merges them the way
// compose merges an override file and returns the services sorted by name.
// Files in subfolders are not read, and neither is anything outside root.
func readCompose(root string) ([]ComposeService, []ComposeProblem) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, nil
	}
	var names []string
	for _, e := range entries {
		if composeFile.MatchString(e.Name()) && e.Type().IsRegular() {
			names = append(names, e.Name())
		}
	}
	// Base files first, then override files, each sorted: later files win.
	sort.SliceStable(names, func(i, j int) bool {
		oi, oj := strings.Contains(names[i], "override"), strings.Contains(names[j], "override")
		if oi != oj {
			return !oi
		}
		return names[i] < names[j]
	})
	dotenv := readDotEnv(filepath.Join(root, ".env"))

	var problems []ComposeProblem
	merged := map[string]*rawService{}
	for _, name := range names {
		data, err := readComposeFile(filepath.Join(root, name))
		if err != nil {
			problems = append(problems, ComposeProblem{Path: name, Reason: err.Error()})
			continue
		}
		var doc struct {
			Services map[string]*struct {
				Image       string `yaml:"image"`
				Build       any    `yaml:"build"`
				Environment any    `yaml:"environment"`
			} `yaml:"services"`
		}
		if err := yaml.Unmarshal(data, &doc); err != nil {
			problems = append(problems, ComposeProblem{Path: name, Reason: "it is not valid YAML of the compose format: " + firstLine(err.Error())})
			continue
		}
		for svc, def := range doc.Services {
			m := merged[svc]
			if m == nil {
				m = &rawService{env: map[string]envValue{}}
				merged[svc] = m
			}
			if def == nil {
				continue
			}
			if def.Image != "" {
				m.image, m.file = def.Image, name
			}
			if def.Build != nil {
				m.build = true
			}
			mergeEnvironment(m.env, def.Environment)
		}
	}

	out := make([]ComposeService, 0, len(merged))
	for name, m := range merged {
		out = append(out, m.resolve(name, dotenv))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, problems
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return line
}

// readComposeFile reads a regular file of at most maxComposeBytes. A symbolic
// link is refused, so that nothing outside the project is read.
func readComposeFile(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("it is not a regular file")
	}
	if info.Size() > maxComposeBytes {
		return nil, fmt.Errorf("it is larger than %d bytes", maxComposeBytes)
	}
	return os.ReadFile(path)
}

// envValue is one `environment` entry before interpolation. fromEnvFile marks
// an entry without a value, which compose takes from the environment.
type envValue struct {
	raw         string
	fromEnvFile bool
}

type rawService struct {
	image string
	file  string
	build bool
	env   map[string]envValue
}

// mergeEnvironment adds the entries of an `environment` section, in map or list
// form, over the ones already there.
func mergeEnvironment(into map[string]envValue, section any) {
	switch e := section.(type) {
	case map[string]any:
		for k, v := range e {
			if v == nil {
				into[k] = envValue{fromEnvFile: true}
				continue
			}
			into[k] = envValue{raw: scalarText(v)}
		}
	case []any:
		for _, item := range e {
			s, ok := item.(string)
			if !ok {
				continue
			}
			if k, v, found := strings.Cut(s, "="); found {
				into[k] = envValue{raw: v}
			} else {
				into[s] = envValue{fromEnvFile: true}
			}
		}
	}
}

func scalarText(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	default:
		return fmt.Sprint(x)
	}
}

// resolve turns the merged entry into a ComposeService.
func (m *rawService) resolve(name string, dotenv map[string]string) ComposeService {
	s := ComposeService{Name: name, File: m.file}
	notStarted := func(code, reason string) ComposeService {
		s.NotStarted = &Unsupported{Code: code, Reason: reason}
		return s
	}

	image, imageUnresolved := interpolate(m.image, dotenv)
	s.Declared = image
	if imageUnresolved != nil {
		s.Declared = m.image
	}
	switch {
	case !serviceName.MatchString(name):
		return notStarted("invalid_service_name", "the service name is not usable as a host name")
	case m.build:
		return notStarted("build_section", "the service has a build section, so it is the project's own code and not a test Service")
	case m.image == "":
		return notStarted("no_image", "the service names no image")
	case imageUnresolved != nil:
		return notStarted("unknown_image", "the image name uses variables the .env file does not answer: "+strings.Join(imageUnresolved, ", "))
	}

	ref := parseImage(image)
	if ref.registry != "" {
		return notStarted("private_registry", fmt.Sprintf("the image comes from the registry %s, and only official Docker Hub images are started", ref.registry))
	}
	family, ok := toolset.ServiceFamilyOf(ref.repo)
	if !ok {
		return notStarted("unknown_image", fmt.Sprintf("the image %s belongs to no known test Service family", ref.repo))
	}
	s.Family = family.Name
	s.VersionDiffers = versionDiffers(ref, family)

	s.Env = map[string]string{}
	unresolved := map[string]bool{}
	for k, v := range m.env {
		if !envName.MatchString(k) {
			continue
		}
		if v.fromEnvFile {
			if val, ok := dotenv[k]; ok {
				s.Env[k] = val
			}
			continue
		}
		val, missing := interpolate(v.raw, dotenv)
		for _, name := range missing {
			unresolved[name] = true
		}
		s.Env[k] = val
	}
	for name := range unresolved {
		s.Unresolved = append(s.Unresolved, name)
	}
	sort.Strings(s.Unresolved)
	return s
}

// imageRef is a parsed image reference.
type imageRef struct {
	registry string // host of a registry other than Docker Hub, or ""
	repo     string // repository on Docker Hub without "library/"
	tag      string
	digest   string
}

var dockerHubHosts = map[string]bool{"docker.io": true, "index.docker.io": true, "registry-1.docker.io": true}

func parseImage(image string) imageRef {
	var ref imageRef
	rest := image
	if at := strings.Index(rest, "@"); at >= 0 {
		rest, ref.digest = rest[:at], rest[at+1:]
	}
	if colon := strings.LastIndex(rest, ":"); colon > strings.LastIndex(rest, "/") {
		rest, ref.tag = rest[:colon], rest[colon+1:]
	}
	if first, remainder, ok := strings.Cut(rest, "/"); ok && (strings.ContainsAny(first, ".:") || first == "localhost") {
		if dockerHubHosts[first] {
			rest = remainder
		} else {
			ref.registry = first
			ref.repo = remainder
			return ref
		}
	}
	ref.repo = strings.TrimPrefix(rest, "library/")
	return ref
}

// versionDiffers says whether the compose file asks for another version series
// than the family's pinned image. A missing tag, `latest` and tags that are no
// version, such as `alpine`, ask for no particular version.
func versionDiffers(ref imageRef, family toolset.ServiceFamily) bool {
	if ref.digest != "" && ref.digest != family.Image.Digest {
		return true
	}
	want := versionParts(ref.tag)
	have := versionParts(family.Version)
	for i := 0; i < len(want) && i < len(have); i++ {
		if want[i] != have[i] {
			return true
		}
	}
	return false
}

// versionParts reads the leading numbers of a tag: "8.1-alpine" is [8 1].
func versionParts(tag string) []int {
	end := 0
	for end < len(tag) && (tag[end] >= '0' && tag[end] <= '9' || tag[end] == '.') {
		end++
	}
	var parts []int
	for _, p := range strings.Split(strings.Trim(tag[:end], "."), ".") {
		n, err := strconv.Atoi(p)
		if err != nil {
			break
		}
		parts = append(parts, n)
	}
	return parts
}
