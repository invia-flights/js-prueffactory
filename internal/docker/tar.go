package docker

import (
	"archive/tar"
	"bytes"
	"fmt"
	"path"
	"sort"
	"strings"
)

func sortStrings(s []string) { sort.Strings(s) }

// TarFiles packs files into a tar archive rooted at "/", with the parent
// folders as explicit entries and everything owned by root.
func TarFiles(files []File) ([]byte, error) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	dirs := map[string]bool{}
	sorted := append([]File(nil), files...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Path < sorted[j].Path })
	for _, f := range sorted {
		if !strings.HasPrefix(f.Path, "/") {
			return nil, fmt.Errorf("container path %q is not absolute", f.Path)
		}
		name := strings.TrimPrefix(path.Clean(f.Path), "/")
		var parents []string
		for dir := path.Dir(name); dir != "." && dir != "/"; dir = path.Dir(dir) {
			parents = append([]string{dir}, parents...)
		}
		for _, dir := range parents {
			if dirs[dir] {
				continue
			}
			dirs[dir] = true
			if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeDir, Name: dir + "/", Mode: 0o755}); err != nil {
				return nil, err
			}
		}
		mode := f.Mode
		if mode == 0 {
			mode = 0o644
		}
		if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: name, Mode: mode, Size: int64(len(f.Content))}); err != nil {
			return nil, err
		}
		if _, err := tw.Write(f.Content); err != nil {
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
