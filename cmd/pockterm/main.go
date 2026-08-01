// Command pockterm serves a mobile web terminal attached to a tmux session.
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
		Token: cfg.Token,
		NewSession: func(id int64) []string {
			return tmuxcmd.Attach(cfg.Session, fmt.Sprintf("web-%d", id))
		},
		EnsureGroup: func() error {
			probe := tmuxcmd.HasSession(cfg.Session)
			if exec.Command(probe[0], probe[1:]...).Run() == nil {
				return nil
			}
			boot := tmuxcmd.Bootstrap(cfg.Session, cfg.Bootstrap)
			return exec.Command(boot[0], boot[1:]...).Run()
		},
		Static: http.FileServer(http.FS(static)),
	})
	log.Printf("pockterm listening on %s (tmux session %q)", cfg.Listen, cfg.Session)
	log.Fatal(http.ListenAndServe(cfg.Listen, h))
}
