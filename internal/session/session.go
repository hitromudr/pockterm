// Package session starts and renames tmux sessions on behalf of the page.
//
// pockterm lists and attaches; it has never created a session, on purpose.
// The exception this package makes is narrow and deliberate: with no session
// left, a phone has no way back in — there is nowhere to type the command
// that would make one. That is not hypothetical, it happened.
//
// So: no free-form commands. The page may ask for one of a fixed set of
// presets, and each one is the same `make` target the owner would run by
// hand, in the same Makefile — one launcher, one owner. Renaming is the other
// half of the same problem: a list of claude-1, claude-2, claude-3 is not a
// list you can navigate from a phone.
package session

import (
	"fmt"
	"regexp"
)

// Presets are the make targets the page may ask for. The values are targets,
// not commands: the Makefile decides how a session is launched (sandbox
// wrapper, own systemd scope), and it stays the single place that knows.
var Presets = map[string]string{
	"shell":    "shell",
	"claude":   "claude",
	"yolo":     "yolo",
	"continue": "continue",
}

// Target maps a preset name to its make target.
func Target(preset string) (string, error) {
	t, ok := Presets[preset]
	if !ok {
		return "", fmt.Errorf("unknown preset %q", preset)
	}
	return t, nil
}

// tmux session names cannot contain a colon or a dot (it addresses windows
// and panes with them), and everything else is limited here to what stays
// readable in a tab on a phone.
var nameOK = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$`)

// ValidName reports whether a name is safe to hand to tmux and useful to
// read. The value reaches a command line, so this is a gate, not advice.
func ValidName(name string) error {
	if !nameOK.MatchString(name) {
		return fmt.Errorf("a name must be 1-24 characters of letters, digits, - or _, starting with a letter or digit")
	}
	return nil
}

// Rename is the argv that renames a session. The "=" prefix makes tmux match
// the name exactly instead of by prefix — without it, renaming "claude-1"
// could land on "claude-10".
func Rename(from, to string) []string {
	return []string{"tmux", "rename-session", "-t", "=" + from, to}
}

// Kill is the argv that closes a session. Exact match again: closing
// "claude-1" must never reach "claude-10".
func Kill(name string) []string {
	return []string{"tmux", "kill-session", "-t", "=" + name}
}

// Start is the argv that creates a session through the Makefile in dir.
func Start(dir, target string) []string {
	return []string{"make", "-C", dir, target}
}
