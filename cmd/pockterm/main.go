// Command pockterm serves a mobile web terminal that attaches to a
// user-chosen tmux session. It lists sessions but never creates them.
package main

import (
	"context"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"

	"github.com/hitromudr/pockterm"
	"github.com/hitromudr/pockterm/internal/config"
	"github.com/hitromudr/pockterm/internal/server"
	"github.com/hitromudr/pockterm/internal/telegram"
	"github.com/hitromudr/pockterm/internal/tmuxcmd"
	"github.com/hitromudr/pockterm/internal/watch"
)

func main() {
	cfg, err := config.FromEnv(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	static, err := fs.Sub(pockterm.Web, "web")
	if err != nil {
		log.Fatal(err)
	}
	h := server.Handler(server.Options{
		Token:        cfg.Token,
		ListSessions: listSessions,
		Attach: func(id int64, target string) []string {
			return tmuxcmd.Attach(target, tmuxcmd.ClientName(id))
		},
		InMode:   inMode,
		Presence: notifier(cfg),
		Static:   http.FileServer(http.FS(static)),
	})
	log.Printf("pockterm listening on %s", cfg.Listen)
	log.Fatal(http.ListenAndServe(cfg.Listen, h))
}

// notifier wires the Telegram notifications, or returns nil when they are
// not configured — in which case nothing is watched and nothing is sent.
func notifier(cfg config.Config) server.Presence {
	if !cfg.Notify() {
		return nil
	}
	bot := &telegram.Client{Token: cfg.TGToken, Chat: cfg.TGChat, API: cfg.TGAPI}
	viewers := watch.NewViewers()
	w := watch.New(watch.Options{
		Capture: capturePane,
		Notify: func(e watch.Event) {
			if err := bot.Send(watch.Format(e, cfg.TGLink, cfg.TGPreview)); err != nil {
				log.Printf("telegram: %v", err)
			}
		},
		Viewing:   viewers.Viewing,
		IdleAfter: cfg.Idle,
	})
	go w.Run(context.Background())
	log.Printf("telegram notifications on, idle threshold %s", cfg.Idle)
	return watch.Presence{Watcher: w, Viewers: viewers}
}

// capturePane reads the visible text of a session's current pane.
func capturePane(session string) (string, error) {
	argv := tmuxcmd.CapturePane(session)
	out, err := exec.Command(argv[0], argv[1:]...).Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// inMode asks tmux whether the client's own grouped session is showing
// copy-mode (the browser scrolled back into history). The client session is
// the one to ask: its current window is what that browser tab displays.
func inMode(id int64) (bool, error) {
	argv := tmuxcmd.PaneInMode(tmuxcmd.ClientName(id))
	out, err := exec.Command(argv[0], argv[1:]...).Output()
	if err != nil {
		return false, err
	}
	return tmuxcmd.ParsePaneInMode(string(out)), nil
}

// listSessions runs `tmux list-sessions`. With no server running tmux
// exits non-zero and prints nothing to stdout; that is not an error here,
// just an empty list, so the parse result is returned regardless.
func listSessions() ([]tmuxcmd.Session, error) {
	argv := tmuxcmd.ListSessions()
	out, _ := exec.Command(argv[0], argv[1:]...).Output()
	var visible []tmuxcmd.Session
	for _, s := range tmuxcmd.ParseSessions(string(out)) {
		if !tmuxcmd.IsClientSession(s.Name) {
			visible = append(visible, s)
		}
	}
	return visible, nil
}
