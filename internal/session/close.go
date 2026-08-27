package session

import "github.com/hitromudr/pockterm/internal/tmuxcmd"

// Closed says what Close actually did, for the journal. There is nothing on a
// phone to open when a close half worked, so the host has to say it.
type Closed struct {
	// Clients are the client sessions closed ahead of the target, in order.
	Clients []string
	// Stuck are the ones that would not close. Not an error: in the ordinary
	// case the page whose client it is has already dropped its socket and tmux
	// has taken the session with `destroy-unattached`, so the name is simply
	// gone by the time the command runs.
	Stuck []string
}

// Close closes a session and, first, this server's own client sessions that
// share its group and hold its windows open.
//
// The second half is the whole point. `kill-session` closes one session, and a
// window another session in the group still holds stays open with its process
// running — so closing a tab left the agent working where nothing could see it:
// client sessions are hidden from the list, and the group kept the name taken
// besides. Observed on the host 2026-08-27, when both tabs of a pair sharing one
// folder were closed and one of the two agents went on working; reproduced the
// same day on a private tmux server (3.5a), where after `kill-session -t =work`
// the client session was still attached and the pane's `sleep` still had its pid.
// It went away only when the pty closed — which for a backgrounded PWA this
// server pings every twenty seconds is not a bound worth relying on.
//
// The clients go first, and the order is not cosmetic: killing the target first
// leaves a window held by nothing but a client session, and a page attached to
// that draws a live tab for a session tmux has already forgotten.
//
// Both the list and the runner are handed in. This package builds tmux
// invocations and the caller runs them — which is also what lets the whole
// sequence be tested against a real tmux on a private socket rather than
// against a mock of one. A refusal is the runner's to word: the message reaches
// a toast on a phone, and only the caller knows how it says things there.
func Close(name string, sessions []tmuxcmd.Session, run func(argv []string) error) (Closed, error) {
	var done Closed
	for _, client := range tmuxcmd.ClientsHolding(name, sessions) {
		if err := run(Kill(client)); err != nil {
			done.Stuck = append(done.Stuck, client)
			continue
		}
		done.Clients = append(done.Clients, client)
	}
	return done, run(Kill(name))
}
