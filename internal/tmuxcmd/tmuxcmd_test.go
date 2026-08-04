package tmuxcmd

import (
	"reflect"
	"strings"
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
	if got := ClientName(7); got != "pockterm-client-7" {
		t.Fatalf("ClientName = %q", got)
	}
	if !IsClientSession("pockterm-client-7") {
		t.Fatal("pockterm-client-7 should be a client session")
	}
	// The namespace has to be one a user's own session cannot wander into.
	// `pockterm-` alone was not: sessions are named after the folder they were
	// started in now, and ~/work/pockterm is a folder — its second session is
	// pockterm-2, which used to be hidden from the list and unattachable, with
	// nothing anywhere saying why.
	for _, user := range []string{"claude", "train", "web", "work", "pockterm", "pockterm-2", "pockterm-app"} {
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

func TestPaneModeArgv(t *testing.T) {
	got := PaneMode("pockterm-7")
	want := []string{"tmux", "display-message", "-p", "-t", "pockterm-7", "#{pane_in_mode} #{scroll_position}"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestParsePaneMode(t *testing.T) {
	// Scrolled back: both numbers say so, and how far.
	if in, back := ParsePaneMode("1 30\n"); !in || back != 30 {
		t.Fatalf("in = %v, back = %d, want true and 30", in, back)
	}
	// In copy-mode at the live end. This is the case the button used to be
	// shown for: tmux is in a mode, and there is nowhere to come back from.
	if in, back := ParsePaneMode("1 0\n"); !in || back != 0 {
		t.Fatalf("in = %v, back = %d, want true and 0", in, back)
	}
	// A mode with no position at all (not copy-mode) is still a mode.
	if in, back := ParsePaneMode("1 \n"); !in || back != 0 {
		t.Fatalf("in = %v, back = %d, want true and 0", in, back)
	}
	// Not in a mode, and the failure cases: no such session, dead server.
	for _, out := range []string{"0 \n", "0", "", "can't find session: pockterm-7\n"} {
		if in, back := ParsePaneMode(out); in || back != 0 {
			t.Fatalf("%q wrongly read as in-mode %v/%d", out, in, back)
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

func TestCopyModeTable(t *testing.T) {
	// mode-keys decides which table the wheel binding lives in; asking the
	// other one answers about bindings nothing uses.
	if got := CopyModeTable("vi\n"); got != "copy-mode-vi" {
		t.Fatalf("CopyModeTable(vi) = %q", got)
	}
	for _, in := range []string{"emacs", "", "nonsense"} {
		if got := CopyModeTable(in); got != "copy-mode" {
			t.Fatalf("CopyModeTable(%q) = %q", in, got)
		}
	}
	if got := WheelLines(""); got[len(got)-2] != "copy-mode" {
		t.Fatalf("WheelLines(\"\") asks about %q", got)
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

func TestParseSessionsReadsTheGroup(t *testing.T) {
	out := "devops\t1\t1754226692\t0\tnatal\n" +
		"roost\t1\t1754221234\t1\t\n"
	got := ParseSessions(out)
	if len(got) != 2 {
		t.Fatalf("parsed %d sessions", len(got))
	}
	if got[0].Group != "natal" {
		t.Errorf("group = %q, want the group name tmux reports", got[0].Group)
	}
	if got[1].Group != "" {
		t.Errorf("a session on its own has no group, got %q", got[1].Group)
	}
}

func TestParseSessionsReadsTheKind(t *testing.T) {
	// Lines as tmux prints them for the format this asks for: the stamped option,
	// then the command the pane was created with — quoted by tmux when it has a
	// space in it.
	out := "natal\t1\t1754226692\t0\tnatal\tyolo\t/home/dms/work/self\t\"agent-run --dangerously-skip-permissions\"\n" +
		"qwen\t1\t1754226700\t0\t\tcustom:b2\t/home/dms/work\t\"AGENT_COMMAND=qwen agent-run\"\n" +
		"build\t1\t1754226800\t0\t\t\t/home/dms/work\t/usr/bin/zsh\n" +
		"deploy\t1\t1754226900\t0\t\t\t/home/dms\t\"bash -lc \\\"make deploy\\\"\"\n" +
		"old\t1\t1754227000\t0\t\n"
	got := ParseSessions(out)
	if len(got) != 5 {
		t.Fatalf("parsed %d sessions", len(got))
	}
	for i, want := range []string{"yolo", "custom:b2", "shell", "", ""} {
		if got[i].Kind != want {
			t.Errorf("%s: kind = %q, want %q", got[i].Name, got[i].Kind, want)
		}
	}
	// Where the pane is now, which the name does not answer: this session was
	// opened in ~/work and has been working in ~/work/self.
	if got[0].Dir != "/home/dms/work/self" {
		t.Errorf("dir = %q, want the pane's own path", got[0].Dir)
	}
	// A line from a tmux too old for the format asks for nothing and claims
	// nothing, rather than reading one field as another.
	if got[4].Dir != "" || got[4].Kind != "" {
		t.Errorf("a short line invented fields: %+v", got[4])
	}
	// The stamp is the answer whenever there is one, and the start command never
	// overrules it: an agent launched through a shell wrapper would otherwise be
	// reported as a shell.
	if got[0].Group != "natal" {
		t.Errorf("the group moved: %q", got[0].Group)
	}
}

func TestKindFromStart(t *testing.T) {
	// Only the coarse half of the question. Which button ran the command is the
	// Makefile's knowledge, and this package does not have it — so this answers
	// "started as a plain shell" or nothing at all.
	for _, c := range []struct{ start, want string }{
		{"/bin/zsh", "shell"},
		{"bash", "shell"},
		{`"/usr/bin/fish"`, "shell"},
		// A pane created with no command runs the login shell.
		{"", "shell"},
		{"   ", "shell"},
		// A command run through a shell is not a shell session: what it was
		// started for is the argument, and guessing at it is not this function's
		// business.
		{`"bash -lc \"npm run dev\""`, ""},
		{`"agent-run --dangerously-skip-permissions"`, ""},
		{`"AGENT_COMMAND=qwen agent-run"`, ""},
		{"/usr/local/bin/agent-run", ""},
		{"sleep", ""},
	} {
		if got := KindFromStart(c.start); got != c.want {
			t.Errorf("KindFromStart(%q) = %q, want %q", c.start, got, c.want)
		}
	}
}

func TestListFormatAsksForTheKind(t *testing.T) {
	// The option the Makefile stamps has to be the option this asks for; the
	// example Makefile is checked against the same constant.
	if !strings.Contains(listFormat, KindOption) {
		t.Errorf("the session list never asks for %s", KindOption)
	}
	// Last, because it is the one field that can carry a tab: a stray one there
	// costs a field nobody reads instead of shifting every field after it.
	if !strings.HasSuffix(listFormat, "#{pane_start_command}") {
		t.Error("pane_start_command has to be the last field")
	}
}

func TestNameConflict(t *testing.T) {
	// The state that produced the bug: a session renamed away from claude-1
	// left a group still called claude-1 behind it.
	sessions := []Session{
		{Name: "devops", Group: "natal"},
		{Name: "roost"},
	}

	if err := NameConflict("work", sessions); err != nil {
		t.Errorf("an unused name was refused: %v", err)
	}
	if err := NameConflict("roost", sessions); err == nil {
		t.Error("an existing session name must be refused")
	}
	// The one that cost an afternoon: no session is called natal, but the
	// name resolves to devops's group, so a session taking it would have its
	// tab open devops — and attaching would merge them irreversibly.
	err := NameConflict("natal", sessions)
	if err == nil {
		t.Fatal("a name that is a live group must be refused")
	}
	if !strings.Contains(err.Error(), "devops") {
		t.Errorf("the message should name the session holding the group: %v", err)
	}
	// A session may keep the name of its own group; nothing resolves elsewhere.
	if err := NameConflict("natal", []Session{{Name: "natal", Group: "natal"}}); err == nil {
		t.Error("renaming a session to its own group name changes nothing and must be allowed")
	}
}

func TestStatusLinesArgv(t *testing.T) {
	got := StatusLines()
	want := []string{"tmux", "show-options", "-gv", "status"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestParseStatusLines(t *testing.T) {
	for out, want := range map[string]int{
		"on\n":  1,
		"off\n": 1 - 1,
		"2\n":   2,
		"5":     5,
		// Unreadable, and a dead server: none rather than a guess, because
		// pinning a row of real output looks like the terminal tearing.
		"":                                 0,
		"no server running on /tmp/tmux\n": 0,
		"9\n":                              0,
	} {
		if got := ParseStatusLines(out); got != want {
			t.Fatalf("ParseStatusLines(%q) = %d, want %d", out, got, want)
		}
	}
}
