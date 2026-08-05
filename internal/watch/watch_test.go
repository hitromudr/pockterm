package watch

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/hitromudr/pockterm/internal/detect"
)

// harness drives a Watcher with a scripted screen and a controlled clock,
// so the rules can be tested without tmux and without waiting.
type harness struct {
	w      *Watcher
	screen string
	err    error
	now    time.Time
	events []Event
	seen   bool // someone is looking at the session
}

func newHarness(idle time.Duration) *harness {
	h := &harness{now: time.Unix(1_700_000_000, 0)}
	h.w = New(Options{
		Capture:   func(string) (string, error) { return h.screen, h.err },
		Notify:    func(e Event) { h.events = append(h.events, e) },
		Viewing:   func(string) bool { return h.seen },
		IdleAfter: idle,
		Now:       func() time.Time { return h.now },
	})
	h.w.Watch("claude")
	return h
}

func (h *harness) advance(d time.Duration) { h.now = h.now.Add(d) }

// settle is the second reading the end of a turn now needs: the counter has to
// stay away for liveGrace, because one poll without it is also what a redraw
// caught mid-flight looks like. Two ticks with the clock moved between them.
func (h *harness) settle() {
	h.w.Tick()
	h.advance(liveGrace)
	h.w.Tick()
}

func (h *harness) kinds() []Kind {
	var ks []Kind
	for _, e := range h.events {
		ks = append(ks, e.Kind)
	}
	return ks
}

const menu = "Apply this change?\n❯ 1. Yes\n  2. No\n"

func TestQuestionNotifiedOnce(t *testing.T) {
	h := newHarness(30 * time.Second)
	h.screen = "working…\n"
	h.w.Tick()

	h.screen = menu
	h.w.Tick()
	h.w.Tick() // the same menu is still on screen
	h.w.Tick()

	if len(h.events) != 1 {
		t.Fatalf("events = %+v, want one question", h.events)
	}
	e := h.events[0]
	if e.Kind != Question || e.Session != "claude" {
		t.Fatalf("event = %+v", e)
	}
	if e.Prompt != "Apply this change?" || len(e.Options) != 2 {
		t.Fatalf("event = %+v", e)
	}
}

func TestNewMenuNotifiedAgain(t *testing.T) {
	h := newHarness(30 * time.Second)
	h.screen = menu
	h.w.Tick()
	h.screen = "Delete the file?\n❯ 1. Yes\n  2. No\n"
	h.w.Tick()

	if got := h.kinds(); len(got) != 2 {
		t.Fatalf("events = %+v, want two questions", h.events)
	}
	if h.events[1].Prompt != "Delete the file?" {
		t.Fatalf("second event = %+v", h.events[1])
	}
}

func TestDoneAfterSilence(t *testing.T) {
	h := newHarness(30 * time.Second)
	h.screen = "$ make check\n"
	h.w.Tick()
	h.screen = "$ make check\nok  github.com/x/y\n"
	h.w.Tick()

	h.advance(29 * time.Second)
	h.w.Tick()
	if len(h.events) != 0 {
		t.Fatalf("too early: %+v", h.events)
	}

	h.advance(2 * time.Second)
	h.w.Tick()
	h.w.Tick() // still silent: no second notification
	if got := h.kinds(); len(got) != 1 || got[0] != Done {
		t.Fatalf("events = %+v, want one done", h.events)
	}
	if !strings.Contains(h.events[0].Prompt, "ok  github.com/x/y") {
		t.Fatalf("done event should carry the last line: %+v", h.events[0])
	}
}

// The agent's own counter, and what it costs not to read it: thirty seconds of
// a tab painted as working after the answer was already on it, and thirty
// seconds before the phone was told.
const (
	turnRunning = "● reading detect.go\n✶ Doing… (1m 13s · ↓ 3.9k tokens)\n❯ \n  ctx 62% | ~/work $ | Opus 5\n"
	turnOver    = "● reading detect.go\n✻ Cooked for 19s\nвсё, детектор поправлен\n❯ \n  ctx 62% | ~/work $ | Opus 5\n"
)

func TestDoneWhenTheCounterGoes(t *testing.T) {
	h := newHarness(30 * time.Second)
	h.screen = turnRunning
	h.w.Tick()
	if got := h.w.Activity("claude"); got != ActivityWorking {
		t.Fatalf("a counting turn: %q, want %q", got, ActivityWorking)
	}
	// One poll without the counter is not an answer — a redraw caught between the
	// footer being erased and painted again looks exactly like it. Two are.
	h.screen = turnOver
	h.w.Tick()
	if len(h.events) != 0 {
		t.Fatalf("events = %+v, want none from a single missing poll", h.events)
	}
	h.advance(liveGrace)
	h.w.Tick()
	if got := h.kinds(); len(got) != 1 || got[0] != Done {
		t.Fatalf("events = %+v, want one done, far sooner than the threshold", h.events)
	}
	if got := h.w.Activity("claude"); got != ActivityDone {
		t.Fatalf("after the counter went: %q, want %q", got, ActivityDone)
	}
	h.w.Tick() // the same finished screen says nothing more
	if len(h.events) != 1 {
		t.Fatalf("events = %+v, want just the one", h.events)
	}
	// And a new turn re-arms it, so the next end is reported too.
	h.screen = turnRunning
	h.w.Tick()
	if got := h.w.Activity("claude"); got != ActivityWorking {
		t.Fatalf("the next turn: %q, want %q", got, ActivityWorking)
	}
	h.screen = turnOver
	h.settle()
	if got := h.kinds(); len(got) != 2 || got[1] != Done {
		t.Fatalf("events = %+v, want a second done", h.events)
	}
}

func TestTypingIsNotWork(t *testing.T) {
	// Reported from the phone: the tab went green when the turn ended and purple
	// again straight after, "and it does not detect the stop". What changed the
	// pane was the owner typing the next message into the agent's own input box —
	// the commonest change there is — and any change used to count as work
	// resuming. A tab then reported the person as the machine.
	h := newHarness(30 * time.Second)
	h.screen = turnRunning
	h.w.Tick()
	h.screen = turnOver
	h.settle()
	if got := h.w.Activity("claude"); got != ActivityDone {
		t.Fatalf("the turn ended: %q, want %q", got, ActivityDone)
	}

	// The reply being typed, a character at a time.
	for i, typed := range []string{"а", "а ч", "а чего", "а чего он"} {
		h.screen = turnOver + "\n❯ " + typed
		h.advance(2 * time.Second)
		h.w.Tick()
		if got := h.w.Activity("claude"); got != ActivityDone {
			t.Fatalf("keystroke %d: %q, want %q — typing is not the agent working", i, got, ActivityDone)
		}
	}
	// And no second "finished" for a turn already reported.
	if got := h.kinds(); len(got) != 1 || got[0] != Done {
		t.Fatalf("events = %+v, want the one done", h.events)
	}
	// Sending it starts a turn, and that is what the colour is for.
	h.screen = turnRunning
	h.w.Tick()
	if got := h.w.Activity("claude"); got != ActivityWorking {
		t.Fatalf("the answer sent: %q, want %q", got, ActivityWorking)
	}
	h.screen = turnOver
	h.settle()
	if got := h.kinds(); len(got) != 2 || got[1] != Done {
		t.Fatalf("events = %+v, want a done for the second turn too", h.events)
	}
}

func TestOneMissingPollIsNotTheEndOfATurn(t *testing.T) {
	// The end of a turn is read off the counter going away, and a single reading of
	// it being absent is also what a capture landing between the footer being erased
	// and painted again looks like — or a release that stops drawing it during a
	// tool call. That answer was a green tab and a "finished" notice, taken back a
	// moment later, which is how it was reported: "часто зеленеет на время".
	h := newHarness(30 * time.Second)
	h.screen = turnRunning
	h.w.Tick()

	h.screen = turnOver
	h.w.Tick()
	if len(h.events) != 0 {
		t.Fatalf("events = %+v, want none yet", h.events)
	}
	if got := h.w.Activity("claude"); got != ActivityWorking {
		t.Fatalf("one poll without the counter: %q, want it still %q", got, ActivityWorking)
	}

	// The counter comes back: nothing happened, and nothing was said about it.
	h.advance(2 * time.Second)
	h.screen = turnRunning
	h.w.Tick()
	if len(h.events) != 0 {
		t.Fatalf("events = %+v, want none — the turn never stopped", h.events)
	}

	// And when it really goes, the window is short: four seconds, against the
	// thirty the silence rule costs.
	h.screen = turnOver
	h.w.Tick()
	h.advance(liveGrace)
	h.w.Tick()
	if got := h.kinds(); len(got) != 1 || got[0] != Done {
		t.Fatalf("events = %+v, want the one done", h.events)
	}
}

func TestEveryDecisionIsWritten(t *testing.T) {
	// Without a line per event, "it goes green for no reason" is an impression: the
	// state lives in this process, and an hour later a false finish cannot be told
	// from a real one. The reason is in it, because which of the two rules fired is
	// the first thing worth knowing.
	var lines []string
	h := newHarness(30 * time.Second)
	h.w.o.Log = func(l string) { lines = append(lines, l) }

	h.screen = turnRunning
	h.w.Tick()
	h.screen = turnOver
	h.settle()
	if len(lines) != 1 || !strings.Contains(lines[0], "done claude") ||
		!strings.Contains(lines[0], "counter gone") {
		t.Fatalf("lines = %q, want the done and why", lines)
	}

	// A session on screen is not told, and the line says so — the event happened
	// either way, and that is what makes the log readable against a phone that was
	// looking at the time.
	lines = nil
	h.seen = true
	h.screen = turnRunning
	h.w.Tick()
	h.screen = turnOver
	h.settle()
	if len(lines) != 1 || !strings.Contains(lines[0], "on screen") {
		t.Fatalf("lines = %q, want the reason it was not announced", lines)
	}
}

func TestAPaneWithNoCounterStillAnswersBySilence(t *testing.T) {
	// The counter rules only where there is one. A shell running a build has none,
	// and for it a change on screen is still the only evidence of work there is.
	h := newHarness(30 * time.Second)
	h.screen = "$ make check\n"
	h.w.Tick()
	h.screen = "$ make check\nok  internal/watch\n"
	h.w.Tick()
	h.advance(31 * time.Second)
	h.w.Tick()
	if got := h.w.Activity("claude"); got != ActivityDone {
		t.Fatalf("after the threshold: %q, want %q", got, ActivityDone)
	}
	// More output is work again here, because nothing else can say so.
	h.screen = "$ make check\nok  internal/watch\nok  internal/detect\n"
	h.w.Tick()
	if got := h.w.Activity("claude"); got != ActivityWorking {
		t.Fatalf("output after a quiet spell: %q, want %q", got, ActivityWorking)
	}
}

func TestCounterOutlastsTheThreshold(t *testing.T) {
	// A turn thinking for longer than the idle threshold: the screen can redraw
	// to the same bytes, and silence would call that finished while it runs.
	h := newHarness(30 * time.Second)
	h.screen = turnRunning
	h.w.Tick()
	h.advance(5 * time.Minute)
	h.w.Tick()
	if len(h.events) != 0 {
		t.Fatalf("events = %+v, want none while it is still counting", h.events)
	}
	if got := h.w.Activity("claude"); got != ActivityWorking {
		t.Fatalf("still counting: %q, want %q", got, ActivityWorking)
	}
}

func TestQuestionIsNotFinished(t *testing.T) {
	// A pane waiting for an answer must not report the turn over, whichever rule
	// would otherwise fire — the counter going away, or the silence after it.
	h := newHarness(30 * time.Second)
	h.screen = turnRunning
	h.w.Tick()
	h.screen = menu
	h.w.Tick()
	h.advance(5 * time.Minute)
	h.w.Tick()
	if got := h.kinds(); len(got) != 1 || got[0] != Question {
		t.Fatalf("events = %+v, want the question and nothing else", h.events)
	}
	if got := h.w.Activity("claude"); got != ActivityAsking {
		t.Fatalf("with a menu on screen: %q, want %q", got, ActivityAsking)
	}
	// Answered, the turn resumes and then ends: that end is reported.
	h.screen = turnRunning
	h.w.Tick()
	h.screen = turnOver
	h.settle()
	if got := h.kinds(); len(got) != 2 || got[1] != Done {
		t.Fatalf("events = %+v, want a done after the answer", h.events)
	}
}

func TestDoneRearmsAfterNewActivity(t *testing.T) {
	h := newHarness(30 * time.Second)
	h.screen = "one\n"
	h.w.Tick()
	h.screen = "two\n"
	h.w.Tick()
	h.advance(31 * time.Second)
	h.w.Tick()

	h.screen = "three\n"
	h.w.Tick()
	h.advance(31 * time.Second)
	h.w.Tick()

	if got := h.kinds(); len(got) != 2 || got[0] != Done || got[1] != Done {
		t.Fatalf("events = %+v, want two done", h.events)
	}
}

func TestIdleSessionNeverNotifies(t *testing.T) {
	// A session that was already sitting at a shell prompt when it came
	// under watch has not finished anything — it must stay quiet.
	h := newHarness(30 * time.Second)
	h.screen = "$ "
	h.w.Tick()
	h.advance(5 * time.Minute)
	h.w.Tick()

	if len(h.events) != 0 {
		t.Fatalf("events = %+v, want none", h.events)
	}
}

func TestViewerSilencesNotifications(t *testing.T) {
	h := newHarness(30 * time.Second)
	h.seen = true
	h.screen = "working…\n"
	h.w.Tick()
	h.screen = menu
	h.w.Tick()
	h.advance(31 * time.Second)
	h.w.Tick()

	if len(h.events) != 0 {
		t.Fatalf("events = %+v, want none while watching", h.events)
	}

	// Looking away does not replay what was suppressed.
	h.seen = false
	h.w.Tick()
	if len(h.events) != 0 {
		t.Fatalf("events = %+v, want no replay", h.events)
	}
}

func TestDeadSessionDropped(t *testing.T) {
	h := newHarness(30 * time.Second)
	h.screen = "hi\n"
	h.w.Tick()
	h.err = errors.New("can't find session")
	h.w.Tick()

	if n := h.w.Len(); n != 0 {
		t.Fatalf("watching %d sessions, want 0", n)
	}
}

func TestWatchIsIdempotent(t *testing.T) {
	h := newHarness(30 * time.Second)
	h.w.Watch("claude")
	h.w.Watch("claude")
	if n := h.w.Len(); n != 1 {
		t.Fatalf("watching %d sessions, want 1", n)
	}
}

func TestViewers(t *testing.T) {
	v := NewViewers()
	if v.Viewing("claude") {
		t.Fatal("nobody joined yet")
	}
	// A client that just attached is looking at the session.
	v.Join("claude", 1)
	if !v.Viewing("claude") {
		t.Fatal("a fresh client counts as watching")
	}
	// Backgrounded tab: the socket stays open but nobody is looking.
	v.SetVisible("claude", 1, false)
	if v.Viewing("claude") {
		t.Fatal("hidden tab must not count")
	}
	// A second client on the same session, still visible.
	v.Join("claude", 2)
	if !v.Viewing("claude") {
		t.Fatal("second client is watching")
	}
	v.Leave("claude", 2)
	if v.Viewing("claude") {
		t.Fatal("only the hidden client is left")
	}
	v.Leave("claude", 1)
	if v.Viewing("claude") {
		t.Fatal("everybody left")
	}
}

func TestViewerCountsSpanEverySession(t *testing.T) {
	v := NewViewers()
	if clients, visible := v.Counts(); clients != 0 || visible != 0 {
		t.Fatalf("empty registry counts %d/%d", clients, visible)
	}
	v.Join("claude", 1)
	v.Join("notes", 2)
	// The deploy script waits on this: two attached, both looking.
	if clients, visible := v.Counts(); clients != 2 || visible != 2 {
		t.Fatalf("counts %d/%d, want 2/2", clients, visible)
	}
	// A backgrounded tab keeps its socket, so it stays a client and stops
	// being a viewer — that difference is the whole point of the counter.
	v.SetVisible("claude", 1, false)
	if clients, visible := v.Counts(); clients != 2 || visible != 1 {
		t.Fatalf("counts %d/%d, want 2/1", clients, visible)
	}
	v.Leave("notes", 2)
	if clients, visible := v.Counts(); clients != 1 || visible != 0 {
		t.Fatalf("counts %d/%d, want 1/0", clients, visible)
	}
	v.Leave("claude", 1)
	if clients, visible := v.Counts(); clients != 0 || visible != 0 {
		t.Fatalf("counts %d/%d after everybody left", clients, visible)
	}
}

func TestFormat(t *testing.T) {
	q := Event{
		Kind:    Question,
		Session: "claude",
		Prompt:  "Apply this change?",
		Options: []detect.Option{{Key: "1", Label: "Yes"}, {Key: "2", Label: "No"}},
	}
	got := Format(q, "https://cc.example", true)
	for _, want := range []string{"claude", "Apply this change?", "1. Yes", "2. No", "https://cc.example"} {
		if !strings.Contains(got, want) {
			t.Fatalf("message %q is missing %q", got, want)
		}
	}

	// Preview off: the fact and the session name, nothing from the screen.
	quiet := Format(q, "", false)
	if strings.Contains(quiet, "Apply this change?") {
		t.Fatalf("preview leaked with preview=false: %q", quiet)
	}
	if !strings.Contains(quiet, "claude") {
		t.Fatalf("session name missing: %q", quiet)
	}
}

// The pane a Claude Code session leaves behind when it stops: the last thing
// it said, then its input box, then the shortcut hint. "The last non-blank
// line" picks the hint; a notification saying "? for shortcuts" tells the
// owner nothing about what finished.
func TestTailSkipsTheInterface(t *testing.T) {
	pane := []string{
		"● Готово: правки в трёх файлах, тесты зелёные",
		"",
		"╭──────────────────────────────────────────────╮",
		"│ >                                            │",
		"╰──────────────────────────────────────────────╯",
		"  ? for shortcuts                    ⏵⏵ auto-accept edits on",
		"",
	}
	if got, want := Tail(pane), "● Готово: правки в трёх файлах, тесты зелёные"; !strings.Contains(got, "Готово") {
		t.Fatalf("Tail = %q, want the line saying %q", got, want)
	}

	// A line inside the box is content, not decoration — the frame comes off.
	boxed := []string{"╭────────╮", "│ собрано за 4с │", "╰────────╯"}
	if got := Tail(boxed); got != "собрано за 4с" {
		t.Fatalf("Tail = %q, want the text without the frame", got)
	}

	// Nothing worth saying: the caller falls back to a fixed phrase.
	if got := Tail([]string{"", "──────", "   "}); got != "" {
		t.Fatalf("Tail = %q, want empty", got)
	}
}

func TestTailPutsBackWhatThePaneWrapped(t *testing.T) {
	// Captured off `xnt` on the owner's host, a pane 51 columns wide because this
	// page attaches phones and tmux gives a shared window the size of its newest
	// client. The body that reached the phone was the first line and nothing else
	// — "API Error: 529 Overloaded. This is a" — and the same message in a session
	// last attached from a laptop (175 columns) arrived whole. That difference is
	// the whole defect: the wrapping is the pane's, not the agent's.
	pane := []string{
		"● Bash(laptop-run --stdin -d",
		"      /home/dms/work/lendrail-tests bash 2>&1",
		"      <<'OUTER'…)",
		"",
		"● API Error: 529 Overloaded. This is a",
		"  server-side issue, usually temporary —",
		"  try again in a moment. If it persists,",
		"  check https://status.claude.com.",
		"",
		"────────────────────────────────",
		"❯ ",
	}
	want := "API Error: 529 Overloaded. This is a server-side issue, usually temporary — " +
		"try again in a moment. If it persists, check https://status.claude.com."
	if got := Tail(pane); got != want {
		t.Fatalf("Tail = %q, want the sentence put back together", got)
	}

	// The paragraph ends where the pane says it does, and each of these ends it:
	// nothing that follows belongs to the sentence.
	for _, stop := range []struct {
		what string
		line string
	}{
		{"a blank line", ""},
		{"what a tool answered", "  ⎿  Read 40 lines"},
		{"a line back at the margin", "какой-то вывод у левого края"},
		{"the input box", "╭────────────╮"},
		{"the status line", "  ctx 61% | dms@ai:~/work (main) $ | Opus 5"},
	} {
		got := Tail([]string{"● Первая строка фразы,", "  её продолжение.", stop.line})
		if got != "Первая строка фразы, её продолжение." {
			t.Errorf("%s did not end the paragraph: Tail = %q", stop.what, got)
		}
	}

	// Two things said, and the later one is the answer: an earlier sentence's
	// continuation must not be glued to it.
	if got := Tail([]string{"● Первая фраза,", "  её продолжение.", "● Вторая фраза."}); got != "Вторая фраза." {
		t.Errorf("Tail = %q, want the later sentence alone", got)
	}

	// An unwrapped sentence is unchanged: the common case must not grow a space.
	if got := Tail([]string{"● Готово.", "", "❯ "}); got != "Готово." {
		t.Errorf("Tail = %q, want the line as it was", got)
	}
}

func TestTailSkipsTheStatusLineAndTheTurnSummary(t *testing.T) {
	// The pane of a finished session, captured off this machine. What arrived on
	// the phone as the whole body of "exante закончил" was the status line: how
	// much context was left and in which directory, under a title about a session
	// having finished. The agent's own last sentence was three lines above it.
	pane := []string{
		"● Жду прогон.",
		"✻ Cooked for 19s · 1 shell, 1 monitor still running",
		"────────────────────────────────",
		"❯ ",
		"────────────────────────────────",
		"  ctx 61% | dms@ai:~/work/exante (main) $ | Opus 5 (1M context)",
		"  ⏵⏵ bypass permissions on · 1 shell, 1 monitor · ← for agents",
	}
	// The agent's own last sentence, without the marker the TUI puts on it.
	if got := Tail(pane); got != "Жду прогон." {
		t.Fatalf("Tail = %q, want the agent's own last line", got)
	}
	// The summary is skipped by its shape — one word and a duration — because the
	// verb in it changes with every release.
	for _, l := range []string{
		"✻ Cooked for 19s",
		"✻ Sautéed for 18s",
		"✻ Crunched for 4m 3s · 1 monitor still running",
		"✻ Cogitated for 2m 23s · 1 shell, 1 monitor still running",
	} {
		if got := Tail([]string{"● сказанное агентом", l}); got != "сказанное агентом" {
			t.Errorf("Tail returned the summary %q", got)
		}
	}
	// And a sentence that merely reads like one is still a sentence: the shape has
	// to start the line, or every "ждал 5s" in prose would vanish from a notice.
	if got := Tail([]string{"● собрал за 4s и ушёл"}); got != "собрал за 4s и ушёл" {
		t.Errorf("Tail dropped a real line: %q", got)
	}
	// A status line is all there is: nothing to say beats saying that.
	if got := Tail([]string{"  ctx 61% | dms@ai:~/work (main) $ | Opus 5"}); got != "" {
		t.Errorf("Tail = %q, want empty", got)
	}
}

func TestNoticeSaysWhichSessionAndWhat(t *testing.T) {
	title, body := Notice(Event{
		Kind:    Question,
		Session: "claude-1",
		Prompt:  "Apply this change?",
		Options: []detect.Option{{Key: "1", Label: "Yes"}, {Key: "2", Label: "No"}},
	})
	if !strings.Contains(title, "claude-1") {
		t.Fatalf("title %q does not name the session", title)
	}
	for _, want := range []string{"Apply this change?", "1. Yes", "2. No"} {
		if !strings.Contains(body, want) {
			t.Fatalf("body %q is missing %q", body, want)
		}
	}

	// Done with nothing readable on screen still says something.
	title, body = Notice(Event{Kind: Done, Session: "claude-1"})
	if !strings.Contains(title, "claude-1") || body == "" {
		t.Fatalf("done notice is empty: %q / %q", title, body)
	}
}

func TestActivityFollowsThePane(t *testing.T) {
	// What the tab strip colours itself by. The watcher already knew this — it
	// is the same state the "finished" notification is decided from — and the
	// page had no way to ask: a tab could not tell a session chewing through a
	// build from one that had been sitting quiet since yesterday.
	now := time.Unix(1700000000, 0)
	screen := "prompt$ "
	w := New(Options{
		Capture:   func(string) (string, error) { return screen, nil },
		Notify:    func(Event) {},
		IdleAfter: 30 * time.Second,
		Now:       func() time.Time { return now },
	})

	// Not watched at all: the page may list a session the watcher has never
	// been asked about, and "" is the honest answer, not "idle".
	if got := w.Activity("build"); got != ActivityUnknown {
		t.Fatalf("before watching: %q", got)
	}

	w.Watch("build")
	w.Tick()
	// The first reading is not activity — it is whatever was already on screen.
	if got := w.Activity("build"); got != ActivityUnknown {
		t.Fatalf("after the first look: %q, want nothing seen yet", got)
	}

	screen = "prompt$ make\ncompiling"
	w.Tick()
	if got := w.Activity("build"); got != ActivityWorking {
		t.Fatalf("while the screen changes: %q, want %q", got, ActivityWorking)
	}

	// Quiet, but not long enough to count as finished.
	now = now.Add(20 * time.Second)
	w.Tick()
	if got := w.Activity("build"); got != ActivityWorking {
		t.Fatalf("20s quiet of a 30s threshold: %q, want %q", got, ActivityWorking)
	}

	now = now.Add(11 * time.Second)
	w.Tick()
	if got := w.Activity("build"); got != ActivityDone {
		t.Fatalf("past the threshold: %q, want %q", got, ActivityDone)
	}

	// And back: a session that speaks again is working again, which is the whole
	// reason this is read per poll rather than remembered by the page.
	screen = "prompt$ make\ncompiling\nlinking"
	w.Tick()
	if got := w.Activity("build"); got != ActivityWorking {
		t.Fatalf("after it spoke again: %q, want %q", got, ActivityWorking)
	}

	// A session tmux has lost stops being watched, and stops having a state.
	w2 := New(Options{
		Capture: func(string) (string, error) { return "", errors.New("no such session") },
		Notify:  func(Event) {},
		Now:     func() time.Time { return now },
	})
	w2.Watch("gone")
	w2.Tick()
	if got := w2.Activity("gone"); got != ActivityUnknown {
		t.Fatalf("a session tmux lost: %q", got)
	}
}

func TestActivityAsksBeforeAnythingElse(t *testing.T) {
	// A menu on screen is the state that is about the person holding the phone:
	// output arriving is the machine's business, a question is theirs. So it
	// outranks working and done, and it does not wait for the screen to have
	// changed once — a pane already showing a question is showing it now.
	now := time.Unix(1700000000, 0)
	screen := "prompt$ "
	w := New(Options{
		Capture:   func(string) (string, error) { return screen, nil },
		Notify:    func(Event) {},
		IdleAfter: 30 * time.Second,
		Now:       func() time.Time { return now },
	})
	w.Watch("agent")
	w.Tick()

	screen = "Apply this change?\n❯ 1. Yes\n  2. No"
	now = now.Add(time.Second)
	w.Tick()
	if got := w.Activity("agent"); got != ActivityAsking {
		t.Fatalf("with a menu on screen: %q, want %q", got, ActivityAsking)
	}

	// Still asking after the silence that would otherwise read as "finished":
	// nothing is going to happen until it is answered, and "done" would be a
	// tab claiming the opposite.
	now = now.Add(2 * time.Minute)
	w.Tick()
	if got := w.Activity("agent"); got != ActivityAsking {
		t.Fatalf("a menu left standing: %q, want %q", got, ActivityAsking)
	}

	// Answered: the menu is gone from the screen and the state goes back to what
	// the screen is doing.
	screen = "Apply this change?\nyes\napplying"
	now = now.Add(time.Second)
	w.Tick()
	if got := w.Activity("agent"); got != ActivityWorking {
		t.Fatalf("after the menu went away: %q, want %q", got, ActivityWorking)
	}
}

func TestBackgroundFollowsTheFooter(t *testing.T) {
	// The other half of what a tab says. Activity goes quiet the moment the agent
	// stops speaking; the shells and monitors it left running do not, and a tab
	// painted green with two monitors alive was claiming the wrong thing.
	now := time.Unix(1700000000, 0)
	screen := "❯ \n  ctx 4% | dms@ai:~/work (main) $\n  bypass permissions on · 1 shell, 2 monitors ·"
	w := New(Options{
		Capture:   func(string) (string, error) { return screen, nil },
		Notify:    func(Event) {},
		IdleAfter: 30 * time.Second,
		Now:       func() time.Time { return now },
	})

	// Not watched: nothing claimed, exactly as for Activity.
	if got := w.Background("build"); got.Total() != 0 {
		t.Fatalf("before watching: %+v", got)
	}

	w.Watch("build")
	w.Tick()
	got := w.Background("build")
	if got.Shells != 1 || got.Monitors != 2 {
		t.Fatalf("from the footer: %+v, want 1 shell and 2 monitors", got)
	}

	// It is read off every poll, so the counts follow the footer down as well as
	// up — a badge that only ever appeared would be worse than none.
	screen = "❯ \n  ctx 4% | dms@ai:~/work (main) $\n  bypass permissions on"
	now = now.Add(time.Second)
	w.Tick()
	if got := w.Background("build"); got.Total() != 0 {
		t.Fatalf("after the footer stopped claiming: %+v", got)
	}

	// Quiet for long enough to be "done" — and the footer is still the footer.
	screen = "❯ \n  ctx 4% | dms@ai:~/work (main) $\n  bypass permissions on · 1 monitor ·"
	w.Tick()
	now = now.Add(2 * time.Minute)
	w.Tick()
	if got := w.Activity("build"); got != ActivityDone {
		t.Fatalf("activity = %q, want %q", got, ActivityDone)
	}
	if got := w.Background("build"); got.Monitors != 1 {
		t.Fatalf("a monitor outliving the agent's last word: %+v", got)
	}
}

func TestTailNeverReturnsTheLiveCounter(t *testing.T) {
	// It arrived on the phone as the body of "pockterm закончил": ✢ Crunching…
	// (4m 23s · still thinking). The counter should stop the notice being raised at
	// all — that is the other half of this fix — and it is chrome here regardless.
	for _, l := range []string{
		"✢ Crunching… (4m 23s · still thinking)",
		"* Deciphering… (4m 59s · thinking)",
		"✶ Doing… (1m 13s · ↓ 3.9k tokens)",
	} {
		if got := Tail([]string{"● последняя фраза агента", l}); got != "последняя фраза агента" {
			t.Errorf("Tail returned the counter: %q", got)
		}
	}
}

func TestAttachingIsNotWork(t *testing.T) {
	// Reported from the phone: tapping a green tab turned it purple for thirty
	// seconds. Attaching is a change to the pane — tmux gives the new client its
	// own size and the pane is redrawn to it — and for a session that has never
	// shown a counter, a changed screen is the only evidence of work there is.
	h := newHarness(30 * time.Second)
	h.screen = "$ make check\n"
	h.w.Tick()
	h.screen = "$ make check\nok  internal/watch\n"
	h.w.Tick()
	h.advance(31 * time.Second)
	h.w.Tick()
	if got := h.w.Activity("claude"); got != ActivityDone {
		t.Fatalf("before the tap: %q, want %q", got, ActivityDone)
	}
	h.events = nil

	// The tap: the page attaches, and the pane comes back reflowed to its width.
	h.w.Rebase("claude")
	h.screen = "$ make check\nok  internal/watch (reflowed to a\nnarrower pane)\n"
	h.advance(2 * time.Second)
	h.w.Tick()
	if got := h.w.Activity("claude"); got != ActivityDone {
		t.Fatalf("after attaching: %q, want %q — a resize is not work", got, ActivityDone)
	}
	// The agent redraws its own box a moment after tmux does, so the change
	// arrives in more than one reading.
	h.screen += "and again, a moment later\n"
	h.advance(1 * time.Second)
	h.w.Tick()
	if got := h.w.Activity("claude"); got != ActivityDone {
		t.Fatalf("the second redraw: %q, want %q", got, ActivityDone)
	}
	if len(h.events) != 0 {
		t.Fatalf("events = %+v, want none for a session that only got looked at", h.events)
	}

	// Past the window, output is output again: this session has no counter, so
	// nothing else can say when it is working.
	h.advance(10 * time.Second)
	h.screen += "ok  internal/detect\n"
	h.w.Tick()
	if got := h.w.Activity("claude"); got != ActivityWorking {
		t.Fatalf("real output after the tap: %q, want %q", got, ActivityWorking)
	}
}

func TestLeavingDoesNotAnnounceAFinishedSession(t *testing.T) {
	// The way out costs more than the way in: the pane resizes back when the page
	// goes, nobody is looking any more, and the idle threshold then announced the
	// session as finished for having been left.
	h := newHarness(30 * time.Second)
	h.screen = "$ ready\n"
	h.w.Tick()
	h.w.Tick() // quiet and never active: nothing to report
	h.w.Rebase("claude")
	h.screen = "$ ready (reflowed)\n"
	h.advance(31 * time.Second)
	h.w.Tick()
	if len(h.events) != 0 {
		t.Fatalf("events = %+v, want none: the session was left, not finished", h.events)
	}
}

func TestEverySessionIsWatchedAndOnlyTheOpenedOnesAnnounced(t *testing.T) {
	// The colour on the strip is for every session; a notification is for the ones
	// somebody asked to hear about, and attaching once is the asking.
	//
	// What this fixes: the watcher's state is per process, CI installs a new binary
	// several times a working day, and a session was only watched once a page had
	// attached to it. After a deploy every tab of a session started that morning
	// went neutral and stayed there — no colour, no "finished" — until it was
	// opened again by hand.
	screens := map[string]string{"seen": turnRunning, "unseen": turnRunning}
	now := time.Unix(1_700_000_000, 0)
	var events []Event
	w := New(Options{
		Capture:   func(s string) (string, error) { return screens[s], nil },
		Notify:    func(e Event) { events = append(events, e) },
		Sessions:  func() []string { return []string{"seen", "unseen"} },
		IdleAfter: 30 * time.Second,
		Now:       func() time.Time { return now },
	})
	// Only one of them has ever been opened.
	w.Watch("seen")
	w.Tick()

	// Both are read, so both have a colour: that is the whole point.
	for _, s := range []string{"seen", "unseen"} {
		if got := w.Activity(s); got != ActivityWorking {
			t.Fatalf("%s: %q, want %q — a session nobody opened still needs its colour", s, got, ActivityWorking)
		}
	}

	// Both finish; only the opened one is announced. Twice, because the end of a
	// turn is the counter staying away rather than one poll of it being absent.
	screens["seen"], screens["unseen"] = turnOver, turnOver
	w.Tick()
	now = now.Add(liveGrace)
	w.Tick()
	for _, s := range []string{"seen", "unseen"} {
		if got := w.Activity(s); got != ActivityDone {
			t.Fatalf("%s after the turn: %q, want %q", s, got, ActivityDone)
		}
	}
	if len(events) != 1 || events[0].Session != "seen" {
		t.Fatalf("events = %+v, want one, for the session a page had opened", events)
	}

	// And opening the other one makes it worth announcing from then on.
	w.Watch("unseen")
	screens["unseen"] = turnRunning
	w.Tick()
	screens["unseen"] = turnOver
	w.Tick()
	now = now.Add(liveGrace)
	w.Tick()
	if len(events) != 2 || events[1].Session != "unseen" {
		t.Fatalf("events = %+v, want a second one for the session now opened", events)
	}
}

func TestASessionTmuxNoLongerHasIsDropped(t *testing.T) {
	// The roster sweep adds; a capture that fails is what removes. Without the
	// second half a closed session would be re-added every tick for ever.
	live := []string{"gone"}
	w := New(Options{
		Capture:  func(string) (string, error) { return "", errors.New("no such session") },
		Notify:   func(Event) {},
		Sessions: func() []string { return live },
		Now:      func() time.Time { return time.Unix(1_700_000_000, 0) },
	})
	w.Tick()
	live = nil
	w.Tick()
	if n := w.Len(); n != 0 {
		t.Fatalf("watching %d sessions, want none", n)
	}
}

func TestTailPrefersWhatTheAgentSaidOverWhatItRan(t *testing.T) {
	// The screen that produced "✅ pockterm закончил / {"name":"devops"," on the
	// phone: the agent's sentence, then a command it ran, then that command's
	// output — which is honestly the last line and says nothing to anybody.
	pane := []string{
		"● Конфиг валиден. Предупреждение doctor про websocket — следствие песочницы.",
		"",
		"● Bash(curl -s localhost:8130/api/sessions | head -c 400)",
		`  ⎿  [{"name":"devops","windows":1,"created":1785857292,"attached":false,`,
		`     "kind":"yolo","dir":"devops"}]`,
		"",
		"✻ Cooked for 19s",
		"────────────────────────────────",
		"❯ ",
		"  ctx 10% | dms@ai:~/work/devops (develop) $ | Opus 5",
	}
	if got := Tail(pane); got != "Конфиг валиден. Предупреждение doctor про websocket — следствие песочницы." {
		t.Fatalf("Tail = %q, want the sentence rather than the output", got)
	}
	// A tool call is the agent pointing at a command, not speaking.
	if got := Tail([]string{"● Read(internal/watch/watch.go)"}); got != "" {
		t.Errorf("Tail = %q, want nothing worth saying", got)
	}
	// A pane with no marker at all still answers the old way: a shell, or an agent
	// this does not recognise.
	if got := Tail([]string{"$ make check", "ok  internal/watch"}); got != "ok  internal/watch" {
		t.Errorf("Tail = %q on a plain shell", got)
	}
}

func TestGreenFadesWhenItStopsBeingNews(t *testing.T) {
	// "Only now everything is green." Every session tmux has is read from the start
	// now, so without an expiry anything that had ever run stayed green for good —
	// a strip that has stopped saying anything. Green is "gone quiet after doing
	// something", which is news while it is recent and nothing once it is old.
	h := newHarness(30 * time.Second)
	h.screen = turnRunning
	h.w.Tick()
	h.screen = turnOver
	h.settle()
	if got := h.w.Activity("claude"); got != ActivityDone {
		t.Fatalf("just finished: %q, want %q", got, ActivityDone)
	}
	h.advance(doneFresh - time.Second)
	if got := h.w.Activity("claude"); got != ActivityDone {
		t.Fatalf("a second before it goes stale: %q, want %q", got, ActivityDone)
	}
	h.advance(2 * time.Second)
	if got := h.w.Activity("claude"); got != ActivityUnknown {
		t.Fatalf("hours later: %q, want %q — the neutral tab already means this", got, ActivityUnknown)
	}
	// A new turn is news again.
	h.screen = turnRunning
	h.w.Tick()
	if got := h.w.Activity("claude"); got != ActivityWorking {
		t.Fatalf("working again: %q", got)
	}
	h.screen = turnOver
	h.settle()
	if got := h.w.Activity("claude"); got != ActivityDone {
		t.Fatalf("finished again: %q, want %q", got, ActivityDone)
	}
	// The badge is not news and does not fade: what is still running is a fact
	// about now, however long ago the agent stopped speaking.
	h.screen = turnOver + "\n  ⏵⏵ bypass permissions on · 2 monitors · ← for agents\n"
	h.w.Tick()
	h.advance(2 * doneFresh)
	if got := h.w.Background("claude"); got.Monitors != 2 {
		t.Fatalf("background = %+v, want the monitors it still has", got)
	}
	if got := h.w.Activity("claude"); got != ActivityUnknown {
		t.Fatalf("stale with monitors alive: %q, want %q", got, ActivityUnknown)
	}
}
