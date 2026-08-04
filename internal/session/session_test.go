package session

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestOnlyKnownPresets(t *testing.T) {
	for name := range Presets {
		if _, err := Target(name); err != nil {
			t.Errorf("preset %q is listed but not resolvable: %v", name, err)
		}
	}
	// The page sends this value; anything outside the list must not reach a
	// command line.
	for _, bad := range []string{"", "rm", "claude; rm -rf /", "../../etc", "SHELL"} {
		if _, err := Target(bad); err == nil {
			t.Errorf("%q was accepted as a preset", bad)
		}
	}
}

func TestValidName(t *testing.T) {
	good := []string{"work", "claude-2", "a", "deploy_notes", strings.Repeat("x", 24)}
	for _, n := range good {
		if err := ValidName(n); err != nil {
			t.Errorf("%q rejected: %v", n, err)
		}
	}
	bad := []string{
		"",                      // nothing
		"-leading",              // tmux takes a leading dash for a flag
		"has space",             // reaches a command line
		"win:1",                 // a colon addresses windows in tmux
		"dot.name",              // and a dot addresses panes
		"$(reboot)",             // shell metacharacters
		"`id`",                  //
		strings.Repeat("x", 25), // too long to read in a tab
		"кириллица",             // not worth the ambiguity in a terminal
	}
	for _, n := range bad {
		if err := ValidName(n); err == nil {
			t.Errorf("%q accepted", n)
		}
	}
}

func TestRenameMatchesExactly(t *testing.T) {
	argv := Rename("claude-1", "notes")
	// Without "=", tmux matches by prefix and "claude-1" could rename
	// "claude-10".
	want := []string{"tmux", "rename-session", "-t", "=claude-1", "notes"}
	if strings.Join(argv, " ") != strings.Join(want, " ") {
		t.Errorf("argv is %v", argv)
	}
}

func TestKillMatchesExactly(t *testing.T) {
	// The day this was written, an evening of lost sessions was still fresh:
	// a prefix match here would close the wrong one.
	if got := strings.Join(Kill("claude-1"), " "); got != "tmux kill-session -t =claude-1" {
		t.Errorf("argv is %q", got)
	}
}

func TestStartGoesThroughTheMakefile(t *testing.T) {
	argv := Start("/srv/work", "claude", "", "", "")
	want := "make -C /srv/work claude"
	if strings.Join(argv, " ") != want {
		t.Errorf("argv is %v, want %q", argv, want)
	}
}

func TestStartCarriesACustomCommand(t *testing.T) {
	// A custom button parameterises one target instead of adding its own: the
	// Makefile still decides how a session is launched, which is the whole rule
	// this package exists to keep.
	argv := Start("/srv/work", CustomTarget, "/srv/work/natal", "natal", "qwen --yolo")
	want := "make -C /srv/work custom DIR=/srv/work/natal PREFIX=natal CMD=qwen --yolo"
	if strings.Join(argv, " ") != want {
		t.Errorf("argv is %v, want %q", argv, want)
	}
	// One argument, not two: the command reaches make as a single value, and
	// nothing here splits it on a space.
	if argv[len(argv)-1] != "CMD=qwen --yolo" {
		t.Errorf("the command was split: %q", argv[len(argv)-1])
	}
}

func TestExampleMakefileCoversEveryPreset(t *testing.T) {
	// deploy/sessions.mk.example is what someone without the author's own
	// Makefile starts from, so a preset added here and not there would give
	// them a button that fails with make's "no rule to make target".
	src, err := os.ReadFile(filepath.Join("..", "..", "deploy", "sessions.mk.example"))
	if err != nil {
		t.Fatal(err)
	}
	for name := range Presets {
		target, err := Target(name)
		if err != nil {
			t.Fatal(err)
		}
		if !regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(target) + `:`).Match(src) {
			t.Errorf("the example Makefile has no %q target", target)
		}
	}
	// The custom buttons run one target of their own, and a Makefile without it
	// turns every button the owner added into make's "no rule to make target".
	if !regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(CustomTarget) + `:`).Match(src) {
		t.Errorf("the example Makefile has no %q target", CustomTarget)
	}
}
