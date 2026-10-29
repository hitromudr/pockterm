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

// Wait is when a turn's end is worth a notice: as soon as the agent stops
// speaking, or only once the shells and monitors it left running have gone too.
//
// A switch rather than a rule, by the owner's word (2026-10-29): a turn that
// ended with a monitor watching was announced as finished, which is not true —
// what the monitor reports wakes the agent again — and yet hearing that the agent
// has stopped and is waiting is worth something on its own. So the end of the
// turn is announced either way under its true name ("ждёт"), or held back until
// nothing is left, and which of the two is the owner's choice.
type Wait string

const (
	WaitTurn Wait = "turn" // the end of every turn, as it always was
	WaitAll  Wait = "all"  // only once nothing it left is still running
)

// ParseWait reads a wait off the wire or out of the state file, refusing what it
// does not know for the same reason ParseMode does.
func ParseWait(s string) (Wait, bool) {
	switch Wait(s) {
	case WaitTurn, WaitAll:
		return Wait(s), true
	}
	return "", false
}

// Wanted says whether an event is worth delivering under wait. The watcher
// raises every end it sees — the turn's, and the later one when what it left has
// gone — and this picks the one the owner asked for, which keeps the watcher's
// own state (and the tab's colour, decided from it) the same under both.
func Wanted(e Event, w Wait) bool {
	if e.Kind != Done {
		return true
	}
	if w == WaitAll {
		return e.Background.Total() == 0
	}
	return !e.Settled
}

// Pref holds the mode and remembers it across restarts.
//
// It has to be remembered on disk because this binary is installed by CI on
// every push to main: the unit restarts several times on a working day, and a
// mode held in memory would come back as the default each time. The state that
// matters is `off` — silence the owner asked for and did not get is worse than
// a notification he has to ask for twice.
type Pref struct{ s *stored[Mode] }

// LoadPref reads the stored mode, falling back to def when there is no file or
// it says something this version does not know. A hand-edited or older file is
// not a reason to refuse to start, and not a reason to guess either.
func LoadPref(path string, def Mode) *Pref {
	return &Pref{load(path, def, ParseMode, "notification mode")}
}

// Mode reports what is wanted right now.
func (p *Pref) Mode() Mode { return p.s.get() }

// Set stores a new mode. It takes effect whether or not it could be written
// down: a full disk is a reason to forget the choice after a restart, not a
// reason to ignore it now.
func (p *Pref) Set(m Mode) error { return p.s.set(m) }

// WaitPref is Wait kept the way Pref keeps the mode, and for the same reasons.
type WaitPref struct{ s *stored[Wait] }

// LoadWaitPref reads the stored wait, falling back to def as LoadPref does.
func LoadWaitPref(path string, def Wait) *WaitPref {
	return &WaitPref{load(path, def, ParseWait, "notification wait")}
}

// Wait reports what is wanted right now.
func (p *WaitPref) Wait() Wait { return p.s.get() }

// Set stores a new wait, in force whether or not it could be written down.
func (p *WaitPref) Set(w Wait) error { return p.s.set(w) }

// stored is one word of the owner's choice, in memory and in a file.
type stored[T ~string] struct {
	mu    sync.Mutex
	val   T
	parse func(string) (T, bool)
	what  string
	// path is where the value is kept; empty keeps it in memory only, which is
	// what a host with nowhere to write gets. The switch still works there, it
	// just forgets.
	path string
}

func load[T ~string](path string, def T, parse func(string) (T, bool), what string) *stored[T] {
	s := &stored[T]{val: def, parse: parse, what: what, path: path}
	if path == "" {
		return s
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	if v, ok := parse(strings.TrimSpace(string(b))); ok {
		s.val = v
	}
	return s
}

func (s *stored[T]) get() T {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.val
}

func (s *stored[T]) set(v T) error {
	if _, ok := s.parse(string(v)); !ok {
		return fmt.Errorf("unknown %s %q", s.what, v)
	}
	s.mu.Lock()
	s.val = v
	path := s.path
	s.mu.Unlock()
	if path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("%s: %w", s.what, err)
	}
	if err := os.WriteFile(path, []byte(string(v)+"\n"), 0o600); err != nil {
		return fmt.Errorf("%s: %w", s.what, err)
	}
	return nil
}
