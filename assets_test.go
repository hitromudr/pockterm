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

// The pane and the frozen copy of it draw the same text, so they read the same
// font from one place — `--mono` in css/app.css. Courier New is the defect this
// catches: xterm's own default names it first (`courier-new, courier,
// monospace`) and it ships on Windows alone, so the phone and the Linux desktop
// fell through to a sans-serif mono while the Windows desktop drew a thin serif
// face. Same screen, two typefaces, depending on where it was opened.
func TestOneMonoStackAndNoCourier(t *testing.T) {
	css, err := Web.ReadFile("web/css/app.css")
	if err != nil {
		t.Fatalf("reading the embedded app.css: %v", err)
	}
	js, err := Web.ReadFile("web/js/app.js")
	if err != nil {
		t.Fatalf("reading the embedded app.js: %v", err)
	}
	if !regexp.MustCompile(`(?m)^\s*--mono:`).Match(css) {
		t.Error("app.css names no --mono for the pane and the copy window to read")
	}
	// The comment beside --mono names Courier as the defect, so this looks at
	// declarations rather than at the whole file.
	if loc := regexp.MustCompile(`(?i)(font-family|--mono):[^;]*courier`).FindIndex(css); loc != nil {
		t.Errorf("app.css still names Courier in a declaration at byte %d", loc[0])
	}
	if !regexp.MustCompile(`#snapshot\b[^}]*font-family:\s*var\(--mono\)`).Match(css) {
		t.Error("the copy window does not read --mono, so it can drift from the pane")
	}
	if !regexp.MustCompile(`new Terminal\(\{[^}]*fontFamily`).Match(js) {
		t.Error("the terminal is built without a fontFamily, so xterm's Courier default stands")
	}
	if !regexp.MustCompile(`getPropertyValue\('--mono'\)`).Match(js) {
		t.Error("app.js does not read --mono, so the stack has two owners")
	}
}
