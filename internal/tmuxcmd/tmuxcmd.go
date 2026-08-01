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
