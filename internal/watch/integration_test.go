package watch

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hitromudr/pockterm/internal/telegram"
	"github.com/hitromudr/pockterm/internal/tmuxcmd"
)

// The whole path, end to end: a real tmux pane, capture-pane, the detector,
// the message text, and an HTTP call shaped like Telegram's. Only the Bot
// API is faked.
func TestEndToEndAgainstRealTmux(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	sock := fmt.Sprintf("pockterm-watch-%d", time.Now().UnixNano())
	tmuxL := func(args ...string) *exec.Cmd {
		return exec.Command("tmux", append([]string{"-L", sock}, args...)...)
	}
	if out, err := tmuxL("new-session", "-d", "-s", "agent", "sh").CombinedOutput(); err != nil {
		t.Fatalf("tmux new-session: %v: %s", err, out)
	}
	t.Cleanup(func() { tmuxL("kill-server").Run() })

	var mu sync.Mutex
	var sent []string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		mu.Lock()
		sent = append(sent, r.PostForm.Get("text"))
		mu.Unlock()
		w.Write([]byte(`{"ok":true}`))
	}))
	defer api.Close()
	bot := &telegram.Client{Token: "t", Chat: "1", API: api.URL}

	now := time.Unix(1_700_000_000, 0)
	w := New(Options{
		Capture: func(session string) (string, error) {
			argv := tmuxcmd.CapturePane(session)
			out, err := tmuxL(argv[1:]...).Output()
			return string(out), err
		},
		Notify: func(e Event) {
			if err := bot.Send(Format(e, "https://cc.example", true)); err != nil {
				t.Errorf("send: %v", err)
			}
		},
		IdleAfter: 30 * time.Second,
		Now:       func() time.Time { return now },
	})
	w.Watch("agent")
	w.Tick() // first reading: whatever the shell drew

	// The agent prints a menu, the way Claude Code asks for permission.
	send := func(text string) {
		if out, err := tmuxL("send-keys", "-t", "agent", text, "Enter").CombinedOutput(); err != nil {
			t.Fatalf("send-keys: %v: %s", err, out)
		}
		// send-keys returns before the shell has drawn anything.
		time.Sleep(300 * time.Millisecond)
	}
	send(`printf 'Apply this change?\n❯ 1. Yes\n  2. No\n'`)
	w.Tick()

	mu.Lock()
	got := append([]string(nil), sent...)
	mu.Unlock()
	if len(got) != 1 {
		t.Fatalf("messages = %#v, want the question", got)
	}
	for _, want := range []string{"agent", "Apply this change?", "1. Yes", "2. No", "https://cc.example"} {
		if !strings.Contains(got[0], want) {
			t.Fatalf("question message %q is missing %q", got[0], want)
		}
	}

	// The question is answered and off the screen. It has to leave before the
	// clock moves on: a pane still showing a menu is a pane waiting for someone,
	// and "finished" about it would be the opposite of what is true.
	send(`clear; printf 'built\n'`)
	w.Tick()

	// Then it goes quiet for longer than the threshold. This pane has no agent
	// counter in it, so silence is what answers here — the rule that covers a
	// shell running a build.
	now = now.Add(31 * time.Second)
	w.Tick()

	mu.Lock()
	got = append([]string(nil), sent...)
	mu.Unlock()
	if len(got) != 2 {
		t.Fatalf("messages = %#v, want a done notification too", got)
	}
	if !strings.Contains(got[1], "закончил") {
		t.Fatalf("done message = %q", got[1])
	}
}
