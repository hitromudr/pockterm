package pockterm

import (
	"regexp"
	"testing"
)

// The page's version reaches the browser through the socket's config frame, so
// a binary that cannot name what it serves leaves every page unable to tell
// whether it is the current one.
func TestPageVersion(t *testing.T) {
	got := PageVersion()
	if got == "" {
		t.Fatal("PageVersion is empty: the embedded app.js has no APP_VERSION")
	}
	if !regexp.MustCompile(`^v[0-9]+$`).MatchString(got) {
		t.Fatalf("PageVersion = %q, want vNN", got)
	}
}

// The service worker caches under its own constant and the page reports the
// other one. They are bumped together by hand, and a mismatch is the whole
// class of bug this catches: assets served as v74 while the page calls itself
// v72, so nothing ever looks out of date and no notice is ever raised.
func TestPageVersionMatchesServiceWorker(t *testing.T) {
	sw, err := Web.ReadFile("web/sw.js")
	if err != nil {
		t.Fatalf("reading the embedded sw.js: %v", err)
	}
	m := regexp.MustCompile(`VERSION\s*=\s*'([^']+)'`).FindSubmatch(sw)
	if m == nil {
		t.Fatal("the embedded sw.js has no VERSION")
	}
	if got, want := PageVersion(), string(m[1]); got != want {
		t.Fatalf("app.js says %q, sw.js says %q — bump both", got, want)
	}
}
