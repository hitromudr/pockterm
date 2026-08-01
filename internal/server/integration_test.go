package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
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
		NewSession: func(id int64) []string {
			base := tmuxcmd.Attach("itest", fmt.Sprintf("web-%d", id))
			return append([]string{"tmux", "-L", sock}, base[1:]...)
		},
		Static: http.NotFoundHandler(),
	}))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
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

	// Grouped web session self-destroys after the client detaches.
	c.Close()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		out, _ := tmuxL(sock, "list-sessions", "-F", "#{session_name}").CombinedOutput()
		if !strings.Contains(string(out), "web-") {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("web session was not destroyed after detach")
}
