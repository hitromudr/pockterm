package pockterm

import (
	"bytes"
	"mime"
	"os"
	"path"
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
	if !regexp.MustCompile(`monoNames\('--mono'\)`).Match(js) {
		t.Error("app.js does not read --mono, so the stack has two owners")
	}
}

// The font the pane is drawn in travels in this binary, so what the stylesheet
// asks for and what the service worker keeps offline both have to be the file
// that is actually embedded. The defect this catches has three shapes, and none
// of them fails a build: a stylesheet naming a path that is not there (the pane
// silently falls back to a system face), a face missing from the precache list
// (an installed PWA with no network draws it in whatever the device has, which
// is the thing the embedded font exists to stop), and a rebuild that renamed the
// files.
func TestEmbeddedFontIsAskedFor(t *testing.T) {
	css, err := Web.ReadFile("web/css/app.css")
	if err != nil {
		t.Fatalf("reading the embedded app.css: %v", err)
	}
	sw, err := Web.ReadFile("web/sw.js")
	if err != nil {
		t.Fatalf("reading the embedded sw.js: %v", err)
	}

	// Every url() inside a @font-face, resolved the way a browser resolves it:
	// against the stylesheet's own directory.
	faces := regexp.MustCompile(`(?s)@font-face\s*\{.*?\}`).FindAll(css, -1)
	// The letters in one weight (Droid Sans Mono has no bold, and the browser
	// synthesises one) plus both weights of the marks, which DejaVu does have.
	if len(faces) != 3 {
		t.Fatalf("app.css declares %d faces, want the letters plus both weights of the marks", len(faces))
	}
	seen := 0
	for _, face := range faces {
		m := regexp.MustCompile(`url\('([^']+)'\)`).FindSubmatch(face)
		if m == nil {
			t.Errorf("a @font-face asks for no file at all: %s", face)
			continue
		}
		asked := path.Join("web/css", string(m[1]))
		b, err := Web.ReadFile(asked)
		if err != nil {
			t.Errorf("app.css asks for %s, which is not in the binary: %v", asked, err)
			continue
		}
		// woff2 and not a renamed ttf: the format() in the stylesheet is a
		// promise a browser holds the file to.
		if !bytes.HasPrefix(b, []byte("wOF2")) {
			t.Errorf("%s is not woff2 (starts with %q)", asked, b[:min(4, len(b))])
		}
		if len(b) < 10<<10 {
			t.Errorf("%s is %d bytes — too small to be a face with Cyrillic in it", asked, len(b))
		}
		if !bytes.Contains(sw, []byte("/"+path.Base(asked))) {
			t.Errorf("%s is not in the service worker's precache list", path.Base(asked))
		}
		seen++
	}
	if seen != len(faces) {
		t.Errorf("%d of the %d faces resolved to a file in the binary", seen, len(faces))
	}

	// The licence travels with the font, which is what both licences ask of a
	// derivative — and a subset is a derivative. The primary face's licence lives
	// beside its source in third_party/ rather than in the served assets, so only
	// the marks' one is checked here; TestPrimaryFontHasItsLicence covers the other.
	if _, err := Web.ReadFile("web/fonts/LICENSE-dejavu.txt"); err != nil {
		t.Errorf("the marks are embedded without their licence: %v", err)
	}

	// Three names, not one: the pane starts on --mono-system because xterm
	// measures the cell before the file arrives, and is handed --mono afterwards.
	// Collapsing them back into a single value is what would leave the pane
	// measured against a font nobody had yet.
	for _, name := range []string{"--mono-embedded", "--mono-marks", "--mono-system", "--mono"} {
		if !regexp.MustCompile(`(?m)^\s*` + name + `:`).Match(css) {
			t.Errorf("app.css names no %s", name)
		}
	}
	// The order is the whole mechanism instead of a unicode-range: the letters are
	// looked for first, the marks only where the letters have nothing, and the
	// system names last for what neither file holds (⏵).
	if !regexp.MustCompile(`--mono:\s*var\(--mono-embedded\),\s*var\(--mono-marks\),\s*var\(--mono-system\)`).Match(css) {
		t.Error("--mono is not the letters, then the marks, then the system names")
	}
	if !regexp.MustCompile(`fontFamily: monoSystem`).Match(mustRead(t, "web/js/app.js")) {
		t.Error("the pane is built on the full stack, so the cell is measured before the font arrives")
	}

	// The type is a courtesy rather than a requirement, but a wrong one is the
	// sort of thing that only shows up on a host that has no /etc/mime.types.
	if got := mime.TypeByExtension(".woff2"); got != "font/woff2" {
		t.Errorf("mime says %q for .woff2, want font/woff2", got)
	}
}

func mustRead(t *testing.T, name string) []byte {
	t.Helper()
	b, err := Web.ReadFile(name)
	if err != nil {
		t.Fatalf("reading the embedded %s: %v", name, err)
	}
	return b
}

// The face the letters come from is nowhere else — Google Fonts dropped Droid Sans
// Mono and Debian's droid package is the CJK fallback only — so it lives in this
// repository, and Apache 2.0 asks that its licence and notice travel with it. Not
// in the embedded assets: nothing serves it, and a licence for a face nobody
// downloads belongs next to the file it covers.
func TestPrimaryFontHasItsSourceAndLicence(t *testing.T) {
	for _, name := range []string{
		"third_party/fonts/DroidSansMono.ttf",
		"third_party/fonts/LICENSE-droid.txt",
	} {
		b, err := os.ReadFile(name)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if len(b) < 4<<10 {
			t.Errorf("%s is %d bytes, which is not the file it is meant to be", name, len(b))
		}
	}
	// A rebuild is what produced the served subset, and the script names the
	// source it read. Checked so a renamed or moved source cannot leave
	// `make font-subset` broken while the committed output still looks right.
	script, err := os.ReadFile("tools/subset-font.py")
	if err != nil {
		t.Fatalf("reading the subsetting script: %v", err)
	}
	if !bytes.Contains(script, []byte("third_party/fonts/DroidSansMono.ttf")) {
		t.Error("the script no longer reads the source that is committed here")
	}
}
