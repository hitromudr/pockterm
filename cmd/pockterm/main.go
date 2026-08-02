// Command pockterm serves a mobile web terminal that attaches to a
// user-chosen tmux session. It lists sessions but never creates them.
//
// Without arguments it runs the server. The subcommands exist so installation
// needs no second tool: they print the pieces the install script assembles.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/hitromudr/pockterm"
	"github.com/hitromudr/pockterm/internal/config"
	"github.com/hitromudr/pockterm/internal/server"
	"github.com/hitromudr/pockterm/internal/setup"
	"github.com/hitromudr/pockterm/internal/telegram"
	"github.com/hitromudr/pockterm/internal/tmuxcmd"
	"github.com/hitromudr/pockterm/internal/upload"
	"github.com/hitromudr/pockterm/internal/watch"
)

const usage = `pockterm — mobile web terminal for your tmux sessions

  pockterm                 run the server (configured through the environment)
  pockterm token           print a fresh shared token
  pockterm unit [flags]    print a systemd unit
  pockterm qr [url]        print the client URL as a QR code for your phone

Environment: POCKTERM_LISTEN, POCKTERM_TOKEN, POCKTERM_PUBLIC_URL,
POCKTERM_TG_*, POCKTERM_IDLE and POCKTERM_UPLOAD_DIR. See the README.
`

func main() {
	if len(os.Args) > 1 {
		if err := subcommand(os.Args[1], os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	serve()
}

// subcommand runs everything that is not the server itself.
func subcommand(name string, args []string) error {
	switch name {
	case "token":
		tok, err := setup.Token()
		if err != nil {
			return err
		}
		fmt.Println(tok)
		return nil

	case "unit":
		fs := flag.NewFlagSet("unit", flag.ExitOnError)
		user := fs.String("user", os.Getenv("USER"), "account the terminal runs as")
		listen := fs.String("listen", "127.0.0.1:8130", "listen address")
		envFile := fs.String("env-file", "/etc/pockterm/pockterm.env", "file with the token and other secrets")
		binary := fs.String("binary", "/usr/local/bin/pockterm", "installed binary path")
		if err := fs.Parse(args); err != nil {
			return err
		}
		fmt.Print(setup.Unit(setup.UnitOptions{
			User: *user, Listen: *listen, EnvFile: *envFile, Binary: *binary,
		}))
		return nil

	case "qr":
		url := ""
		if len(args) > 0 {
			url = args[0]
		} else {
			// Fall back to the environment so `pockterm qr` alone works on a
			// configured machine.
			base := os.Getenv("POCKTERM_PUBLIC_URL")
			if base == "" {
				base = "http://" + orDefault(os.Getenv("POCKTERM_LISTEN"), "127.0.0.1:8130")
			}
			url = setup.ClientURL(base, os.Getenv("POCKTERM_TOKEN"))
		}
		code, err := setup.QR(url)
		if err != nil {
			return err
		}
		fmt.Print(code)
		fmt.Println(url)
		return nil

	case "-h", "--help", "help":
		fmt.Print(usage)
		return nil
	}
	return fmt.Errorf("unknown command %q\n\n%s", name, usage)
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func serve() {
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
		InMode:     inMode,
		Presence:   notifier(cfg),
		Idle:       cfg.Idle,
		Static:     http.FileServer(http.FS(static)),
		SaveUpload: uploader(cfg),
	})
	log.Printf("pockterm listening on %s", cfg.Listen)
	log.Fatal(http.ListenAndServe(cfg.Listen, h))
}

// uploader wires the store for images pasted in the browser, or returns nil
// to leave /api/upload absent. Files land in the user's cache directory: a
// pasted screenshot is a scratch file, not something to keep next to the
// service's own data.
func uploader(cfg config.Config) func(io.Reader) (string, error) {
	dir := cfg.UploadDir
	if dir == "off" {
		return nil
	}
	if dir == "" {
		cache, err := os.UserCacheDir()
		if err != nil {
			log.Printf("no cache directory, image paste is off: %v", err)
			return nil
		}
		dir = filepath.Join(cache, "pockterm", "uploads")
	}
	log.Printf("image paste on, saving to %s", dir)
	return upload.Store{Dir: dir}.Save
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
