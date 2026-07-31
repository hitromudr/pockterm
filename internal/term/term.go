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
