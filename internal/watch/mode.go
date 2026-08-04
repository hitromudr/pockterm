package watch

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Mode is what the owner wants raised, and where.
//
// There are two channels and they cover different absences: a frame down the
// socket reaches a page that is open but in the background, and Telegram
// reaches a phone with nothing open at all. Which of them is wanted is a
// question about the hour, not about the code — the same event is worth waking
// up for during a deploy and worth nothing on a Sunday — so it is a switch, and
// it is one switch for both channels rather than one per channel: the page
// cannot decide about Telegram, and a second control that silences half of the
// notifications is a control nobody trusts.
type Mode string

const (
	ModeOff  Mode = "off"    // neither channel
	ModePWA  Mode = "pwa"    // the page only, while it is open
	ModeBoth Mode = "pwa+tg" // the page, and Telegram when nothing is open
)

// ParseMode reads a mode off the wire or out of the state file.
//
// An unknown value is refused rather than mapped onto a default. The loud
// direction here is "everything": a typo that meant silence and delivered
// Telegram would wake the owner at three in the morning, and the value comes
// from a page and a file, neither of which is trusted.
func ParseMode(s string) (Mode, bool) {
	switch Mode(s) {
	case ModeOff, ModePWA, ModeBoth:
		return Mode(s), true
	}
	return "", false
}

// Deliver says which channels an event goes to under mode, given whether
// Telegram is configured at all.
//
// Separate from the watcher on purpose: the watcher decides whether something
// happened, this decides whether the owner asked to hear about it, and mixing
// the two is how the page came to be deciding both — see the header of
// js/notify.js for what that cost.
func Deliver(m Mode, telegramConfigured bool) (page, telegram bool) {
	switch m {
	case ModePWA:
		return true, false
	case ModeBoth:
		return true, telegramConfigured
	default:
		return false, false
	}
}

// Pref holds the mode and remembers it across restarts.
//
// It has to be remembered on disk because this binary is installed by CI on
// every push to main: the unit restarts several times on a working day, and a
// mode held in memory would come back as the default each time. The state that
// matters is `off` — silence the owner asked for and did not get is worse than
// a notification he has to ask for twice.
type Pref struct {
	mu   sync.Mutex
	mode Mode
	// path is where the mode is kept; empty keeps it in memory only, which is
	// what a host with nowhere to write gets. The switch still works there,
	// it just forgets.
	path string
}

// LoadPref reads the stored mode, falling back to def when there is no file or
// it says something this version does not know. A hand-edited or older file is
// not a reason to refuse to start, and not a reason to guess either.
func LoadPref(path string, def Mode) *Pref {
	p := &Pref{mode: def, path: path}
	if path == "" {
		return p
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return p
	}
	if m, ok := ParseMode(strings.TrimSpace(string(b))); ok {
		p.mode = m
	}
	return p
}

// Mode reports what is wanted right now.
func (p *Pref) Mode() Mode {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.mode
}

// Set stores a new mode. It takes effect whether or not it could be written
// down: a full disk is a reason to forget the choice after a restart, not a
// reason to ignore it now.
func (p *Pref) Set(m Mode) error {
	if _, ok := ParseMode(string(m)); !ok {
		return fmt.Errorf("unknown notification mode %q", m)
	}
	p.mu.Lock()
	p.mode = m
	path := p.path
	p.mu.Unlock()
	if path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("notification mode: %w", err)
	}
	if err := os.WriteFile(path, []byte(string(m)+"\n"), 0o600); err != nil {
		return fmt.Errorf("notification mode: %w", err)
	}
	return nil
}
