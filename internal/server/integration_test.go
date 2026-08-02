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
		InMode: func(id int64) (bool, error) {
			argv := tmuxcmd.PaneInMode(tmuxcmd.ClientName(id))
			out, err := tmuxL(sock, argv[1:]...).Output()
			if err != nil {
				return false, err
			}
			return tmuxcmd.ParsePaneInMode(string(out)), nil
		},
		Static: http.NotFoundHandler(),
	}))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws?session=itest", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	waitMode(t, c, false)
	client := tmuxcmd.ClientName(clientID.Load())
	if out, err := tmuxL(sock, "copy-mode", "-t", client).CombinedOutput(); err != nil {
		t.Fatalf("tmux copy-mode: %v: %s", err, out)
	}
	waitMode(t, c, true)
	if out, err := tmuxL(sock, "send-keys", "-t", client, "-X", "cancel").CombinedOutput(); err != nil {
		t.Fatalf("tmux cancel: %v: %s", err, out)
	}
	waitMode(t, c, false)
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
