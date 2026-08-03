package tmuxcmd

import (
	"reflect"
	"testing"
)

func TestAttach(t *testing.T) {
	got := Attach("claude", "web-1")
	want := []string{
		"tmux", "new-session", "-A", "-s", "web-1", "-t", "claude",
		";", "set-option", "destroy-unattached", "on",
		";", "set-option", "mouse", "on",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestListSessionsArgv(t *testing.T) {
	got := ListSessions()
	want := []string{"tmux", "list-sessions", "-F", listFormat}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestParseSessions(t *testing.T) {
	out := "claude\t1\t1754032444\t1\nwork\t3\t1754030000\t0\n"
	got := ParseSessions(out)
	want := []Session{
		{Name: "claude", Windows: 1, Created: 1754032444, Attached: true},
		{Name: "work", Windows: 3, Created: 1754030000, Attached: false},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
}

func TestClientSessionNaming(t *testing.T) {
	if got := ClientName(7); got != "pockterm-7" {
		t.Fatalf("ClientName = %q", got)
	}
	if !IsClientSession("pockterm-7") {
		t.Fatal("pockterm-7 should be a client session")
	}
	for _, user := range []string{"claude", "train", "web", "work"} {
		if IsClientSession(user) {
			t.Fatalf("%q wrongly flagged as a client session", user)
		}
	}
}

func TestCapturePaneArgv(t *testing.T) {
	got := CapturePane("claude")
	want := []string{"tmux", "capture-pane", "-p", "-t", "claude"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestPaneInModeArgv(t *testing.T) {
	got := PaneInMode("pockterm-7")
	want := []string{"tmux", "display-message", "-p", "-t", "pockterm-7", "#{pane_in_mode}"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestParsePaneInMode(t *testing.T) {
	if !ParsePaneInMode("1\n") {
		t.Fatal(`"1" should mean the pane is in a mode`)
	}
	// Not in a mode, and the failure cases: no such session, dead server.
	for _, out := range []string{"0\n", "0", "", "can't find session: pockterm-7\n"} {
		if ParsePaneInMode(out) {
			t.Fatalf("%q wrongly read as in-mode", out)
		}
	}
}

func TestParseSessionsIgnoresJunk(t *testing.T) {
	// Empty input (no sessions) and malformed lines yield no sessions.
	if s := ParseSessions(""); len(s) != 0 {
		t.Fatalf("empty: got %+v", s)
	}
	if s := ParseSessions("no server running on /tmp/tmux-1000/default\n"); len(s) != 0 {
		t.Fatalf("junk line parsed as a session: %+v", s)
	}
}

func TestParseWheelLines(t *testing.T) {
	// tmux's own default binding, as `list-keys` prints it.
	stock := `bind-key -T copy-mode WheelUpPane select-pane \; send-keys -X -N 5 scroll-up`
	if got := ParseWheelLines(stock); got != 5 {
		t.Fatalf("ParseWheelLines(stock) = %d, want 5", got)
	}
	rebound := `bind-key -T copy-mode WheelUpPane select-pane \; send-keys -X -N 1 scroll-up`
	if got := ParseWheelLines(rebound); got != 1 {
		t.Fatalf("ParseWheelLines(rebound) = %d, want 1", got)
	}
	// No count in the binding, no tmux at all, nonsense: back to the default
	// rather than to 1, which would make every swipe five times too short.
	for _, in := range []string{"", "bind-key -T copy-mode WheelUpPane send-keys -X scroll-up", "-N", "-N x", "-N 0", "-N 1000"} {
		if got := ParseWheelLines(in); got != 5 {
			t.Fatalf("ParseWheelLines(%q) = %d, want the 5 it falls back to", in, got)
		}
	}
}
