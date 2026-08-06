package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hitromudr/pockterm/internal/tmuxcmd"
)

// root builds a projects root that looks like a real one: projects, a dotted
// directory, a plain file, and a symlinked project.
func root(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, d := range []string{"natal", "pockterm", "infra-secrets", "RPi5", ".git", ".venv"} {
		if err := os.Mkdir(filepath.Join(dir, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "Makefile"), []byte("all:\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	elsewhere := t.TempDir()
	if err := os.Symlink(elsewhere, filepath.Join(dir, "linked")); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestFoldersListsProjectsAndNothingElse(t *testing.T) {
	got, err := Folders(root(t))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"RPi5", "infra-secrets", "linked", "natal", "pockterm"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("folders = %v, want %v", got, want)
	}
}

func TestFoldersSaysWhenTheRootIsNotThere(t *testing.T) {
	// The page shows the reason; a silent empty list would read as "no projects".
	if _, err := Folders(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("a missing root was accepted")
	}
}

func TestResolveDirTakesTheRootItself(t *testing.T) {
	dir := root(t)
	for _, name := range []string{"", "."} {
		got, err := ResolveDir(dir, name)
		if err != nil {
			t.Fatal(err)
		}
		if got != dir {
			t.Fatalf("ResolveDir(%q) = %q, want the root %q", name, got, dir)
		}
	}
}

func TestResolveDirRefusesAnythingButOneName(t *testing.T) {
	dir := root(t)
	// The value reaches a command line as make's DIR=, so this is the gate: two
	// segments deep, or a "..", would be a session started anywhere on the box.
	for _, name := range []string{"..", "../etc", "natal/sub", "/etc", ".git", "./natal", `natal;reboot`, "natal ", ""} {
		if name == "" {
			continue
		}
		if _, err := ResolveDir(dir, name); err == nil {
			t.Errorf("ResolveDir accepted %q", name)
		}
	}
}

func TestResolveDirRefusesWhatIsNotAFolder(t *testing.T) {
	dir := root(t)
	if _, err := ResolveDir(dir, "Makefile"); err == nil {
		t.Error("a file was accepted as a folder")
	}
	if _, err := ResolveDir(dir, "gone"); err == nil {
		t.Error("a missing folder was accepted")
	}
}

func TestPrefixNamesTheTabAfterTheFolder(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "work")
	cases := map[string]string{
		"natal":                 "natal",
		"infra-secrets":         "infra-secrets",
		"RPi5":                  "RPi5",
		"":                      "work", // the root reads as a folder too, not as a special case
		".":                     "work",
		"my.project":            "my-project", // tmux addresses panes with a dot
		"a:b":                   "a-b",
		"очень":                 "", // nothing tmux-safe survives; the Makefile's default is better
		strings.Repeat("x", 40): strings.Repeat("x", 24),
	}
	for in, want := range cases {
		if got := Prefix(dir, in); got != want {
			t.Errorf("Prefix(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestStartCarriesTheFolderAndTheName(t *testing.T) {
	// The Makefile stays the one thing that knows how a session is launched —
	// the sandbox wrapper, its own systemd scope, and a number free as both a
	// session and a group name. What it is told is where and under what name.
	argv := Start("/srv/work", "claude", "/srv/work/natal", "natal", "", "claude")
	want := "make -C /srv/work claude DIR=/srv/work/natal PREFIX=natal KIND=claude"
	if strings.Join(argv, " ") != want {
		t.Errorf("argv is %v, want %q", argv, want)
	}
	// No folder asked for: the call is what it always was, so a Makefile that
	// knows nothing of either variable behaves exactly as before.
	argv = Start("/srv/work", "claude", "", "", "", "")
	if got := strings.Join(argv, " "); got != "make -C /srv/work claude" {
		t.Errorf("argv is %q, want the plain call", got)
	}
}

func TestExampleMakefileUsesThePrefix(t *testing.T) {
	// The name in the tab is the Makefile's decision — it picks the number that
	// is free as both a session and a group name. PREFIX is how it is told what
	// to number, and an example that ignored it would name every session after
	// the command instead of the folder.
	src, err := os.ReadFile(filepath.Join("..", "..", "deploy", "sessions.mk.example"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(src), "PREFIX") {
		t.Error("the example Makefile ignores PREFIX")
	}
}

func TestExampleMakefileStampsTheKind(t *testing.T) {
	// The two halves of one fact: the Makefile writes the option and the server
	// reads it back with the session list. Named differently, they would not
	// disagree — the page would simply never show a type, with nothing anywhere
	// saying why.
	src, err := os.ReadFile(filepath.Join("..", "..", "deploy", "sessions.mk.example"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(src), tmuxcmd.KindOption) {
		t.Errorf("the example Makefile does not stamp %s", tmuxcmd.KindOption)
	}
	if !strings.Contains(string(src), "KIND") {
		t.Error("the example Makefile ignores KIND, so the page's button never reaches the session")
	}
	// The trap that cost the first attempt: set-option reads its -t as a pane,
	// so the exact-match prefix the other commands take makes it fail outright.
	if strings.Contains(string(src), `set-option -t "=`) {
		t.Error(`set-option -t "=<name>" answers "no such session" — the stamp never lands`)
	}
}

func TestExampleMakefileKeepsMakesVariablesOutOfTheSession(t *testing.T) {
	// Variables given on a make command line are exported to the recipe and travel
	// in MAKEFLAGS, so without clearing them every session the page starts carries
	// PREFIX, DIR, KIND and CMD — and a `make` typed by hand inside that session
	// inherits them. Measured on the author's own host: `make custom CMD=qwen` in
	// such a session named the new session after the folder of the old one and
	// stamped it with the button that had started that one.
	src, err := os.ReadFile(filepath.Join("..", "..", "deploy", "sessions.mk.example"))
	if err != nil {
		t.Fatal(err)
	}
	// Inside the spawn definition, where the session is actually started: a mention
	// in a comment is not a variable being unset.
	if !strings.Contains(spawnBody(src), "tmux new-session -d -s") {
		t.Fatal("the example Makefile does not start a session in spawn")
	}
	if !strings.Contains(spawnBody(src), "env -u PREFIX") {
		t.Error("the example Makefile hands make's own variables to the session")
	}
	// On the pane's command, not in front of tmux: the pane is started by the tmux
	// server, which carries the environment it was started with and does not care
	// what the client's was. The first version of this fix put it in front of tmux
	// and cleared nothing at all.
	if !strings.Contains(spawnBody(src), `-c "$(DIR)" "$$mark; $$clean $$cmd; $$hold"`) {
		t.Error("the cleaning is not part of the command the pane runs")
	}
	for _, v := range []string{"DIR", "KIND", "CMD", "MAKEFLAGS", "MAKELEVEL"} {
		if !strings.Contains(spawnBody(src), "-u "+v) {
			t.Errorf("%s is left in the session's environment", v)
		}
	}
}

func TestExampleMakefileHoldsASessionThatFailedToStart(t *testing.T) {
	// A command that fails on startup takes its pane with it and tmux closes the
	// session — on a phone, a tab that appears and vanishes with nothing anywhere
	// saying why. Measured on the author's own host: the `continue` button in a
	// folder with no conversation to continue ("No conversation found to continue",
	// exit 1) left two sessions dead within seconds and no trace but the watcher
	// having seen a screen.
	src, err := os.ReadFile(filepath.Join("..", "..", "deploy", "sessions.mk.example"))
	if err != nil {
		t.Fatal(err)
	}
	body := spawnBody(src)
	if !strings.Contains(body, "exec $${SHELL:-/bin/sh}") {
		t.Error("a session whose command failed is not held, so the message goes with it")
	}
	// Held into a live shell rather than a dead pane: what is typed into a dead
	// pane goes nowhere, which is the failure this project keeps meeting.
	if !strings.Contains(body, `[ "$$st" = 0 ] && exit 0`) {
		t.Error("a command that exited cleanly should close its session as before")
	}
	// Bounded by how long it ran, not by the status alone: `exit` in an interactive
	// shell reports the last command's status, so a non-zero exit is the ordinary
	// way out of a session somebody worked in. Holding that one is a session that
	// refuses to close.
	if !strings.Contains(body, "$$t0") || !strings.Contains(body, `-ge 10 ] && exit "$$st"`) {
		t.Error("the hold is not bounded by how long the command ran")
	}
	if !strings.Contains(body, "mark='t0=$$(date +%s)'") {
		t.Error("nothing records when the command started, so the bound reads an empty value")
	}
}

// spawnBody is the spawn definition — the recipe that starts a session.
func spawnBody(src []byte) string {
	_, rest, ok := strings.Cut(string(src), "define spawn")
	if !ok {
		return ""
	}
	body, _, _ := strings.Cut(rest, "endef")
	return body
}

func TestShortDirIsWhatAPhoneCanRead(t *testing.T) {
	// The row has one line, and most of an absolute path is what every session on
	// the host has in common. What is left has to be the word the folder list and
	// the session name already use.
	const root, home = "/home/dms/work", "/home/dms"
	for _, c := range []struct{ dir, want string }{
		// Under the root: the folder's own name, the same one the tab carries.
		{"/home/dms/work/self", "self"},
		{"/home/dms/work/pockterm/internal/detect", "pockterm/internal/detect"},
		// The root itself is a folder like any other and says which one it is.
		{"/home/dms/work", "work"},
		{"/home/dms/work/", "work"},
		// Outside it, enough to be recognised.
		{"/home/dms", "~"},
		{"/home/dms/.config/pockterm", "~/.config/pockterm"},
		{"/var/lib/pockterm", "/var/lib/pockterm"},
		// A tmux too old for the format says nothing, and this invents nothing.
		{"", ""},
		{"   ", ""},
	} {
		if got := ShortDir(root, home, c.dir); got != c.want {
			t.Errorf("ShortDir(%q) = %q, want %q", c.dir, got, c.want)
		}
	}
	// A host with no projects root still shortens against the home directory: the
	// row is just as narrow there.
	if got := ShortDir("", home, "/home/dms/work/natal"); got != "~/work/natal" {
		t.Errorf("with no root: %q", got)
	}
	// And with neither, the path is all there is to show.
	if got := ShortDir("", "", "/home/dms/work"); got != "/home/dms/work" {
		t.Errorf("with nothing to measure against: %q", got)
	}
	// A path that merely starts with the same letters is not inside it.
	if got := ShortDir(root, home, "/home/dms/workbench"); got != "~/workbench" {
		t.Errorf("a prefix that is not a parent: %q", got)
	}
}
