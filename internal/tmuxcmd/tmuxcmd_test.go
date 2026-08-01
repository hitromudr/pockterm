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

func TestParseSessionsIgnoresJunk(t *testing.T) {
	// Empty input (no sessions) and malformed lines yield no sessions.
	if s := ParseSessions(""); len(s) != 0 {
		t.Fatalf("empty: got %+v", s)
	}
	if s := ParseSessions("no server running on /tmp/tmux-1000/default\n"); len(s) != 0 {
		t.Fatalf("junk line parsed as a session: %+v", s)
	}
}
