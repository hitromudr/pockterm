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
	"strings"
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

// What a kind may look like: a preset's own name, or a custom button's id
// behind the "custom:" prefix.
//
// A gate rather than advice. The value reaches a make command line and, inside
// the recipe, a tmux command that stamps it on the session — so nothing here may
// end a quote or start an expansion. It is derived from a preset the server has
// already resolved, which is why this is a second lock rather than the first.
var kindOK = regexp.MustCompile(`^[a-z][a-z0-9-]{0,23}(:[a-z][a-z0-9]{0,15})?$`)

// Kind is what to call the session a preset starts, for the Makefile to stamp on
// it (`KIND=`) and the page to read back off it.
//
// It is the preset's own name — the four built-ins by their target, a custom
// button by its id — because that is what the page already holds. A button is
// named by its id and not by its label for the same reason the buttons endpoint
// hands ids out: a label is renamed, and a session started by that button is
// still that button's. An id the store no longer has is a button since removed,
// which the page says nothing about rather than guessing at.
//
// Empty for anything unrecognised, which leaves KIND out of the call entirely:
// a session with no claim about it is what every session was until now, and the
// page paints that neutral instead of inventing a type.
func Kind(preset string) string {
	if !kindOK.MatchString(preset) {
		return ""
	}
	if id := CustomID(preset); id != "" {
		return preset
	}
	if _, ok := Presets[preset]; !ok {
		return ""
	}
	return preset
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

// SafeName is the gate for a name pockterm did not choose: one that came off
// tmux's own list of sessions, on its way to a tmux command line.
//
// It answers a different question from ValidName above, and using that one for
// this cost 2026-09-09. ValidName's 1-24 characters are about a tab on a phone —
// what the owner may type into the rename field — while a session another tool
// started carries whatever name that tool gave it. `ana-gate-window-authority` is
// 25 characters, so the order stamp skipped it silently: the tab was dragged out
// of the end of the row, the save answered "saved", nothing was written, and the
// next poll put it back. Reported as the tab jumping back however often it was
// dragged, and the journal had it — the page sent 13 names, the host placed 12.
//
// So what is checked here is only what a command line cares about: tmux addresses
// windows and panes with "." and ":", a leading "-" reads as a flag, and a control
// character has no business in an argument. Length is not a safety property and is
// bounded only against the absurd.
func SafeName(name string) error {
	switch {
	case name == "":
		return fmt.Errorf("an empty session name")
	case len(name) > 255:
		return fmt.Errorf("a session name of %d bytes", len(name))
	case strings.HasPrefix(name, "-"):
		return fmt.Errorf("a session name starting with %q reads as a flag", "-")
	case strings.ContainsAny(name, ".:"):
		return fmt.Errorf("a session name with %q or %q addresses a window or a pane", ".", ":")
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("a session name with a control character")
		}
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

// Start is the argv that creates a session through the Makefile in makeDir.
//
// `startIn` is the directory the session opens in and `prefix` the name it is
// numbered under; both are passed as make variables, and both are omitted when
// empty. Omitted rather than defaulted here: the Makefile already has answers
// for both, and a second set of defaults would be a second owner of the one
// thing this package refuses to own — how a session is launched.
//
// A Makefile that knows neither variable still works. make accepts an override
// for a variable it never reads, so an older one starts the session where it
// always did, under the name it always used: the folder reaches the tab only
// once the Makefile is the one that understands PREFIX.
//
// `cmd` is a custom button's command and travels the same way, as `CMD=` to the
// `custom` target. A Makefile without that target fails with make's own message
// — which the drawer shows — rather than starting the wrong thing.
//
// `kind` is which button asked, as `KIND=`, and the Makefile stamps it on the
// session it creates. It travels this way rather than being recorded here
// because the name is the Makefile's to choose: only it knows which number came
// out free, so only it can say what to stamp. The same graceful degradation
// applies as to PREFIX — a Makefile that never reads KIND still starts the
// session, it just leaves it untyped.
func Start(makeDir, target, startIn, prefix, cmd, kind string) []string {
	argv := []string{"make", "-C", makeDir, target}
	if startIn != "" {
		argv = append(argv, "DIR="+startIn)
	}
	if prefix != "" {
		argv = append(argv, "PREFIX="+prefix)
	}
	if cmd != "" {
		argv = append(argv, "CMD="+cmd)
	}
	if kind != "" {
		argv = append(argv, "KIND="+kind)
	}
	return argv
}
