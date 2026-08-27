package session

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/hitromudr/pockterm/internal/term"
	"github.com/hitromudr/pockterm/internal/tmuxcmd"
)

// What closing a tab does to the process in the pane, against a real tmux
// rather than a picture of one. The private socket (-L) is why this can be run
// at all: it can never reach the owner's own sessions.
//
// This is the layer the defect was found at. With Close reduced to the one
// `kill-session` it used to be, the client session is still there afterwards
// and the pane's `sleep` still has its pid — which is what was seen on the host
// on 2026-08-27, an agent working in a window with no tab anywhere.
//
// The pty stays open throughout on purpose. Letting it go is the one thing that
// did clean up (tmux takes the client session with `destroy-unattached`), so a
// test that closed it first would pass either way.
type stand struct {
	t    *testing.T
	sock string
	pid  int
}

func newStand(t *testing.T, name string) *stand {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	s := &stand{t: t, sock: fmt.Sprintf("pockterm-%s-%d", name, time.Now().UnixNano())}
	t.Cleanup(func() { s.tmux("kill-server").Run() })
	if out, err := s.tmux("new-session", "-d", "-s", "work", "sleep 9999").CombinedOutput(); err != nil {
		t.Fatalf("new-session: %v: %s", err, out)
	}
	// No "=" before the name: that prefix means "exact session" to the commands
	// that take a session, and this one reads its -t as a pane — it answers "no
	// such session: =work" and prints an empty line. The same trap the session
	// Makefile carries a comment about for set-option.
	out, err := s.tmux("display-message", "-p", "-t", "work", "#{pane_pid}").Output()
	if err != nil {
		t.Fatalf("pane_pid: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || pid <= 0 {
		t.Fatalf("pane_pid = %q", out)
	}
	s.pid = pid
	if !s.alive() {
		t.Fatalf("the pane's process %d was not running to begin with", pid)
	}
	return s
}

func (s *stand) tmux(args ...string) *exec.Cmd {
	return exec.Command("tmux", append([]string{"-L", s.sock}, args...)...)
}

// alive asks about the pane's process without owning it: signal 0 is a
// permission check, and the tmux server reaps the child, so a dead one is gone
// rather than a zombie.
func (s *stand) alive() bool { return syscall.Kill(s.pid, 0) == nil }

func (s *stand) list() []tmuxcmd.Session {
	argv := tmuxcmd.ListSessions()
	out, _ := s.tmux(argv[1:]...).Output()
	return tmuxcmd.ParseSessions(string(out))
}

func (s *stand) has(name string) bool {
	for _, sess := range s.list() {
		if sess.Name == name {
			return true
		}
	}
	return false
}

// attach opens what a page opens: its own session grouped with the work
// session, through a pty, exactly as serveWS starts it.
func (s *stand) attach(id int64) *term.Term {
	s.t.Helper()
	argv := tmuxcmd.Attach("work", tmuxcmd.ClientName(id))
	client, err := term.Start(append([]string{"tmux", "-L", s.sock}, argv[1:]...), 51, 30)
	if err != nil {
		s.t.Fatalf("attach: %v", err)
	}
	s.t.Cleanup(client.Close)
	for i := 0; i < 50; i++ {
		for _, sess := range s.list() {
			if sess.Name == tmuxcmd.ClientName(id) && sess.Group == "work" {
				return client
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	s.t.Fatalf("the client session never joined the group: %v", s.list())
	return nil
}

// run is the runner Close is handed, pointed at this stand's own server.
func (s *stand) run(argv []string) error {
	out, err := s.tmux(argv[1:]...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, out)
	}
	return nil
}

func (s *stand) waitGone() {
	s.t.Helper()
	for i := 0; i < 60 && s.alive(); i++ {
		time.Sleep(50 * time.Millisecond)
	}
	if s.alive() {
		s.t.Fatalf("the pane's process %d outlived the session that was closed", s.pid)
	}
}

func TestCloseRealTmuxTakesThePaneWithIt(t *testing.T) {
	s := newStand(t, "close")
	s.attach(1)

	done, err := Close("work", s.list(), s.run)
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	// The process before the bookkeeping: what was reported is an agent still
	// working, and that is what has to be asserted first.
	s.waitGone()
	if left := s.list(); len(left) != 0 {
		t.Fatalf("sessions left behind: %v", left)
	}
	if len(done.Clients) != 1 || done.Clients[0] != tmuxcmd.ClientName(1) {
		t.Fatalf("closed clients %v, stuck %v", done.Clients, done.Stuck)
	}
}

// Two pages on one session. Both clients hold the window, so one left behind
// keeps the pane alive exactly as the single one did.
func TestCloseRealTmuxTakesEveryPage(t *testing.T) {
	s := newStand(t, "close2")
	s.attach(1)
	s.attach(2)

	done, err := Close("work", s.list(), s.run)
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	s.waitGone()
	if left := s.list(); len(left) != 0 {
		t.Fatalf("sessions left behind: %v", left)
	}
	if len(done.Clients) != 2 {
		t.Fatalf("closed clients %v", done.Clients)
	}
}

// The order, asserted rather than argued. Killing the target first would leave
// a window held by nothing but a client session, and a page attached to that
// draws a live tab for a session tmux has already forgotten — so the client
// goes first, and the work session is still standing when it does.
func TestCloseRealTmuxLeavesNoWindowWithoutASession(t *testing.T) {
	s := newStand(t, "order")
	s.attach(1)

	var sawWorkAfterTheClient bool
	if _, err := Close("work", s.list(), func(argv []string) error {
		if err := s.run(argv); err != nil {
			return err
		}
		if strings.Contains(argv[len(argv)-1], "pockterm-client") {
			sawWorkAfterTheClient = s.has("work") && s.alive()
		}
		return nil
	}); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if !sawWorkAfterTheClient {
		t.Fatal("the work session did not outlive its client, so the window stood on the client alone")
	}
	s.waitGone()
}

// A client that goes between the list and the kill — the page dropped its
// socket and tmux took the session with `destroy-unattached`, which is the
// ordinary way one ends. The close must not stop there: the session the owner
// asked about is still standing.
func TestCloseRealTmuxSurvivesAClientThatWentFirst(t *testing.T) {
	s := newStand(t, "gone")
	client := s.attach(1)
	sessions := s.list()

	client.Close()
	for i := 0; i < 60 && s.has(tmuxcmd.ClientName(1)); i++ {
		time.Sleep(50 * time.Millisecond)
	}
	if s.has(tmuxcmd.ClientName(1)) {
		t.Fatalf("the client session outlived its pty: %v", s.list())
	}

	done, err := Close("work", sessions, s.run)
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	if len(done.Stuck) != 1 || done.Stuck[0] != tmuxcmd.ClientName(1) {
		t.Fatalf("stuck %v, closed %v", done.Stuck, done.Clients)
	}
	s.waitGone()
	if left := s.list(); len(left) != 0 {
		t.Fatalf("sessions left behind: %v", left)
	}
}
