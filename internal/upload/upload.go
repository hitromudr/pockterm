// Package upload stores images pasted in the browser as files on disk.
//
// Only keystrokes travel to the pty, so an image cannot be "pasted into the
// terminal" at all. What can travel is a path: the browser hands the bytes
// over here, and the terminal receives the name of the file they landed in.
package upload

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// MaxBytes caps a single image. A phone screenshot is well under it; larger
// is either a mistake or an attempt to fill the disk of a box that also
// serves git and passwords.
const MaxBytes = 10 << 20

// Keep is how long a saved image stays on disk. Nobody comes back to clean
// up, and the file is only needed while the agent reads it.
const Keep = 24 * time.Hour

// byType maps a sniffed content type to the extension the file gets. The
// map doubles as the allowlist: anything not in it is refused.
var byType = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

type Store struct {
	Dir string
	Now func() time.Time // nil means time.Now
}

func (s Store) now() time.Time {
	if s.Now == nil {
		return time.Now()
	}
	return s.Now()
}

// Save writes r into the store and returns the path of the new file.
//
// The content type the browser declares is its word for it; the type used
// here is sniffed from the bytes, because this path ends in a file an agent
// will open.
func (s Store) Save(r io.Reader) (string, error) {
	head := make([]byte, 512)
	n, err := io.ReadFull(r, head)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return "", err
	}
	head = head[:n]
	if len(head) == 0 {
		return "", fmt.Errorf("empty upload")
	}
	kind := strings.TrimSpace(strings.Split(http.DetectContentType(head), ";")[0])
	ext, ok := byType[kind]
	if !ok {
		return "", fmt.Errorf("not an image (looks like %s)", kind)
	}

	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return "", err
	}
	// CreateTemp both picks a free name and creates the file 0600 — the
	// image may be a screenshot of anything.
	f, err := os.CreateTemp(s.Dir, "paste-"+s.now().Format("20060102-150405")+"-*"+ext)
	if err != nil {
		return "", err
	}
	defer f.Close()

	// One byte over the cap is enough to know it is over: read that byte,
	// then throw the whole thing away.
	body := io.MultiReader(bytes.NewReader(head), io.LimitReader(r, MaxBytes+1-int64(len(head))))
	written, err := io.Copy(f, body)
	if err != nil {
		os.Remove(f.Name())
		return "", err
	}
	if written > MaxBytes {
		os.Remove(f.Name())
		return "", fmt.Errorf("image is larger than %d bytes", MaxBytes)
	}

	s.prune()
	return f.Name(), nil
}

// prune drops images older than Keep. Doing it on the way in keeps the
// store free of timers: uploads are the only thing that grows this
// directory, so they are also the only moment it needs sweeping.
func (s Store) prune() {
	entries, err := os.ReadDir(s.Dir)
	if err != nil {
		return
	}
	cutoff := s.now().Add(-Keep)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		os.Remove(filepath.Join(s.Dir, e.Name()))
	}
}
