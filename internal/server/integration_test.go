package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/hitromudr/pockterm/internal/tmuxcmd"
)

// The test runs a private tmux server on its own socket (-L) so it can
// never touch the user's sessions.
func tmuxL(sock string, args ...string) *exec.Cmd {
	return exec.Command("tmux", append([]string{"-L", sock}, args...)...)
}

// Entering copy-mode is what a touch swipe does to scroll history, and the
// UI hides its prompt buttons while it lasts. Checked against a real tmux:
// the state is read from the client's own grouped session, and whether that
// reflects a mode entered on the shared pane is tmux's behaviour, not ours.
func TestRealTmuxCopyMode(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	sock := fmt.Sprintf("pockterm-mode-%d", time.Now().UnixNano())
	if out, err := tmuxL(sock, "new-session", "-d", "-s", "itest", "cat").CombinedOutput(); err != nil {
		t.Fatalf("tmux new-session: %v: %s", err, out)
	}
	t.Cleanup(func() { tmuxL(sock, "kill-server").Run() })

	var clientID atomic.Int64
	srv := httptest.NewServer(Handler(Options{
		ListSessions: func() ([]tmuxcmd.Session, error) {
			out, _ := tmuxL(sock, "list-sessions", "-F",
				"#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}").Output()
			return tmuxcmd.ParseSessions(string(out)), nil
		},
		Attach: func(id int64, target string) []string {
			clientID.Store(id)
			base := tmuxcmd.Attach(target, tmuxcmd.ClientName(id))
			return append([]string{"tmux", "-L", sock}, base[1:]...)
		},
		PaneState: func(id int64) (tmuxcmd.PaneState, error) {
			argv := tmuxcmd.PaneMode(tmuxcmd.ClientName(id))
			out, err := tmuxL(sock, argv[1:]...).Output()
			if err != nil {
				return tmuxcmd.PaneState{}, err
			}
			return tmuxcmd.ParsePaneMode(string(out)), nil
		},
		Static: http.NotFoundHandler(),
	}))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws?session=itest", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	waitMode(t, c, false, 0)
	client := tmuxcmd.ClientName(clientID.Load())

	// Something to scroll back through: the pane runs cat, so what is sent
	// comes back as output and becomes history.
	for i := 0; i < 40; i++ {
		if out, err := tmuxL(sock, "send-keys", "-t", client, fmt.Sprintf("line %d", i), "Enter").CombinedOutput(); err != nil {
			t.Fatalf("tmux send-keys: %v: %s", err, out)
		}
	}

	if out, err := tmuxL(sock, "copy-mode", "-t", client).CombinedOutput(); err != nil {
		t.Fatalf("tmux copy-mode: %v: %s", err, out)
	}
	// In copy-mode at the live end. Both numbers matter here and this is the
	// pair the page used to be unable to tell apart from the next one: it put a
	// button offering the way back on screen with nowhere to go.
	waitMode(t, c, true, 0)

	if out, err := tmuxL(sock, "send-keys", "-t", client, "-X", "-N", "5", "scroll-up").CombinedOutput(); err != nil {
		t.Fatalf("tmux scroll-up: %v: %s", err, out)
	}
	waitMode(t, c, true, 5)

	if out, err := tmuxL(sock, "send-keys", "-t", client, "-X", "cancel").CombinedOutput(); err != nil {
		t.Fatalf("tmux cancel: %v: %s", err, out)
	}
	waitMode(t, c, false, 0)
}

// A program that takes the mouse and the alternate screen takes the history with
// them, and tmux says so about the pane. Checked against a real tmux because
// every guess about this cost a release: the page hid its way forward and drew a
// scrollbar over a scrollback that was not growing, reported from the phone as
// "only the up button, the others are missing" (ROY 2026-09-20, Claude Code
// 2.1.278).
//
// The two escape sequences are what that program does, not an imitation of it:
// 1049 is the alternate screen, 1002 is button-event mouse tracking, and tmux
// answers `alternate_on 1` and `mouse_any_flag 1` to both — measured on tmux 3.2a
// before this test was written. What matters is that the frame carries them; the
// buttons they decide are the page's, and the browser test owns that half.
func TestRealTmuxPaneFacts(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	sock := fmt.Sprintf("pockterm-facts-%d", time.Now().UnixNano())
	if out, err := tmuxL(sock, "new-session", "-d", "-s", "itest", "cat").CombinedOutput(); err != nil {
		t.Fatalf("tmux new-session: %v: %s", err, out)
	}
	t.Cleanup(func() { tmuxL(sock, "kill-server").Run() })

	srv := httptest.NewServer(Handler(Options{
		ListSessions: func() ([]tmuxcmd.Session, error) {
			out, _ := tmuxL(sock, "list-sessions", "-F",
				"#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}").Output()
			return tmuxcmd.ParseSessions(string(out)), nil
		},
		Attach: func(id int64, target string) []string {
			base := tmuxcmd.Attach(target, tmuxcmd.ClientName(id))
			return append([]string{"tmux", "-L", sock}, base[1:]...)
		},
		PaneState: func(id int64) (tmuxcmd.PaneState, error) {
			argv := tmuxcmd.PaneMode(tmuxcmd.ClientName(id))
			out, err := tmuxL(sock, argv[1:]...).Output()
			if err != nil {
				return tmuxcmd.PaneState{}, err
			}
			return tmuxcmd.ParsePaneMode(string(out)), nil
		},
		Static: http.NotFoundHandler(),
	}))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws?session=itest", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	// The pane runs cat: the wheel and the scrollback are tmux's, and this is the
	// reading every earlier one was taken as.
	waitFacts(t, c, false, false)

	// Now the program asks for both. The bytes are sent rather than a command that
	// would print them, and that is the same trick the history above uses: the
	// pane runs cat, so what goes in comes back out as the pane's own output and
	// tmux parses it exactly as it parses a program's.
	if err := c.WriteMessage(websocket.BinaryMessage, []byte("\x1b[?1049h\x1b[?1002h\r")); err != nil {
		t.Fatal(err)
	}
	waitFacts(t, c, true, true)

	// And gives them back, which is what leaving such a program does.
	if err := c.WriteMessage(websocket.BinaryMessage, []byte("\x1b[?1002l\x1b[?1049l\r")); err != nil {
		t.Fatal(err)
	}
	waitFacts(t, c, false, false)
}

func TestRealTmuxRoundTrip(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	sock := fmt.Sprintf("pockterm-test-%d", time.Now().UnixNano())
	if out, err := tmuxL(sock, "new-session", "-d", "-s", "itest", "cat").CombinedOutput(); err != nil {
		t.Fatalf("tmux new-session: %v: %s", err, out)
	}
	t.Cleanup(func() { tmuxL(sock, "kill-server").Run() })

	srv := httptest.NewServer(Handler(Options{
		ListSessions: func() ([]tmuxcmd.Session, error) {
			out, _ := tmuxL(sock, "list-sessions", "-F",
				"#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}").Output()
			return tmuxcmd.ParseSessions(string(out)), nil
		},
		Attach: func(id int64, target string) []string {
			base := tmuxcmd.Attach(target, tmuxcmd.ClientName(id))
			return append([]string{"tmux", "-L", sock}, base[1:]...)
		},
		Static: http.NotFoundHandler(),
	}))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws?session=itest", nil)
	if err != nil {
		t.Fatal(err)
	}

	if err := c.WriteMessage(websocket.TextMessage, []byte(`{"type":"resize","cols":90,"rows":30}`)); err != nil {
		t.Fatal(err)
	}
	if err := c.WriteMessage(websocket.BinaryMessage, []byte("polo\r")); err != nil {
		t.Fatal(err)
	}
	readBinaryUntil(t, c, "polo")

	// Grouped client session self-destroys after the client detaches.
	c.Close()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		out, _ := tmuxL(sock, "list-sessions", "-F", "#{session_name}").CombinedOutput()
		if !strings.Contains(string(out), "pockterm-") {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("client session was not destroyed after detach")
}
