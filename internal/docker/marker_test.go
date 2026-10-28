package docker

import (
	"bytes"
	"testing"
)

func TestTheMarkerWriterSeesAMarkerEvenWhenItIsSplitAcrossWrites(t *testing.T) {
	var seen int
	var dst bytes.Buffer
	w := &markerWriter{dst: &dst, marker: []byte("@@END-1f2e@@"), onSeen: func() { seen++ }}

	for _, chunk := range []string{"test output\n@@EN", "D-1f", "2e@@\nmore"} {
		n, err := w.Write([]byte(chunk))
		if err != nil || n != len(chunk) {
			t.Fatalf("Write(%q) = %d, %v", chunk, n, err)
		}
	}

	if seen != 1 {
		t.Errorf("the marker was seen %d times, want once", seen)
	}
	if dst.String() != "test output\n@@END-1f2e@@\nmore" {
		t.Errorf("the writer passes everything on, got %q", dst.String())
	}
}

func TestTheMarkerWriterIgnoresTextThatOnlyLooksLikeTheMarker(t *testing.T) {
	var seen int
	w := &markerWriter{dst: &bytes.Buffer{}, marker: []byte("@@END-1f2e@@"), onSeen: func() { seen++ }}

	_, _ = w.Write([]byte("@@END-1f2e@ @@END-0000@@ END"))

	if seen != 0 {
		t.Errorf("seen = %d", seen)
	}
}

func TestStripMarkerRemovesTheMarkerLineFromCapturedOutput(t *testing.T) {
	got := stripMarker([]byte("a\n@@END-1@@\nb\n"), []byte("@@END-1@@"))
	if string(got) != "a\nb\n" {
		t.Errorf("got %q", got)
	}
	got = stripMarker([]byte("a\n@@END-1@@"), []byte("@@END-1@@"))
	if string(got) != "a\n" {
		t.Errorf("a marker at the very end: got %q", got)
	}
}
