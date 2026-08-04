package watch

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseMode(t *testing.T) {
	for _, in := range []string{"off", "pwa", "pwa+tg"} {
		if m, ok := ParseMode(in); !ok || string(m) != in {
			t.Fatalf("ParseMode(%q) = %q, %v", in, m, ok)
		}
	}
	// Anything else is refused rather than mapped onto a default: a typo that
	// silently means "everything" would notify a phone at three in the morning.
	for _, in := range []string{"", "on", "tg", "PWA", "pwa+tg extra"} {
		if _, ok := ParseMode(in); ok {
			t.Fatalf("ParseMode(%q) accepted", in)
		}
	}
}

func TestDeliverGatesBothChannels(t *testing.T) {
	cases := []struct {
		mode      Mode
		tg        bool
		page, bot bool
	}{
		{ModeBoth, true, true, true},
		// The switch offers Telegram only where it is configured, but a stored
		// preference outlives the configuration: a token removed from the unit
		// must not resurrect as an error on every event.
		{ModeBoth, false, true, false},
		{ModePWA, true, true, false},
		{ModePWA, false, true, false},
		// Off is off in both channels. Gating only the page would leave the
		// owner unable to silence the one that reaches him with the screen off.
		{ModeOff, true, false, false},
		{ModeOff, false, false, false},
	}
	for _, c := range cases {
		page, bot := Deliver(c.mode, c.tg)
		if page != c.page || bot != c.bot {
			t.Fatalf("Deliver(%q, tg=%v) = %v, %v; want %v, %v", c.mode, c.tg, page, bot, c.page, c.bot)
		}
	}
}

func TestPrefRemembersAcrossRestarts(t *testing.T) {
	// The unit restarts on every push to main — CI installs the binary — so a
	// preference held only in memory would come back as the default several
	// times a day, and "off" is exactly the state whose loss is loud.
	path := filepath.Join(t.TempDir(), "notify")
	p := LoadPref(path, ModeBoth)
	if p.Mode() != ModeBoth {
		t.Fatalf("no file yet: got %q, want the default", p.Mode())
	}
	if err := p.Set(ModeOff); err != nil {
		t.Fatal(err)
	}
	if got := LoadPref(path, ModeBoth).Mode(); got != ModeOff {
		t.Fatalf("after a restart: got %q, want %q", got, ModeOff)
	}
}

func TestPrefRefusesAnUnknownMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notify")
	p := LoadPref(path, ModePWA)
	if err := p.Set(Mode("everything")); err == nil {
		t.Fatal("an unknown mode was accepted")
	}
	if p.Mode() != ModePWA {
		t.Fatalf("a refused Set changed the mode to %q", p.Mode())
	}
	if _, err := os.Stat(path); err == nil {
		t.Fatal("a refused Set wrote the file")
	}
}

func TestPrefFallsBackToTheDefaultOnRubbish(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "notify")
	if err := os.WriteFile(path, []byte("everything\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A file written by hand, or by an older version, is not a reason to refuse
	// to start — but it is a reason not to guess at what it meant.
	if got := LoadPref(path, ModePWA).Mode(); got != ModePWA {
		t.Fatalf("got %q, want the default %q", got, ModePWA)
	}
}

func TestPrefWithoutAFileKeepsTheModeInMemory(t *testing.T) {
	// POCKTERM_NOTIFY_FILE=off: the switch still works for as long as the
	// process lives, which is what a machine with nowhere to write gets.
	p := LoadPref("", ModeBoth)
	if err := p.Set(ModeOff); err != nil {
		t.Fatal(err)
	}
	if p.Mode() != ModeOff {
		t.Fatalf("got %q, want %q", p.Mode(), ModeOff)
	}
}

func TestPrefCreatesItsDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pockterm", "notify")
	if err := LoadPref(path, ModeBoth).Set(ModePWA); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "pwa\n" {
		t.Fatalf("file holds %q", b)
	}
}
