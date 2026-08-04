package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	argv := Start("/srv/work", "claude", "/srv/work/natal", "natal", "")
	want := "make -C /srv/work claude DIR=/srv/work/natal PREFIX=natal"
	if strings.Join(argv, " ") != want {
		t.Errorf("argv is %v, want %q", argv, want)
	}
	// No folder asked for: the call is what it always was, so a Makefile that
	// knows nothing of either variable behaves exactly as before.
	argv = Start("/srv/work", "claude", "", "", "")
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
