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
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestBootstrapWithCommand(t *testing.T) {
	got := Bootstrap("claude", "/usr/local/bin/claude-start")
	want := []string{"tmux", "new-session", "-d", "-s", "claude", "/usr/local/bin/claude-start"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestBootstrapDefaultShell(t *testing.T) {
	got := Bootstrap("claude", "")
	want := []string{"tmux", "new-session", "-d", "-s", "claude"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestHasSession(t *testing.T) {
	got := HasSession("claude")
	want := []string{"tmux", "has-session", "-t", "=claude"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}
