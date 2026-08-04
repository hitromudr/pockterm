// Command pockterm serves a mobile web terminal that attaches to a
// user-chosen tmux session. It lists sessions but never creates them.
//
// Without arguments it runs the server. The subcommands exist so installation
// needs no second tool: they print the pieces the install script assembles.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/hitromudr/pockterm"
	"github.com/hitromudr/pockterm/internal/config"
	"github.com/hitromudr/pockterm/internal/server"
	"github.com/hitromudr/pockterm/internal/session"
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
  pockterm tg-setup        find your chat id and write the notification config

Environment: POCKTERM_LISTEN, POCKTERM_TOKEN, POCKTERM_PUBLIC_URL,
POCKTERM_TG_*, POCKTERM_IDLE, POCKTERM_NOTIFY_FILE, POCKTERM_PRESETS_FILE,
POCKTERM_UPLOAD_DIR
and POCKTERM_SESSION_DIR.
See the README.
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
				listen := orDefault(os.Getenv("POCKTERM_LISTEN"), "127.0.0.1:8130")
				host := ""
				// A wildcard listener is reachable from the network but says
				// nothing about how; the phone needs an address it can dial.
				if setup.IsWildcard(listen) {
					h, err := setup.LANAddress()
					if err != nil {
						return fmt.Errorf("%w — pass the address instead: pockterm qr http://<host>:<port>", err)
					}
					host = h
				}
				base = setup.ListenURL(listen, host)
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

	case "tg-setup":
		return tgSetup(args)

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

// tgSetup turns the manual half of switching notifications on — create a bot,
// then find your own chat id by reading getUpdates in a browser — into one
// command. The token still comes from @BotFather; everything after that is
// mechanical, and doing it by hand is where the instructions used to lose
// people.
func tgSetup(args []string) error {
	fs := flag.NewFlagSet("tg-setup", flag.ExitOnError)
	token := fs.String("token", os.Getenv("POCKTERM_TG_TOKEN"), "bot token from @BotFather")
	chat := fs.String("chat", "", "chat id, when the bot has spoken to more than one")
	link := fs.String("link", os.Getenv("POCKTERM_TG_LINK"), "URL to append to each message")
	write := fs.String("write", "", "env file to update instead of printing the lines")
	api := fs.String("api", os.Getenv("POCKTERM_TG_API"), "Bot API root")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if *token == "" {
		fmt.Print("bot token from @BotFather: ")
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil {
			return fmt.Errorf("reading the token: %w", err)
		}
		*token = strings.TrimSpace(line)
	}
	if *token == "" {
		return errors.New("no bot token — create a bot with @BotFather first, it takes a minute")
	}

	client := &telegram.Client{Token: *token, API: *api}
	if *chat == "" {
		chats, err := client.Chats()
		if err != nil {
			return err
		}
		switch len(chats) {
		case 0:
			// Telegram tells a bot nothing until somebody writes to it, so
			// this is the normal first answer rather than a failure.
			return errors.New("the bot has no messages yet — write anything to it in Telegram, then run this again")
		case 1:
			*chat = chats[0].ID
			fmt.Printf("chat: %s (%s)\n", chats[0].Title, chats[0].ID)
		default:
			fmt.Println("this bot has been written to from several chats:")
			for _, c := range chats {
				fmt.Printf("  %-12s %s\n", c.ID, c.Title)
			}
			return errors.New("pick one and pass it: pockterm tg-setup --chat <id>")
		}
	}

	client.Chat = *chat
	if err := client.Send("pockterm: notifications are on"); err != nil {
		return err
	}
	fmt.Println("sent a test message — check that it arrived")

	kv := [][2]string{
		{"POCKTERM_TG_TOKEN", *token},
		{"POCKTERM_TG_CHAT", *chat},
	}
	if *link != "" {
		kv = append(kv, [2]string{"POCKTERM_TG_LINK", *link})
	}
	if *write == "" {
		fmt.Println("\nadd these to /etc/pockterm/pockterm.env (0600) and restart the service:")
		for _, pair := range kv {
			fmt.Printf("%s=%s\n", pair[0], pair[1])
		}
		return nil
	}
	if err := setup.UpdateEnvFile(*write, kv); err != nil {
		return err
	}
	fmt.Printf("written to %s — restart the service to pick it up\n", *write)
	return nil
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
	notices := server.NewNotices()
	pref := notifyPref(cfg)
	buttons := customButtons(cfg)
	h := server.Handler(server.Options{
		Token:        cfg.Token,
		ListSessions: listSessions,
		Attach: func(id int64, target string) []string {
			return tmuxcmd.Attach(target, tmuxcmd.ClientName(id))
		},
		InMode:     inMode,
		Presence:   notifier(cfg, notices, pref),
		Notices:    notices,
		NotifyMode: func() (string, bool) { return string(pref.Mode()), cfg.Notify() },
		SetNotifyMode: func(m string) error {
			mode, ok := watch.ParseMode(m)
			if !ok {
				return fmt.Errorf("unknown notification mode %q", m)
			}
			if err := pref.Set(mode); err != nil {
				// Stored or not, the mode is in force — the page is told the
				// truth about what is set, and the journal about what was lost.
				log.Printf("notifications: %v", err)
			}
			log.Printf("notifications: %s", mode)
			return nil
		},
		PageVersion: pockterm.PageVersion(),
		WheelLines:  wheelLines,
		StatusRows:  statusRows,
		Static:      http.FileServer(http.FS(static)),
		SaveUpload:  uploader(cfg),
		// The browser has no console anyone can open on the phone this
		// serves; its own words land here instead.
		LogClient:    func(line string) { log.Printf("client: %s", line) },
		StartSession: starter(cfg, buttons),
		Folders:      folders(cfg),
		RenameSess:   renamer,
		KillSession:  killer,
		Buttons:      buttons.List,
		SetButtons: func(list []session.Custom) ([]session.Custom, error) {
			saved, err := buttons.Set(list)
			if err != nil && saved == nil {
				return nil, err // refused: nothing was changed
			}
			if err != nil {
				// In force but not written down: the page is told what is set,
				// the journal what was lost.
				log.Printf("custom buttons: %v", err)
			}
			log.Printf("custom buttons: %d", len(saved))
			return saved, nil
		},
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

// starter runs one of the fixed presets through the same Makefile the owner
// uses by hand, or returns nil to leave the endpoint absent.
//
// Through the Makefile and not directly: it is the one place that knows how a
// session is launched here — the claude-safe sandbox wrapper, a free session
// number, and its own systemd scope so the tmux server never lands in this
// service's cgroup. Two launchers would drift apart, and the day they do,
// somebody loses their sessions.
func starter(cfg config.Config, buttons *session.Buttons) func(preset, folder string) error {
	dir, on, err := cfg.SessionDir()
	if err != nil {
		log.Printf("%v, starting sessions is off", err)
		return nil
	}
	if !on {
		return nil
	}
	if _, err := os.Stat(filepath.Join(dir, "Makefile")); err != nil {
		log.Printf("no Makefile in %s, starting sessions is off "+
			"(POCKTERM_SESSION_DIR points at one; deploy/sessions.mk.example is a starting point)", dir)
		return nil
	}
	log.Printf("starting sessions on, via make -C %s", dir)
	return func(preset, folder string) error {
		// A custom button is the owner's own command against one target; a
		// built-in preset is a target of its own. Either way the Makefile is
		// what launches anything, which is the rule this indirection keeps.
		target, cmd := "", ""
		if id := session.CustomID(preset); id != "" {
			c, ok := buttons.Find(id)
			if !ok {
				return fmt.Errorf("no such button")
			}
			target, cmd = session.CustomTarget, c.Cmd
		} else {
			var err error
			if target, err = session.Target(preset); err != nil {
				return err
			}
		}
		// The projects root is the Makefile's own directory: one setting, and
		// the same value in every deployment this was written for.
		startIn, err := session.ResolveDir(dir, folder)
		if err != nil {
			return err
		}
		argv := session.Start(dir, target, startIn, session.Prefix(dir, folder), cmd)
		out, err := exec.Command(argv[0], argv[1:]...).CombinedOutput()
		if err != nil {
			log.Printf("start %s in %s: %v: %s", preset, startIn, err, out)
			return fmt.Errorf("could not start: %s", firstLine(string(out)))
		}
		log.Printf("started %s in %s: %s", preset, startIn, firstLine(string(out)))
		return nil
	}
}

// folders lists what the drawer offers to start a session in, or returns nil to
// leave /api/dirs absent. The root is the same directory the presets run in —
// `POCKTERM_SESSION_DIR`, ~/work here — read on every request rather than once:
// projects are cloned and removed while the service runs for weeks.
func folders(cfg config.Config) func() (string, []string, error) {
	dir, on, err := cfg.SessionDir()
	if err != nil || !on {
		return nil
	}
	root := filepath.Base(filepath.Clean(dir))
	return func() (string, []string, error) {
		dirs, err := session.Folders(dir)
		if err != nil {
			return "", nil, err
		}
		return root, dirs, nil
	}
}

// killer closes a session. Everything it touches has already been checked
// against the list the server itself produced.
func killer(name string) error {
	argv := session.Kill(name)
	out, err := exec.Command(argv[0], argv[1:]...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("could not close: %s", firstLine(string(out)))
	}
	log.Printf("closed session %s", name)
	return nil
}

// renamer renames a session. The name is checked here rather than trusted
// from the page: it reaches a command line.
func renamer(from, to string) error {
	if err := session.ValidName(to); err != nil {
		return err
	}
	// A name freed by an earlier rename can still exist as a session group,
	// and handing it out again makes this session's tab open somebody else's
	// window — permanently, since attaching merges the two. tmuxcmd.NameConflict
	// has the details; this is the one place that can catch it.
	sessions, err := listSessions()
	if err == nil {
		if err := tmuxcmd.NameConflict(to, sessions); err != nil {
			return err
		}
	}
	argv := session.Rename(from, to)
	out, err := exec.Command(argv[0], argv[1:]...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("could not rename: %s", firstLine(string(out)))
	}
	log.Printf("renamed %s to %s", from, to)
	return nil
}

// firstLine keeps an error message to one line: it ends up in a toast on a
// phone screen.
func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 120 {
		s = s[:120]
	}
	if s == "" {
		return "no output"
	}
	return s
}

// notifier wires the one watcher both channels use: Telegram for a session
// nobody has open, and a frame down the socket for a page that is open but in
// the background. Telegram is optional; the watcher is not, because the page
// no longer works out on its own when a run ended — it renders what it is
// told, and there has to be someone to tell it.
func notifier(cfg config.Config, notices *server.Notices, pref *watch.Pref) server.Presence {
	var bot *telegram.Client
	if cfg.Notify() {
		bot = &telegram.Client{Token: cfg.TGToken, Chat: cfg.TGChat, API: cfg.TGAPI}
	}
	viewers := watch.NewViewers()
	w := watch.New(watch.Options{
		Capture: capturePane,
		Notify: func(e watch.Event) {
			// The switch is read at the event and not at the attach: it is
			// changed from a page that may not be the one attached, and the
			// answer has to be the one in force now.
			page, tg := watch.Deliver(pref.Mode(), bot != nil)
			if page {
				title, body := watch.Notice(e)
				notices.Send(e.Session, server.Notice{
					Type:    "notify",
					Kind:    string(e.Kind),
					Session: e.Session,
					Title:   title,
					Body:    body,
				})
			}
			if !tg {
				return
			}
			if err := bot.Send(watch.Format(e, cfg.TGLink, cfg.TGPreview)); err != nil {
				log.Printf("telegram: %v", err)
			}
		},
		Viewing:   viewers.Viewing,
		IdleAfter: cfg.Idle,
	})
	go w.Run(context.Background())
	if bot != nil {
		log.Printf("notifications %s (page + telegram available), idle threshold %s", pref.Mode(), cfg.Idle)
	} else {
		log.Printf("notifications %s (page only, telegram not configured), idle threshold %s", pref.Mode(), cfg.Idle)
	}
	return watch.Presence{Watcher: w, Viewers: viewers}
}

// notifyPref loads the switch both channels obey. It defaults to everything the
// host can deliver, because that is what this binary did before the switch
// existed: an install must not silence a phone that was being notified.
//
// The file is under the user's config directory rather than the cache: a cache
// is scratch, and this is the answer to "do not notify me". Nowhere to write is
// not fatal — the switch then works until the next restart, and says so.
// customButtons is where the owner's own session buttons are kept — next to the
// notification mode, and for the same reasons: CI restarts this binary several
// times on a working day, and a list held in memory would be gone with it.
func customButtons(cfg config.Config) *session.Buttons {
	path := cfg.PresetsFile
	switch path {
	case "off":
		log.Printf("custom buttons are not remembered: POCKTERM_PRESETS_FILE=off")
		return session.LoadButtons("")
	case "":
		dir, err := os.UserConfigDir()
		if err != nil {
			log.Printf("no config directory, custom buttons will not survive a restart: %v", err)
			return session.LoadButtons("")
		}
		path = filepath.Join(dir, "pockterm", "buttons.json")
	}
	b := session.LoadButtons(path)
	if n := len(b.List()); n > 0 {
		log.Printf("custom buttons: %d, from %s", n, path)
	}
	return b
}

func notifyPref(cfg config.Config) *watch.Pref {
	path := cfg.NotifyFile
	switch path {
	case "off":
		log.Printf("notification mode is not remembered: POCKTERM_NOTIFY_FILE=off")
		return watch.LoadPref("", watch.ModeBoth)
	case "":
		dir, err := os.UserConfigDir()
		if err != nil {
			log.Printf("no config directory, the notification mode will not survive a restart: %v", err)
			return watch.LoadPref("", watch.ModeBoth)
		}
		path = filepath.Join(dir, "pockterm", "notify")
	}
	return watch.LoadPref(path, watch.ModeBoth)
}

// wheelLines asks tmux how many lines its copy-mode wheel binding scrolls.
// Read once per attach: a binding can change while the server runs, and the
// answer costs one tmux call against a page that will be open for hours.
// statusRows asks tmux how many rows its status line takes. The page keeps them
// still while it shifts the rest to follow a finger — see StatusLines.
func statusRows() int {
	argv := tmuxcmd.StatusLines()
	out, err := exec.Command(argv[0], argv[1:]...).Output()
	if err != nil {
		return 0
	}
	return tmuxcmd.ParseStatusLines(string(out))
}

func wheelLines() int {
	modeKeys := ""
	if argv := tmuxcmd.ModeKeys(); true {
		if out, err := exec.Command(argv[0], argv[1:]...).Output(); err == nil {
			modeKeys = string(out)
		}
	}
	argv := tmuxcmd.WheelLines(tmuxcmd.CopyModeTable(modeKeys))
	out, err := exec.Command(argv[0], argv[1:]...).Output()
	if err != nil {
		return tmuxcmd.ParseWheelLines("")
	}
	return tmuxcmd.ParseWheelLines(string(out))
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
// copy-mode (the browser scrolled back into history) and how far back it is
// scrolled. The client session is the one to ask: its current window is what
// that browser tab displays.
func inMode(id int64) (bool, int, error) {
	argv := tmuxcmd.PaneMode(tmuxcmd.ClientName(id))
	out, err := exec.Command(argv[0], argv[1:]...).Output()
	if err != nil {
		return false, 0, err
	}
	in, back := tmuxcmd.ParsePaneMode(string(out))
	return in, back, nil
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
