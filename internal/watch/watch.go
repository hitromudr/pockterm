// Package watch notices, from the outside, when an agent in a tmux session
// wants something. It reads the pane with capture-pane, so it works when no
// browser is open — which is exactly when a notification is worth sending.
//
// Two events: the pane shows an interactive menu (Question), or it went
// quiet after doing something (Done).
package watch

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/hitromudr/pockterm/internal/detect"
)

type Kind string

const (
	Question Kind = "question"
	Done     Kind = "done"
)

// Activity is what the watcher has seen in a session lately. The page colours a
// tab by it: a session chewing through a build and one that has been quiet since
// yesterday looked exactly alike, and which is which is the first thing you want
// to know from a strip of tabs on a phone.
//
// It is the same state the "finished" notification is decided from, read instead
// of announced — so the two can never disagree about what a session is doing.
type Activity string

const (
	// ActivityUnknown is a session the watcher has nothing to say about: not
	// watched, or nothing has happened since it started looking. Deliberately
	// not called "idle" — the honest claim is that nothing was seen, and a tab
	// paints itself neutral rather than making one up.
	ActivityUnknown Activity = ""
	ActivityWorking Activity = "working"
	ActivityDone    Activity = "done"
)

// Activity reports what session is doing, as far as the watcher can tell.
func (w *Watcher) Activity(session string) Activity {
	w.mu.Lock()
	defer w.mu.Unlock()
	st, ok := w.s[session]
	if !ok || !st.active {
		return ActivityUnknown
	}
	if st.doneSent {
		return ActivityDone
	}
	return ActivityWorking
}

// Event is what happened in a session.
type Event struct {
	Kind    Kind
	Session string
	// Question: the prompt line above the menu. Done: the last line of the
	// pane worth showing a human — see Tail.
	Prompt  string
	Options []detect.Option
}

type Options struct {
	Capture   func(session string) (string, error) // visible pane text
	Notify    func(Event)                          // called for every event worth sending
	Viewing   func(session string) bool            // someone has it open right now
	IdleAfter time.Duration                        // silence that counts as "done"
	Poll      time.Duration                        // how often Run reads the panes
	Now       func() time.Time                     // injected for tests
}

// state is what the watcher remembers between polls of one session.
type state struct {
	hash     string
	changed  time.Time
	active   bool // the screen changed at least once since we started watching
	doneSent bool
	menuSig  string
}

type Watcher struct {
	o  Options
	mu sync.Mutex
	s  map[string]*state
}

func New(o Options) *Watcher {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.IdleAfter <= 0 {
		o.IdleAfter = 30 * time.Second
	}
	if o.Poll <= 0 {
		o.Poll = 2 * time.Second
	}
	if o.Viewing == nil {
		o.Viewing = func(string) bool { return false }
	}
	return &Watcher{o: o, s: make(map[string]*state)}
}

// Watch puts a session under observation. Idempotent: attaching twice does
// not restart its history.
func (w *Watcher) Watch(session string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, ok := w.s[session]; !ok {
		w.s[session] = &state{changed: w.o.Now()}
	}
}

// Len reports how many sessions are being watched.
func (w *Watcher) Len() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.s)
}

// Run polls until ctx is cancelled.
func (w *Watcher) Run(ctx context.Context) {
	ticker := time.NewTicker(w.o.Poll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.Tick()
		}
	}
}

// Tick reads every watched pane once and emits whatever it finds. Tests
// call it directly so they control the clock instead of sleeping.
func (w *Watcher) Tick() {
	w.mu.Lock()
	sessions := make([]string, 0, len(w.s))
	for name := range w.s {
		sessions = append(sessions, name)
	}
	w.mu.Unlock()

	for _, name := range sessions {
		w.poll(name)
	}
}

func (w *Watcher) poll(session string) {
	text, err := w.o.Capture(session)
	if err != nil {
		// The session is gone (or tmux is): stop watching it.
		w.mu.Lock()
		delete(w.s, session)
		w.mu.Unlock()
		return
	}

	w.mu.Lock()
	st, ok := w.s[session]
	if !ok {
		w.mu.Unlock()
		return
	}
	now := w.o.Now()
	if h := hash(text); h != st.hash {
		// The very first reading is not activity — it is just what was
		// already on screen when watching started.
		if st.hash != "" {
			st.active = true
			st.doneSent = false
		}
		st.hash = h
		st.changed = now
	}

	lines := strings.Split(text, "\n")
	var events []Event
	menu := detect.Question(lines)
	if sig := menuSig(menu); sig != st.menuSig {
		st.menuSig = sig
		if menu != nil {
			events = append(events, Event{
				Kind:    Question,
				Session: session,
				Prompt:  menu.Prompt,
				Options: menu.Options,
			})
		}
	}
	if st.active && !st.doneSent && now.Sub(st.changed) >= w.o.IdleAfter {
		st.doneSent = true
		events = append(events, Event{Kind: Done, Session: session, Prompt: Tail(lines)})
	}
	w.mu.Unlock()

	// Someone looking at the session sees all this already. The state was
	// updated regardless, so nothing is replayed once they look away.
	if len(events) == 0 || w.o.Viewing(session) {
		return
	}
	for _, e := range events {
		w.o.Notify(e)
	}
}

func hash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return fmt.Sprintf("%x", sum[:8])
}

func menuSig(m *detect.Menu) string {
	if m == nil {
		return ""
	}
	var b strings.Builder
	b.WriteString(m.Prompt)
	for _, o := range m.Options {
		b.WriteString("\x00" + o.Key + "\x00" + o.Label)
	}
	return b.String()
}
