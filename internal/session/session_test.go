package session

import (
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

func TestStartGoesThroughTheMakefile(t *testing.T) {
	argv := Start("/home/dms/work", "claude")
	want := "make -C /home/dms/work claude"
	if strings.Join(argv, " ") != want {
		t.Errorf("argv is %v, want %q", argv, want)
	}
}
