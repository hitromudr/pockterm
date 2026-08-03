// Package tmuxcmd builds tmux invocations and parses their output; it
// never runs them.
package tmuxcmd

import (
	"fmt"
	"strconv"
	"strings"
)

// clientPrefix names the grouped sessions pockterm creates for its own
// clients. They are hidden from the session list and cannot be attached
// to by name, so users only ever see their own sessions.
const clientPrefix = "pockterm-"

// ClientName is the session name for a pockterm client with the given id.
func ClientName(id int64) string { return fmt.Sprintf("%s%d", clientPrefix, id) }

// IsClientSession reports whether name is one of pockterm's own client
// sessions rather than a user session.
func IsClientSession(name string) bool { return strings.HasPrefix(name, clientPrefix) }

// Session is one tmux session as reported by ListSessions.
type Session struct {
	Name     string `json:"name"`
	Windows  int    `json:"windows"`
	Created  int64  `json:"created"` // unix seconds
	Attached bool   `json:"attached"`
}

// listFormat keeps the field order ParseSessions expects.
const listFormat = "#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}"

// ListSessions returns the argv listing sessions one per line in the
// tab-separated order ParseSessions parses.
func ListSessions() []string {
	return []string{"tmux", "list-sessions", "-F", listFormat}
}

// ParseSessions turns ListSessions output into Session values. Blank and
// malformed lines are skipped so a partial line never aborts the list.
func ParseSessions(out string) []Session {
	var sessions []Session
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) != 4 || f[0] == "" {
			continue
		}
		windows, _ := strconv.Atoi(f[1])
		created, _ := strconv.ParseInt(f[2], 10, 64)
		sessions = append(sessions, Session{
			Name:     f[0],
			Windows:  windows,
			Created:  created,
			Attached: f[3] == "1",
		})
	}
	return sessions
}

// CapturePane returns the argv printing the visible text of session's
// current pane. This is how the notifier reads a screen nobody has open:
// plain text, no escapes, one line per terminal row.
func CapturePane(session string) []string {
	return []string{"tmux", "capture-pane", "-p", "-t", session}
}

// PaneInMode returns the argv reporting whether the current pane of
// session is in a tmux mode — copy-mode, which is what a touch swipe
// enters to scroll the history. The web UI needs to know: while the pane
// shows history, the numbered lines on screen belong to the past and
// answering them would send digits to whatever is running now.
func PaneInMode(session string) []string {
	return []string{"tmux", "display-message", "-p", "-t", session, "#{pane_in_mode}"}
}

// ParsePaneInMode reads PaneInMode output. Only a bare "1" means in-mode;
// empty output or an error message (dead server, session gone) does not.
func ParsePaneInMode(out string) bool {
	return strings.TrimSpace(out) == "1"
}

// Attach returns the argv attaching a web client to its own grouped
// session sharing windows with target. A grouped session gets an
// independent window size, so a phone client does not shrink the
// laptop's view. The trailing set-option makes the grouped session
// self-destroy when its last client detaches; ";" is tmux's command
// separator (a plain argv element, no shell involved). -A makes
// reconnects attach instead of failing on an existing name.
func Attach(target, webSession string) []string {
	return []string{
		"tmux", "new-session", "-A", "-s", webSession, "-t", target,
		";", "set-option", "destroy-unattached", "on",
		// mouse on lets the wheel/touch enter tmux copy-mode so scrollback
		// works in the browser. Scoped to this grouped session, so the
		// user's own direct tmux clients are unaffected.
		";", "set-option", "mouse", "on",
	}
}

// ModeKeys returns the argv asking which key table copy-mode uses. With
// `mode-keys vi` the bindings live in copy-mode-vi, and reading copy-mode
// there answers about a table nothing uses.
func ModeKeys() []string {
	return []string{"tmux", "show-options", "-gv", "mode-keys"}
}

// CopyModeTable names the table for a mode-keys value.
func CopyModeTable(modeKeys string) string {
	if strings.TrimSpace(modeKeys) == "vi" {
		return "copy-mode-vi"
	}
	return "copy-mode"
}

// WheelLines returns the argv asking tmux what its wheel binding in that
// table does. The page turns a swipe into wheel notches, so how far one notch
// scrolls is the difference between the screen following the finger and the
// screen running away from it — and it is a binding, not a constant.
func WheelLines(table string) []string {
	if table == "" {
		table = "copy-mode"
	}
	return []string{"tmux", "list-keys", "-T", table, "WheelUpPane"}
}

// ParseWheelLines reads the count out of that binding. tmux's own default is
//
//	bind-key -T copy-mode WheelUpPane select-pane \; send-keys -X -N 5 scroll-up
//
// and anything unparseable falls back to that 5 rather than to a guess of 1,
// which would make every swipe five times too short on a stock tmux.
func ParseWheelLines(out string) int {
	fields := strings.Fields(out)
	for i, f := range fields {
		if f != "-N" || i+1 >= len(fields) {
			continue
		}
		if n, err := strconv.Atoi(fields[i+1]); err == nil && n > 0 && n <= 100 {
			return n
		}
	}
	return 5
}
