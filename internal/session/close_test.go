package session

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/hitromudr/pockterm/internal/tmuxcmd"
)

// The host as it stood on 2026-08-27: two work sessions in one folder, one of
// them with a page attached through its own grouped session.
func hostOn27Aug() []tmuxcmd.Session {
	return []tmuxcmd.Session{
		{Name: "xnt-lr", Group: "xnt-lr"},
		{Name: "pockterm-client-122", Group: "xnt-lr"},
		{Name: "xnt-mk"},
	}
}

func TestCloseTakesTheClientHoldingTheWindow(t *testing.T) {
	var ran [][]string
	done, err := Close("xnt-lr", hostOn27Aug(), func(argv []string) error {
		ran = append(ran, argv)
		return nil
	})
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	// The client first, the session second. Killing the session first leaves a
	// window held by nothing but a client, and a page on it draws a live tab for
	// a session tmux has forgotten.
	want := [][]string{
		{"tmux", "kill-session", "-t", "=pockterm-client-122"},
		{"tmux", "kill-session", "-t", "=xnt-lr"},
	}
	if !reflect.DeepEqual(ran, want) {
		t.Fatalf("ran %v", ran)
	}
	if !reflect.DeepEqual(done.Clients, []string{"pockterm-client-122"}) {
		t.Fatalf("closed clients %v", done.Clients)
	}
	if done.Stuck != nil {
		t.Fatalf("stuck %v", done.Stuck)
	}
}

// A session nobody has open is closed on its own: there is no second member of
// a group to keep its window, so one kill is the whole of it.
func TestCloseAloneIsOneKill(t *testing.T) {
	var ran [][]string
	if _, err := Close("xnt-mk", hostOn27Aug(), func(argv []string) error {
		ran = append(ran, argv)
		return nil
	}); err != nil {
		t.Fatalf("Close: %v", err)
	}
	want := [][]string{{"tmux", "kill-session", "-t", "=xnt-mk"}}
	if !reflect.DeepEqual(ran, want) {
		t.Fatalf("ran %v", ran)
	}
}

// A client that will not close must not hold up the session the owner asked to
// close: by the time the command runs it is usually gone of its own accord, the
// page having dropped its socket.
func TestCloseSurvivesAStuckClient(t *testing.T) {
	var ran [][]string
	done, err := Close("xnt-lr", hostOn27Aug(), func(argv []string) error {
		ran = append(ran, argv)
		if strings.Contains(argv[len(argv)-1], "pockterm-client") {
			return errors.New("can't find session")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	if len(ran) != 2 {
		t.Fatalf("ran %v", ran)
	}
	if !reflect.DeepEqual(done.Stuck, []string{"pockterm-client-122"}) {
		t.Fatalf("stuck %v", done.Stuck)
	}
	if done.Clients != nil {
		t.Fatalf("closed %v", done.Clients)
	}
}

// The target's own refusal is the caller's to show: it is what the toast says.
func TestCloseReportsTheTargetsRefusal(t *testing.T) {
	_, err := Close("xnt-mk", hostOn27Aug(), func([]string) error {
		return errors.New("no such session")
	})
	if err == nil {
		t.Fatal("a refused close reported success")
	}
}

// Two pages on one session is two clients in its group, and both hold the
// window: closing the tab has to take them all, or the one left behind keeps
// the pane alive exactly as one did.
func TestCloseTakesEveryClientInTheGroup(t *testing.T) {
	sessions := []tmuxcmd.Session{
		{Name: "xnt-lr", Group: "xnt-lr"},
		{Name: "pockterm-client-122", Group: "xnt-lr"},
		{Name: "pockterm-client-140", Group: "xnt-lr"},
		{Name: "pockterm-client-141", Group: "aml"},
		{Name: "aml", Group: "aml"},
	}
	var ran [][]string
	done, err := Close("xnt-lr", sessions, func(argv []string) error {
		ran = append(ran, argv)
		return nil
	})
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	want := [][]string{
		{"tmux", "kill-session", "-t", "=pockterm-client-122"},
		{"tmux", "kill-session", "-t", "=pockterm-client-140"},
		{"tmux", "kill-session", "-t", "=xnt-lr"},
	}
	if !reflect.DeepEqual(ran, want) {
		t.Fatalf("ran %v", ran)
	}
	if len(done.Clients) != 2 {
		t.Fatalf("closed %v", done.Clients)
	}
}

// The client of another session is not this one's to close. It shares nothing
// with the target but this server's own prefix, and killing it would drop a
// page that is looking at something else entirely.
func TestCloseLeavesAnotherSessionsClientAlone(t *testing.T) {
	sessions := []tmuxcmd.Session{
		{Name: "xnt-lr", Group: "xnt-lr"},
		{Name: "pockterm-client-141", Group: "aml"},
		{Name: "aml", Group: "aml"},
	}
	var ran [][]string
	if _, err := Close("xnt-lr", sessions, func(argv []string) error {
		ran = append(ran, argv)
		return nil
	}); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// xnt-lr carries a group of its own name with no other member — a client
	// that has since gone. One kill, and aml's client is not in it.
	want := [][]string{{"tmux", "kill-session", "-t", "=xnt-lr"}}
	if !reflect.DeepEqual(ran, want) {
		t.Fatalf("ran %v", ran)
	}
}

// A session this server has never heard of: refused upstream by the endpoint,
// which only closes what its own list carries, and closed alone here rather
// than reaching for a group that does not exist.
func TestCloseAnUnknownNameIsOneKill(t *testing.T) {
	var ran [][]string
	if _, err := Close("gone", hostOn27Aug(), func(argv []string) error {
		ran = append(ran, argv)
		return nil
	}); err != nil {
		t.Fatalf("Close: %v", err)
	}
	want := [][]string{{"tmux", "kill-session", "-t", "=gone"}}
	if !reflect.DeepEqual(ran, want) {
		t.Fatalf("ran %v", ran)
	}
}

// Two user sessions in one group cannot happen through this server, and if a
// hand-made one ever did, closing one tab must not take the other's windows.
// Only this server's own clients are ever named.
func TestCloseLeavesAUserSessionSharingTheGroup(t *testing.T) {
	sessions := []tmuxcmd.Session{
		{Name: "one", Group: "one"},
		{Name: "two", Group: "one"},
	}
	var ran [][]string
	if _, err := Close("one", sessions, func(argv []string) error {
		ran = append(ran, argv)
		return nil
	}); err != nil {
		t.Fatalf("Close: %v", err)
	}
	want := [][]string{{"tmux", "kill-session", "-t", "=one"}}
	if !reflect.DeepEqual(ran, want) {
		t.Fatalf("ran %v", ran)
	}
}
