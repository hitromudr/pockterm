package upload

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A one-pixel PNG: enough bytes for the sniffer to recognise the format.
// The head of an mp4: a `ftyp` box, which is what http.DetectContentType reads
// to answer video/mp4. Measured rather than assumed — the same call answers
// application/octet-stream for a QuickTime brand it does not know.
var mp4Bytes = append([]byte{
	0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p', 'm', 'p', '4', '2',
	0x00, 0x00, 0x00, 0x00, 'm', 'p', '4', '2', 'i', 's', 'o', 'm',
}, make([]byte, 40)...)

var pngBytes = []byte{
	0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x0d, 'I', 'H', 'D', 'R',
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
}

func TestSaveWritesAnImage(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	path, err := s.Save(bytes.NewReader(pngBytes), "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(path, ".png") {
		t.Errorf("extension should come from the sniffed type, got %q", path)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, pngBytes) {
		t.Errorf("stored %d bytes, uploaded %d", len(got), len(pngBytes))
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// A screenshot can show anything that was on the screen.
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode is %v, want 0600", info.Mode().Perm())
	}
}

// An upload nobody named has to be an image: there is nothing to call it
// otherwise, and nothing in the bytes that would say what it is.
func TestSaveRefusesWhatIsNeitherNamedNorAnImage(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	if _, err := s.Save(strings.NewReader("#!/bin/sh\nrm -rf /\n"), ""); err == nil {
		t.Fatal("an unnamed shell script was accepted")
	}
	entries, _ := os.ReadDir(s.Dir)
	if len(entries) != 0 {
		t.Errorf("a refused upload left %d file(s) behind", len(entries))
	}
}

// A document is taken on its name, because a Makefile, a patch and a note are
// one content type between them and the extension is what tells them apart.
func TestSaveWritesANamedDocument(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	body := "%PDF-1.7\nbody of the spec\n"
	path, err := s.Save(strings.NewReader(body), "спецификация.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(path, "-спецификация.pdf") {
		t.Errorf("the name the browser gave should be on the file, got %q", path)
	}
	if !strings.HasPrefix(filepath.Base(path), "paste-") {
		t.Errorf("a saved file is still a paste-*, got %q", path)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != body {
		t.Errorf("stored %q, uploaded %q", got, body)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// A document can hold anything a screenshot can.
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode is %v, want 0600", info.Mode().Perm())
	}
}

// A document with no extension at all is still a document: `Makefile` and
// `Dockerfile` are names an agent reads.
func TestSaveKeepsANameWithNoExtension(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	path, err := s.Save(strings.NewReader("all:\n\techo hi\n"), "Makefile")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(path, "-Makefile") {
		t.Errorf("got %q, want a file ending in -Makefile", path)
	}
}

// The bytes decide what an image is called, the name only labels it: a name
// claiming another format does not change what is in the file.
func TestSaveKeepsTheStemOfANamedImageAndTheExtensionOfItsBytes(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	path, err := s.Save(bytes.NewReader(pngBytes), "shot.jpeg")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(path, "-shot.png") {
		t.Errorf("got %q, want the sniffed .png under the given stem", path)
	}
}

// The name reaches a path and then a line typed into a pane: what could be a
// directory, an option or a second word is replaced rather than refused.
func TestSaveFiltersTheNameItIsGiven(t *testing.T) {
	cases := []struct {
		name, want string
	}{
		{"../../etc/passwd", "-passwd"},
		{`C:\Users\dms\notes.txt`, "-notes.txt"},
		{"two words; rm -rf ~.md", "-two-words-rm-rf-.md"},
		{".hidden.txt", "-hidden.txt"},
		{"-rf.txt", "-rf.txt"},
		{strings.Repeat("длинное-имя-", 20) + ".md", ""}, // only the bound is checked below
	}
	for _, c := range cases {
		s := Store{Dir: t.TempDir()}
		path, err := s.Save(strings.NewReader("text of the note\n"), c.name)
		if err != nil {
			// Errorf rather than Fatalf: each case is its own way to be
			// wrong, and the first one refusing must not hide the rest.
			t.Errorf("%q: %v", c.name, err)
			continue
		}
		base := filepath.Base(path)
		if c.want != "" && !strings.HasSuffix(base, c.want) {
			t.Errorf("%q became %q, want it to end in %q", c.name, base, c.want)
		}
		if strings.ContainsAny(base, "/\\ \t\"';|&$*?<>") {
			t.Errorf("%q became %q, which is not one word on a terminal line", c.name, base)
		}
	}
}

// Long names are cut out of the middle: the extension is the half an agent
// reads, and the random part is what makes the path unique anyway.
func TestSaveCutsALongNameButKeepsItsExtension(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	path, err := s.Save(strings.NewReader("text of the note\n"), strings.Repeat("very-long-name-", 20)+".md")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(path, ".md") {
		t.Errorf("got %q, want the extension kept", path)
	}
	if got := len([]rune(filepath.Base(path))); got > 120 {
		t.Errorf("the name came out %d runes long: %q", got, filepath.Base(path))
	}
}

// A name made only of what has to go is no name at all, and then the old
// rule stands: an image or nothing.
func TestSaveRefusesADocumentWhoseNameFiltersAway(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	if _, err := s.Save(strings.NewReader("text of the note\n"), "../"); err == nil {
		t.Fatal("a document with nothing left of its name was accepted")
	}
	entries, _ := os.ReadDir(s.Dir)
	if len(entries) != 0 {
		t.Errorf("a refused upload left %d file(s) behind", len(entries))
	}
}

// A film picked from the gallery is a document as far as this package is
// concerned: the bytes are sniffed as video, which is not in byType, so what
// decides is the name the browser gave it. Worth a test of its own because the
// clip offers `video/*` as a source of its own, and "the source exists but the
// store refuses what it hands over" is the failure that would follow.
func TestSaveTakesAVideoByItsName(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	path, err := s.Save(bytes.NewReader(mp4Bytes), "VID_20260825_120958.mp4")
	if err != nil {
		t.Fatalf("a named video was refused: %v", err)
	}
	if !strings.HasSuffix(path, ".mp4") {
		t.Errorf("kept as %q, wanted the browser's own extension", filepath.Base(path))
	}
	// And unnamed it is refused, for the same reason a note is: there is no
	// extension to give an agent, and nothing in the bytes supplies one.
	if _, err := s.Save(bytes.NewReader(mp4Bytes), ""); err == nil {
		t.Error("an unnamed video was accepted")
	}
}

func TestSaveRefusesAnEmptyBody(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	if _, err := s.Save(strings.NewReader(""), "notes.txt"); err == nil {
		t.Fatal("an empty upload was accepted")
	}
}

func TestSaveRefusesOversize(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	big := append(append([]byte{}, pngBytes...), bytes.Repeat([]byte{0}, MaxBytes)...)
	if _, err := s.Save(bytes.NewReader(big), ""); err == nil {
		t.Fatal("an image over the cap was accepted")
	}
	entries, _ := os.ReadDir(s.Dir)
	if len(entries) != 0 {
		t.Errorf("a rejected oversize upload left %d file(s) behind", len(entries))
	}
}

// A store with a size of its own, which is what keeps a day of films off the
// disk: Keep answers "how long", and while a file was a screenshot that was
// enough arithmetic — a day of them is tens of megabytes. One upload may now be
// 100 MB, so the total is bounded too, and the oldest files are what leave.
func TestSaveKeepsTheStoreUnderItsTotal(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	// 300 bytes of room, four files of ~130: two of them cannot stay.
	s := Store{Dir: dir, Total: 300, Now: func() time.Time { return now }}
	body := append(append([]byte{}, pngBytes...), bytes.Repeat([]byte{0}, 100)...)
	var paths []string
	for i := 0; i < 4; i++ {
		p, err := s.Save(bytes.NewReader(body), "")
		if err != nil {
			t.Fatalf("upload %d refused: %v", i, err)
		}
		paths = append(paths, p)
		// Ages them apart: what leaves is decided by mtime, and four files
		// written in the same millisecond have no oldest.
		if err := os.Chtimes(p, now, now.Add(time.Duration(i)*time.Minute)); err != nil {
			t.Fatal(err)
		}
	}

	var total int64
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			t.Fatal(err)
		}
		total += info.Size()
	}
	if total > 300 {
		t.Errorf("the store holds %d bytes, over its own cap of 300", total)
	}
	// The last upload is the one whose path was just handed out: an agent opens
	// it a second later, so it is the one file the sweep may not take.
	if _, err := os.Stat(paths[len(paths)-1]); err != nil {
		t.Errorf("the newest upload was swept: %v", err)
	}
	// And what left is the oldest, not an arbitrary one.
	if _, err := os.Stat(paths[0]); err == nil {
		t.Error("the oldest upload stayed while the store was over its cap")
	}
}

// The bound above must not eat the file that has just arrived, even when that
// one file is the whole store. A cap smaller than the upload is the case that
// used to be arithmetic nobody wrote down.
func TestSaveKeepsTheFileItJustSaved(t *testing.T) {
	dir := t.TempDir()
	s := Store{Dir: dir, Total: 1}
	path, err := s.Save(bytes.NewReader(pngBytes), "")
	if err != nil {
		t.Fatalf("refused: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the path handed to the page is gone: %v", err)
	}
}

func TestSavePrunesOldImages(t *testing.T) {
	dir := t.TempDir()
	stale := filepath.Join(dir, "paste-old.png")
	if err := os.WriteFile(stale, pngBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * Keep)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}

	s := Store{Dir: dir}
	fresh, err := s.Save(bytes.NewReader(pngBytes), "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("an image older than %s survived the sweep", Keep)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Errorf("the image just saved was swept away: %v", err)
	}
}

func TestSaveKeepsImagesInsideTheWindow(t *testing.T) {
	dir := t.TempDir()
	recent := filepath.Join(dir, "paste-recent.png")
	if err := os.WriteFile(recent, pngBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	s := Store{Dir: dir}
	if _, err := s.Save(bytes.NewReader(pngBytes), ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(recent); err != nil {
		t.Errorf("a fresh image was swept away: %v", err)
	}
}
