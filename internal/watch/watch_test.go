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
