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
