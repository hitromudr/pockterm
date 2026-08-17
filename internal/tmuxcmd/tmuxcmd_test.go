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

func TestCaptureHistoryArgv(t *testing.T) {
	// What the frozen copy on a phone is filled from: the history behind the
	// screen as well as the screen. `-S` counts back from the top of the visible
	// pane, so the count goes out negative; the end is left at the default, which
	// is the bottom of that pane.
	got := CaptureHistory("pockterm-7", 2000)
	want := []string{"tmux", "capture-pane", "-p", "-S", "-2000", "-t", "pockterm-7"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	// A nonsense count is the screen alone rather than a command tmux refuses:
	// what answers this frame is text on a phone, and no text is the worse answer.
	if got := CaptureHistory("pockterm-7", -5); !reflect.DeepEqual(
		got, []string{"tmux", "capture-pane", "-p", "-S", "-0", "-t", "pockterm-7"}) {
		t.Fatalf("negative: got %v", got)
	}
}

func TestPaneModeArgv(t *testing.T) {
	got := PaneMode("pockterm-7")
	want := []string{"tmux", "display-message", "-p", "-t", "pockterm-7",
		"#{pane_in_mode},#{scroll_position},#{history_size}"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestParsePaneMode(t *testing.T) {
	// Scrolled back: all three numbers say so, and how far through what.
	if in, back, hist := ParsePaneMode("1,30,800\n"); !in || back != 30 || hist != 800 {
		t.Fatalf("in = %v, back = %d, hist = %d, want true, 30, 800", in, back, hist)
	}
	// In copy-mode at the live end. This is the case the button used to be
	// shown for: tmux is in a mode, and there is nowhere to come back from.
	if in, back, _ := ParsePaneMode("1,0,800\n"); !in || back != 0 {
		t.Fatalf("in = %v, back = %d, want true and 0", in, back)
	}
	// A mode with no position at all (not copy-mode) is still a mode.
	if in, back, _ := ParsePaneMode("1,,800\n"); !in || back != 0 {
		t.Fatalf("in = %v, back = %d, want true and 0", in, back)
	}
	// Not in a mode — and the history is still the pane's, which is what lets a
	// scrollbar be drawn before anything has been scrolled. The empty middle
	// field is the whole reason this is not split on spaces: "0  800" read by
	// fields is two of them, and the history size becomes the position.
	if in, back, hist := ParsePaneMode("0,,800\n"); in || back != 0 || hist != 800 {
		t.Fatalf("out of mode: in = %v, back = %d, hist = %d, want false, 0, 800", in, back, hist)
	}
	// The failure cases: no such session, dead server, nothing at all.
	for _, out := range []string{"0", "", "can't find session: pockterm-7\n"} {
		if in, back, hist := ParsePaneMode(out); in || back != 0 || hist != 0 {
			t.Fatalf("%q wrongly read as %v/%d/%d", out, in, back, hist)
		}
	}
}

func TestScrollHistoryArgv(t *testing.T) {
	// Back into the history, and forward again — one command with a count,
	// rather than a count of wheel notches for tmux to bind one at a time.
	back := ScrollHistory("pockterm-7", 120)
	want := []string{"tmux", "copy-mode", "-e", "-t", "pockterm-7",
		";", "send-keys", "-t", "pockterm-7", "-X", "-N", "120", "scroll-up"}
	if !reflect.DeepEqual(back, want) {
		t.Fatalf("back: got %v", back)
	}
	fwd := ScrollHistory("pockterm-7", -5)
	if fwd[len(fwd)-1] != "scroll-down" || fwd[len(fwd)-2] != "5" {
		t.Fatalf("forward: got %v", fwd)
	}
	// The mode is asked for first because `send-keys -X` has nothing to send to
	// without one, and the bar is on screen before the first scroll.
	if back[1] != "copy-mode" || back[2] != "-e" {
		t.Fatalf("no copy-mode -e in front: %v", back)
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
	// The empty field before the command is the tab's place in the strip, which
	// nobody dragged here: see OrderOption.
	out := "natal\t1\t1754226692\t0\tnatal\tyolo\t/home/dms/work/self\t\t\"agent-run --dangerously-skip-permissions\"\n" +
		"qwen\t1\t1754226700\t0\t\tcustom:b2\t/home/dms/work\t\t\"AGENT_COMMAND=qwen agent-run\"\n" +
		"build\t1\t1754226800\t0\t\t\t/home/dms/work\t\t/usr/bin/zsh\n" +
		"deploy\t1\t1754226900\t0\t\t\t/home/dms\t\t\"bash -lc \\\"make deploy\\\"\"\n" +
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

func TestOrderTravelsWithTheSessionList(t *testing.T) {
	// The strip's order is a fact about the session, kept in tmux beside the kind:
	// this binary is restarted by CI several times a working day, and a second
	// phone has to see the same row.
	line := "work\t1\t1700000000\t0\tgroup\tclaude\t/home/dms/work\t3\tagent-run"
	got := ParseSessions(line)
	if len(got) != 1 {
		t.Fatalf("parsed %d sessions", len(got))
	}
	if got[0].Order != 3 {
		t.Errorf("order = %d, want 3", got[0].Order)
	}
	if got[0].Kind != "claude" || got[0].Dir != "/home/dms/work" {
		t.Errorf("the new field shifted the others: %+v", got[0])
	}
	// A session nobody placed says nothing, the same as one nobody stamped.
	none := ParseSessions("plain\t1\t1700000000\t0\t\t\t/tmp\t\tzsh")
	if none[0].Order != 0 {
		t.Errorf("an unplaced session came out as %d", none[0].Order)
	}
}

func TestSortByOrderPutsThePlacedFirst(t *testing.T) {
	// Placed sessions in their own order; everything else stays where tmux had it,
	// after them. A session started since the last drag therefore lands at the end
	// of the strip rather than in the middle of a row somebody arranged.
	in := []Session{
		{Name: "aaa"},
		{Name: "third", Order: 3},
		{Name: "bbb"},
		{Name: "first", Order: 1},
	}
	var names []string
	for _, s := range SortByOrder(in) {
		names = append(names, s.Name)
	}
	want := []string{"first", "third", "aaa", "bbb"}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("order = %v, want %v", names, want)
		}
	}
	// The input is left alone: the caller may be holding it.
	if in[0].Name != "aaa" {
		t.Error("SortByOrder sorted its argument in place")
	}
}

func TestSetOrderTakesThePlainName(t *testing.T) {
	// The same trap as the kind: set-option reads its -t as a pane, so the
	// exact-match "=" prefix the other session commands take makes it answer
	// "no such session" and the stamp silently never lands.
	argv := SetOrder("claude-2", 4)
	joined := strings.Join(argv, " ")
	if !strings.Contains(joined, "set-option -t claude-2 "+OrderOption+" 4") {
		t.Fatalf("argv = %q", joined)
	}
	if strings.Contains(joined, "=claude-2") {
		t.Error(`set-option -t "=<name>" never lands`)
	}
}

func TestCancelModeTypesNothing(t *testing.T) {
	// The page's picture of the mode is up to a poll old, so the way out must be
	// harmless when the pane has already left it. A literal "q" is not: it would
	// be typed into whatever is running. `send-keys -X cancel` is refused with a
	// message instead.
	got := CancelMode("pockterm-7")
	want := []string{"tmux", "send-keys", "-X", "-t", "pockterm-7", "cancel"}
	if len(got) != len(want) {
		t.Fatalf("CancelMode = %q, want %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("CancelMode = %q, want %q", got, want)
		}
	}
}
