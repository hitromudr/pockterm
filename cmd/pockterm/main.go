// Command pockterm serves a mobile web terminal that attaches to a
// user-chosen tmux session. It lists sessions but never creates them.
package main

import (
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"

	"github.com/hitromudr/pockterm"
	"github.com/hitromudr/pockterm/internal/config"
	"github.com/hitromudr/pockterm/internal/server"
	"github.com/hitromudr/pockterm/internal/tmuxcmd"
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
			return tmuxcmd.Attach(target, fmt.Sprintf("web-%d", id))
		},
		Static: http.FileServer(http.FS(static)),
	})
	log.Printf("pockterm listening on %s", cfg.Listen)
	log.Fatal(http.ListenAndServe(cfg.Listen, h))
}

// listSessions runs `tmux list-sessions`. With no server running tmux
// exits non-zero and prints nothing to stdout; that is not an error here,
// just an empty list, so the parse result is returned regardless.
func listSessions() ([]tmuxcmd.Session, error) {
	argv := tmuxcmd.ListSessions()
	out, _ := exec.Command(argv[0], argv[1:]...).Output()
	return tmuxcmd.ParseSessions(string(out)), nil
}
