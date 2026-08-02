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
var pngBytes = []byte{
	0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x0d, 'I', 'H', 'D', 'R',
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
}

func TestSaveWritesAnImage(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	path, err := s.Save(bytes.NewReader(pngBytes))
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

func TestSaveRefusesWhatIsNotAnImage(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	if _, err := s.Save(strings.NewReader("#!/bin/sh\nrm -rf /\n")); err == nil {
		t.Fatal("a shell script was accepted as an image")
	}
	entries, _ := os.ReadDir(s.Dir)
	if len(entries) != 0 {
		t.Errorf("a refused upload left %d file(s) behind", len(entries))
	}
}

func TestSaveRefusesAnEmptyBody(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	if _, err := s.Save(strings.NewReader("")); err == nil {
		t.Fatal("an empty upload was accepted")
	}
}

func TestSaveRefusesOversize(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	big := append(append([]byte{}, pngBytes...), bytes.Repeat([]byte{0}, MaxBytes)...)
	if _, err := s.Save(bytes.NewReader(big)); err == nil {
		t.Fatal("an image over the cap was accepted")
	}
	entries, _ := os.ReadDir(s.Dir)
	if len(entries) != 0 {
		t.Errorf("a rejected oversize upload left %d file(s) behind", len(entries))
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
	fresh, err := s.Save(bytes.NewReader(pngBytes))
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
	if _, err := s.Save(bytes.NewReader(pngBytes)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(recent); err != nil {
		t.Errorf("a fresh image was swept away: %v", err)
	}
}
