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
	// ActivityAsking is a menu on screen right now — the agent is waiting for an
	// answer and nothing will happen until it gets one. It outranks the other two
	// because it is the only state that is about the person holding the phone:
	// output arriving is the machine's business, a question is theirs.
	ActivityAsking Activity = "asking"
)

// Activity reports what session is doing, as far as the watcher can tell.
func (w *Watcher) Activity(session string) Activity {
	w.mu.Lock()
	defer w.mu.Unlock()
	st, ok := w.s[session]
	if !ok {
		return ActivityUnknown
	}
	// A menu on screen is the one claim worth making before anything else, and
	// the one that does not need a history: the pane is showing a question right
	// now, whether or not this watcher has seen the screen change yet.
	if st.menuSig != "" {
		return ActivityAsking
	}
	// The agent's own counter, which needs no history either: a turn that is
	// counting is a turn in flight, whatever the screen did before.
	if st.live {
		return ActivityWorking
	}
	// And once this session has been seen counting, the counter is the whole
	// answer: no counter, no turn. What the screen does in between is somebody
	// typing their next message, and a tab that called that "working" was
	// reporting the person as the machine.
	if st.sawLive {
		return ActivityDone
	}
	if !st.active {
		return ActivityUnknown
	}
	if st.doneSent {
		return ActivityDone
	}
	return ActivityWorking
}

// Background reports what the agent still has running in that session — the
// shells and monitors it counts in its own footer.
//
// It is a second answer and not part of Activity because it answers a
// different question: Activity says whether the agent is speaking, this says
// whether anything is working while it is quiet. A session sitting at "done"
// with two monitors alive is not the same thing as one with nothing left, and
// on a strip of tabs that difference is the whole reason to look.
func (w *Watcher) Background(session string) detect.Background {
	w.mu.Lock()
	defer w.mu.Unlock()
	st, ok := w.s[session]
	if !ok {
		return detect.Background{}
	}
	return st.bg
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
	bg       detect.Background // shells and monitors the footer says are running
	// live is the agent's counter on screen at the last poll; sawLive is that a
	// counter has ever been seen in this session at all.
	//
	// Together they make the end of a turn something observed rather than waited
	// out — and, once sawLive is set, they are the *only* authority on whether
	// this session is working. That second part was learned the hard way: any
	// change to the pane used to count as work resuming, and the change a person
	// makes most often is typing into the agent's own input box. A tab went green
	// when the turn ended and purple again at the first keystroke of the reply,
	// reporting the human's typing as the machine's work.
	live    bool
	sawLive bool
	// ours is how long a change to the screen still belongs to us rather than to
	// the agent — see Rebase. A page attaching resizes the pane, and that is not
	// somebody's work.
	ours time.Time
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

// Rebase says that the next change to this session's screen is ours, not the
// agent's, and must not be read as work.
//
// A page attaching or leaving is a change to the pane: tmux gives the new client
// its own size and the pane is redrawn to it, so the screen differs from the one
// before through nobody's effort. For a session whose agent reports its turns
// that costs nothing — the counter answers — but for one that has never counted,
// a changed screen is the only evidence of work there is, and the tab went purple
// for the whole idle threshold at every tap. Worse on the way out: the pane
// resizes back when the page leaves, nobody is looking any more, and thirty
// seconds later the session was announced as finished, having done nothing.
//
// The immunity is a short window rather than a single poll: tmux redraws, and then
// the agent redraws its own box a moment later, so the change arrives in more than
// one reading.
func (w *Watcher) Rebase(session string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	st, ok := w.s[session]
	if !ok {
		return
	}
	now := w.o.Now()
	// Forgetting the hash is what makes the next reading a baseline rather than a
	// change — the same rule the very first reading of a session goes by.
	st.hash = ""
	st.changed = now
	st.ours = now.Add(2 * w.o.Poll)
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
		// already on screen when watching started. Nor is a redraw we caused
		// ourselves by attaching or leaving: same rule, said by Rebase.
		if st.hash != "" && !now.Before(st.ours) {
			st.active = true
			// A pane whose agent reports its own turns says when work resumes, and
			// a change to the screen is not that: the commonest change of all is a
			// person typing their next message into the input box. Re-arming here
			// is what took a finished tab back to purple at the first keystroke —
			// and, on the notification side, raised a second "finished" for a turn
			// that had already been reported.
			if !st.sawLive {
				st.doneSent = false
			}
		}
		st.hash = h
		st.changed = now
	}

	lines := strings.Split(text, "\n")
	// Read off the same pane, on the same poll: the tab's colour, its badge and
	// whether the turn is still running come from one reading, so they cannot
	// describe two different moments.
	st.bg = detect.ReadBackground(lines)
	st.live = detect.Live(lines)
	if st.live {
		// A counter on screen is activity by itself, and it is what re-arms the
		// next "finished". The screen's hash used to be the only evidence there
		// was, and it is the weaker one in both directions: an agent thinking for
		// a minute can redraw to the same bytes, and a person typing changes them
		// without anything working at all.
		st.active = true
		st.sawLive = true
		st.doneSent = false
	}
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
	// Whether the turn is over, and there are two ways to know.
	//
	// The counter is the direct one: it was on screen and now it is not, so the
	// agent has stopped — said at once, in the poll that sees it go. Silence is
	// the other, and it is what answers for a pane with no counter to read: a
	// shell running a build, an agent whose footer this cannot parse. It costs
	// the idle threshold, which is why it is no longer the only rule — thirty
	// seconds of a tab painted as working after the answer was already on it,
	// and thirty seconds before the phone was told.
	//
	// Neither fires while a menu is on screen. "Finished" for a session that is
	// waiting for an answer is the opposite of what is true, and a question is
	// already being announced in its own right.
	switch {
	case menu != nil || st.live || st.doneSent:
		// A question, a turn still counting, or a turn already reported.
	case st.sawLive:
		st.doneSent = true
		events = append(events, Event{Kind: Done, Session: session, Prompt: Tail(lines)})
	case st.active && now.Sub(st.changed) >= w.o.IdleAfter:
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
