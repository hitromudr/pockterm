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
	//
	// The one exception is the moment the counter has just gone: for liveGrace it
	// is still a turn, because one reading of an absent counter is also what a
	// redraw caught mid-flight looks like. The colour has to wait exactly as long
	// as the notification does — the whole point of both being decided here is
	// that they cannot disagree about what a session is doing.
	if st.sawLive {
		if !st.liveGone.IsZero() && w.o.Now().Sub(st.liveGone) < liveGrace {
			return ActivityWorking
		}
		return w.fresh(st, ActivityDone)
	}
	if !st.active {
		return ActivityUnknown
	}
	if st.doneSent {
		return w.fresh(st, ActivityDone)
	}
	return ActivityWorking
}

// How long "it has just finished" stays worth saying.
//
// Green means gone quiet after doing something, which is news for as long as it is
// recent and nothing at all once it is old. That distinction used to come for free:
// a session was watched only from the moment a page attached to it, so there was
// never much history to be stale. Now everything tmux has is read from the start,
// and without an expiry every session that had ever run was green for good —
// reported as "only now everything is green", which is a strip that has stopped
// saying anything.
const doneFresh = 10 * time.Minute

// How long the counter has to stay away before the turn is called over.
//
// Two polls rather than one, and the reason is what a single reading is: a
// capture that lands between the footer being erased and painted again, or a
// release that stops drawing the counter while a tool call is in flight, is one
// screen without a counter on a turn that is still running — and the answer to it
// was a green tab and a "finished" notice, taken back a moment later. Measured on
// the author's own sessions at twice the poll rate, this release never flickered
// (30s and 55s samples, no transitions), so this is a guard rather than a fix for
// something seen: what it costs is four seconds, against the thirty the silence
// rule costs and the zero this had before.
const liveGrace = 4 * time.Second

// fresh gives a finished session its colour while the finish is recent, and
// nothing afterwards. Nothing rather than some third colour: "quiet for hours" is
// exactly what the neutral tab means, and ActivityUnknown already says it.
func (w *Watcher) fresh(st *state, a Activity) Activity {
	if st.quiet.IsZero() || w.o.Now().Sub(st.quiet) < doneFresh {
		return a
	}
	return ActivityUnknown
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
	Capture func(session string) (string, error) // visible pane text
	Notify  func(Event)                          // called for every event worth sending
	Viewing func(session string) bool            // someone has it open right now
	// Sessions lists what exists, so a tab can be coloured for a session no page
	// has opened. nil watches only what has been attached to, which is what this
	// did before — and what left every tab neutral after a restart: the state is
	// per process, CI installs a new binary several times a working day, and a
	// session started in the morning then said nothing until it was opened again.
	//
	// Being watched is not the same as being notified about: see Watch.
	Sessions func() []string
	// Log records what the watcher decided and why; nil keeps it quiet. A hook
	// rather than the log package, so the rules stay testable and the caller
	// decides where the line goes.
	Log       func(string)
	IdleAfter time.Duration    // silence that counts as "done"
	Poll      time.Duration    // how often Run reads the panes
	Now       func() time.Time // injected for tests
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
	// When the counter was first missing after having been seen. The end of a turn
	// is read off the counter going away, and one poll of it being absent used to
	// be the whole of that reading — see liveGrace for why it now has to hold.
	liveGone time.Time
	// ours is how long a change to the screen still belongs to us rather than to
	// the agent — see Rebase. A page attaching resizes the pane, and that is not
	// somebody's work.
	ours time.Time
	// quiet is when this session was last seen to stop working — the moment the
	// counter went, or the moment silence ran past the threshold. It is what makes
	// "just finished" expire: see doneFresh.
	quiet time.Time
	// notify is whether anything about this session is worth sending anywhere: set
	// when a page attaches to it, never by the roster sweep. Everything else here
	// is read either way, because the colour on the strip is for every session and
	// a notification is only for the ones somebody asked for.
	notify bool
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

// Watch puts a session under observation *and* makes it one worth notifying
// about, for good. Idempotent: attaching twice does not restart its history.
//
// The two halves used to be one thing, and separating them is what lets a tab be
// coloured for a session nobody has opened without the phone being told about it.
// A page attaching is what asks to be told — that is the whole claim behind a
// notification, and it is not something to assume about a session started on
// another machine and never looked at from here.
func (w *Watcher) Watch(session string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	st, ok := w.s[session]
	if !ok {
		st = &state{changed: w.o.Now()}
		w.s[session] = st
	}
	st.notify = true
}

// observe starts reading a session without claiming anyone wants to hear about
// it. What it buys is the colour on the strip; what it deliberately does not buy
// is a notification.
func (w *Watcher) observe(session string) {
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
	// What exists, before reading what it is doing: a session that appeared since
	// the last tick is one a tab may already be showing.
	if w.o.Sessions != nil {
		for _, name := range w.o.Sessions() {
			w.observe(name)
		}
	}
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
		st.quiet = time.Time{}
		st.liveGone = time.Time{}
	} else if st.sawLive && st.liveGone.IsZero() {
		// The first poll without it. Whether that is the end of the turn is
		// answered by the next one — see liveGrace.
		st.liveGone = now
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
	why := ""
	switch {
	case menu != nil || st.live || st.doneSent:
		// A question, a turn still counting, or a turn already reported.
	case st.sawLive && !st.liveGone.IsZero() && now.Sub(st.liveGone) >= liveGrace:
		why = fmt.Sprintf("counter gone for %s", now.Sub(st.liveGone).Round(time.Second))
	case st.sawLive:
		// Missing, but not for long enough to be an answer yet.
	case st.active && now.Sub(st.changed) >= w.o.IdleAfter:
		why = fmt.Sprintf("quiet for %s", now.Sub(st.changed).Round(time.Second))
	}
	if why != "" {
		st.doneSent = true
		st.quiet = now
		events = append(events, Event{Kind: Done, Session: session, Prompt: Tail(lines)})
	}
	notify := st.notify
	w.mu.Unlock()

	// Someone looking at the session sees all this already. The state was
	// updated regardless, so nothing is replayed once they look away.
	//
	// And a session no page has ever attached to is read but not announced: it is
	// on the strip in colour, and the phone is told about the sessions it was
	// asked to be told about. Attaching once is the asking.
	if len(events) == 0 {
		return
	}
	quiet := ""
	switch {
	case !notify:
		quiet = "not announced: never opened here"
	case w.o.Viewing(session):
		quiet = "not announced: on screen"
	}
	// Every event, whether it was announced or not, with the rule that raised it.
	// Without this line "it goes green for no reason" is an impression: the state
	// lives in this process, nothing is written down, and a false "finished" cannot
	// be told from a real one an hour later. The colour of a tab is decided here
	// too, so this is the log of that as well.
	if w.o.Log != nil {
		for _, e := range events {
			reason := why
			if e.Kind == Question {
				reason = "menu on screen"
			}
			w.o.Log(fmt.Sprintf("watch: %s %s (%s)%s", e.Kind, session, reason,
				map[bool]string{true: "", false: " — " + quiet}[quiet == ""]))
		}
	}
	if quiet != "" {
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
