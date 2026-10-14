package pockterm

import (
	"bytes"
	"io/fs"
)

// version is stamped by the build (-ldflags "-X …/pockterm.version=…", see
// make/go.mk), computed from the git history by tools/version.sh. A plain
// `go build` or `go test` leaves it empty.
var version string

// Version returns what this binary is: MAJOR.MINOR.PATCH, or 0.0.0-dev for a
// build that was not stamped.
func Version() string {
	if version == "" {
		return "0.0.0-dev"
	}
	return version
}

// versionMark is what the page's sources say in place of a number. The binary
// writes its own version over it as it serves them, so the page, the service
// worker's cache and the server always name one thing: a number kept in the
// sources had to be bumped by hand in two files, and the day it was not, a page
// running old assets called itself current and no update was ever offered.
const versionMark = "__PT_VERSION__"

// stamped lists the files that carry the mark.
var stamped = []string{"js/app.js", "sw.js"}

// Static returns the page's files as they are served: web/ with the version
// written into the stamped ones.
func Static() (fs.FS, error) {
	web, err := fs.Sub(Web, "web")
	if err != nil {
		return nil, err
	}
	s := stampedFS{FS: web, files: map[string][]byte{}}
	for _, name := range stamped {
		b, err := fs.ReadFile(web, name)
		if err != nil {
			return nil, err
		}
		s.files[name] = bytes.ReplaceAll(b, []byte(versionMark), []byte(Version()))
	}
	return s, nil
}

type stampedFS struct {
	fs.FS
	files map[string][]byte
}

func (s stampedFS) Open(name string) (fs.File, error) {
	b, ok := s.files[name]
	if !ok {
		return s.FS.Open(name)
	}
	f, err := s.FS.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	return &memFile{Reader: bytes.NewReader(b), info: sizedInfo{info, int64(len(b))}}, nil
}

// memFile is a stamped file. http.FileServer seeks to answer ranges and to
// sniff the type, which bytes.Reader does.
type memFile struct {
	*bytes.Reader
	info fs.FileInfo
}

func (f *memFile) Stat() (fs.FileInfo, error) { return f.info, nil }
func (f *memFile) Close() error               { return nil }

type sizedInfo struct {
	fs.FileInfo
	size int64
}

func (i sizedInfo) Size() int64 { return i.size }
