package pockterm

import (
	"bytes"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
)

// A build that was not stamped still names itself, and says it is not a
// release: an empty version would leave every page unable to tell whether it is
// the current one.
func TestVersionUnstamped(t *testing.T) {
	defer func(v string) { version = v }(version)
	version = ""
	if got := Version(); got != "0.0.0-dev" {
		t.Fatalf("Version() = %q, want 0.0.0-dev", got)
	}
}

// The sources carry the mark and no number. A number written back in by hand is
// the defect the mark replaced: bumped in one file and not the other, a page
// running old assets called itself current and no update was offered.
func TestSourcesCarryTheMarkOnly(t *testing.T) {
	for _, name := range stamped {
		b := mustRead(t, "web/"+name)
		if n := bytes.Count(b, []byte(versionMark)); n != 1 {
			t.Errorf("web/%s has the version mark %d times, want once", name, n)
		}
	}
	if !regexp.MustCompile(`APP_VERSION = '` + versionMark + `'`).Match(mustRead(t, "web/js/app.js")) {
		t.Error("app.js does not take APP_VERSION from the mark")
	}
	if !regexp.MustCompile(`VERSION = '` + versionMark + `'`).Match(mustRead(t, "web/sw.js")) {
		t.Error("sw.js does not take its cache name from the mark")
	}
}

// What goes out over HTTP is the binary's own version, in the page and in the
// service worker alike, with the length to match — a Content-Length left at the
// unstamped size cuts the script short.
func TestStaticServesTheVersion(t *testing.T) {
	defer func(v string) { version = v }(version)
	version = "1.22.333"

	static, err := Static()
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.FileServer(http.FS(static)))
	defer srv.Close()

	for path, want := range map[string]string{
		"/js/app.js": "APP_VERSION = '1.22.333'",
		"/sw.js":     "VERSION = '1.22.333'",
	} {
		res, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Errorf("%s: %s", path, res.Status)
			continue
		}
		if !bytes.Contains(body, []byte(want)) {
			t.Errorf("%s does not say %q", path, want)
		}
		if bytes.Contains(body, []byte(versionMark)) {
			t.Errorf("%s went out with the mark still in it", path)
		}
		if res.ContentLength != int64(len(body)) {
			t.Errorf("%s: Content-Length %d, body %d", path, res.ContentLength, len(body))
		}
	}

	// Everything else is served as embedded.
	plain, err := fs.ReadFile(static, "index.html")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(plain, mustRead(t, "web/index.html")) {
		t.Error("index.html is served altered")
	}
}
