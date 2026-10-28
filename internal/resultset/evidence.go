package resultset

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"unicode/utf8"
)

// evidenceKindStackTrace is the evidence kind whose frames are counted.
const evidenceKindStackTrace = "stack_trace"

// capEvidence cuts every evidence text that is over the caps and keeps the
// full text in an artifact. A stack trace keeps at most MaxStackFrames frames,
// and every text is cut to MaxEvidenceBytes at a character boundary. The item
// records the size of the original text and the artifact that holds it.
//
// It runs before IDs are assigned: the artifact gets a temporary ID and a path
// made from the SHA-256 of its content, so neither depends on arrival order.
func (s *Set) capEvidence() {
	execByKey := make(map[string]*Execution, len(s.Checks))
	for i := range s.Checks {
		execByKey[s.Checks[i].ID] = &s.Checks[i]
	}
	have := map[string]string{} // content hash -> temporary artifact ID
	for i := range s.Findings {
		f := &s.Findings[i]
		for k := range f.Evidence {
			ev := &f.Evidence[k]
			if ev.OriginalSize != nil {
				continue // already cut by whoever produced it
			}
			capped := capText(ev.Kind, ev.Text)
			if capped == ev.Text {
				continue
			}
			sum := sha256.Sum256([]byte(ev.Text))
			hash := hex.EncodeToString(sum[:])
			key, ok := have[hash]
			if !ok {
				key = "evidence-" + hash[:16]
				have[hash] = key
				s.Artifacts = append(s.Artifacts, Artifact{
					ID: key, Path: "artifacts/evidence/" + hash[:16] + ".txt", MediaType: "text/plain; charset=utf-8",
					CheckID: f.CheckID, Content: []byte(ev.Text),
				})
			}
			size := len(ev.Text)
			ev.Text, ev.OriginalSize, ev.ArtifactID = capped, &size, &key
			if e := execByKey[f.ExecutionID]; e != nil && !containsString(e.ArtifactIDs, key) {
				e.ArtifactIDs = append(e.ArtifactIDs, key)
			}
		}
	}
}

func containsString(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// capText applies the frame limit and the byte cap.
func capText(kind, text string) string {
	if kind == evidenceKindStackTrace {
		text = capFrames(text)
	}
	if len(text) <= MaxEvidenceBytes {
		return text
	}
	cut := MaxEvidenceBytes
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut]
}

// isFrame says whether a stack trace line is a frame, as in "    at fn (file:1:2)".
func isFrame(line string) bool { return strings.HasPrefix(strings.TrimSpace(line), "at ") }

// capFrames keeps the lines up to and including the MaxStackFrames-th frame.
func capFrames(text string) string {
	lines := strings.Split(text, "\n")
	frames := 0
	for i, l := range lines {
		if !isFrame(l) {
			continue
		}
		frames++
		if frames > MaxStackFrames {
			return strings.Join(lines[:i], "\n")
		}
	}
	return text
}

// countFrames is what the validator uses.
func countFrames(text string) int {
	n := 0
	for _, l := range strings.Split(text, "\n") {
		if isFrame(l) {
			n++
		}
	}
	return n
}

// fillArtifactDigests sets the size and SHA-256 of every artifact whose bytes
// are in the result set.
func (s *Set) fillArtifactDigests() {
	for i := range s.Artifacts {
		a := &s.Artifacts[i]
		if a.Content == nil {
			continue
		}
		sum := sha256.Sum256(a.Content)
		a.SHA256, a.Size = hex.EncodeToString(sum[:]), int64(len(a.Content))
	}
}
