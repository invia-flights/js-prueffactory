// Package render turns a result set into report.json and report.md. It is the
// other half of test seam B: hand-made results in, rendered reports out.
package render

import (
	"bytes"
	"encoding/json"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// JSON renders the result set as one UTF-8 JSON document with a trailing newline.
func JSON(s *resultset.Set) ([]byte, error) {
	s.Normalize()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(s); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
