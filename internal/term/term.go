// Package term runs a process behind a PTY.
package term

import (
	"os"
	"os/exec"

	"github.com/creack/pty"
)

type Term struct {
	File *os.File // PTY master: read output, write input
	cmd  *exec.Cmd
}

func Start(argv []string, cols, rows uint16) (*Term, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	// A full-screen program (tmux) needs a TERM with clear capability.
	// Under systemd the parent env carries none, which makes tmux attach
	// die with "open terminal failed: terminal does not support clear".
	// The web client is xterm.js, so advertise xterm-256color; appended
	// last, it overrides any inherited TERM.
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, err
	}
	return &Term{File: f, cmd: cmd}, nil
}

func (t *Term) Resize(cols, rows uint16) error {
	return pty.Setsize(t.File, &pty.Winsize{Cols: cols, Rows: rows})
}

// Close releases the PTY and reaps the process. For tmux attach
// commands the tmux server (and the session) survives: only the
// client process dies.
func (t *Term) Close() {
	t.File.Close()
	if t.cmd.Process != nil {
		t.cmd.Process.Kill()
	}
	t.cmd.Wait()
}
