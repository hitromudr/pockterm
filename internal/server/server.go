// Package server bridges a WebSocket client and a PTY attached to a
// user-chosen tmux session. It never creates sessions of its own.
package server

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/hitromudr/pockterm/internal/proto"
	"github.com/hitromudr/pockterm/internal/session"
	"github.com/hitromudr/pockterm/internal/term"
	"github.com/hitromudr/pockterm/internal/tmuxcmd"
)

// Presence is how the server tells the notifier which sessions matter and
// who is looking at them. nil disables notifications.
type Presence interface {
	// Watch puts a session under observation for good — a notification is
	// worth having precisely when nobody is attached any more.
	Watch(session string)
	Join(session string, id int64)
	SetVisible(session string, id int64, visible bool)
	Leave(session string, id int64)
	// Counts answers /api/presence: attached clients, and how many of them
	// have the page on screen.
	Counts() (clients, visible int)
	// Activity says what a session is doing — "working", "done", or "" when
	// there is nothing to claim. It travels with the session list so a tab can
	// be coloured by it.
	Activity(session string) string
	// Background says what the agent still has running while it is quiet, so a
	// tab can carry a badge as well as a colour.
	Background(session string) (shells, monitors, agents int)
}

type Options struct {
	Token        string                                 // "" disables token auth (loopback-only deployments)
	ListSessions func() ([]tmuxcmd.Session, error)      // current tmux sessions
	Attach       func(id int64, target string) []string // argv attaching a client to target
	// InMode reports the client pane's copy-mode state: whether it is in one,
	// how far back it is scrolled, and how many lines of history there are to
	// scroll through. The last is what a scrollbar is drawn from — a position
	// with no total says nothing about where in the output it is — and tmux
	// answers it out of a mode as well, which is what lets the bar be on screen
	// before the first scroll. nil disables the poll.
	InMode func(id int64) (inMode bool, back, history int, err error)
	// LeaveMode takes the client's pane out of copy-mode. The page asks for it
	// when something is typed into a pane tmux is holding in a mode, where every
	// keystroke is discarded and nothing on screen says so; nil makes the request
	// a no-op.
	LeaveMode func(id int64) error
	// ScrollTo puts the client's pane at a given number of lines back from the
	// live end. The page asks for it when the scrollbar is dragged: a drag
	// crosses the whole history at once, and asking for that in wheel notches is
	// hundreds of key bindings for tmux to run one at a time. An absolute
	// position rather than a delta, because the page's picture of where the pane
	// is can be a poll old and a delta applied to the wrong place lands
	// somewhere nobody asked for. nil makes the request a no-op.
	ScrollTo func(id int64, back int) error
	// Capture reads the client pane's history together with its screen. It is
	// what selection mode freezes, and it has to come from here because the page
	// has none of its own: tmux repaints the pane instead of letting lines scroll
	// off it, so the browser's terminal sits at the top of an empty buffer however
	// much output has gone past. nil leaves the copy window holding the screen it
	// was opened on, which is what it held before.
	Capture  func(id int64, lines int) (string, error)
	Presence Presence // notification bookkeeping; nil disables it
	Notices  *Notices // route notifications to attached pages; nil disables it
	// NotifyMode reports what the owner wants delivered ("off", "pwa",
	// "pwa+tg") and whether Telegram is configured at all; nil leaves
	// /api/notify absent and says nothing in the config frame.
	NotifyMode func() (mode string, telegram bool)
	// SetNotifyMode stores a new mode. Refusing an unknown one is its job, not
	// the handler's — the vocabulary belongs to whoever owns the state.
	SetNotifyMode func(mode string) error
	PageVersion   string                          // version of the page this binary serves; "" says nothing
	WheelLines    func() int                      // lines tmux scrolls per wheel notch; nil leaves the page on its default
	StatusRows    func() int                      // rows tmux's status line takes at the bottom; nil says nothing
	Static        http.Handler                    // the embedded PWA
	SaveUpload    func(io.Reader) (string, error) // store a pasted image, return its path; nil disables /api/upload
	LogClient     func(string)                    // record a line the browser sent; nil disables /api/log
	// StartSession creates a session from a fixed preset, in one of the folders
	// under the projects root ("" or "." meaning the root itself); nil disables
	// /api/sessions/new.
	StartSession func(preset, dir string) error
	// Folders lists the projects root's own name and the folders under it a
	// session can be started in; nil leaves /api/dirs absent.
	Folders     func() (root string, dirs []string, err error)
	RenameSess  func(from, to string) error // rename a session; nil disables /api/sessions/rename
	KillSession func(name string) error     // close a session; nil disables /api/sessions/kill
	// OrderSessions writes the order the owner dragged the tabs into; nil leaves
	// /api/sessions/order absent. The whole strip travels, not a move: the page
	// holds the row it just drew, and two phones dragging at once then end with
	// whichever saved last rather than with a list nobody arranged.
	OrderSessions func(names []string) error
	// Buttons and SetButtons are the session buttons under "+": the four the
	// page starts with and whatever the owner added beside them. nil leaves
	// /api/presets absent, which is a host where the four cannot be edited.
	//
	// The list is read and written whole: the page holds it while it is being
	// edited, and a partial save would leave the two disagreeing about what
	// exists. Validation belongs to the store, not here — SetButtons answers
	// with the list as it now stands, or with the reason it refused.
	//
	// ResetButtons puts the defaults back. It is the store's job and not a list
	// the page could send, because the defaults are the host's: a page old
	// enough to hold different ones would quietly install them.
	Buttons      func() []session.Custom
	SetButtons   func([]session.Custom) ([]session.Custom, error)
	ResetButtons func() ([]session.Custom, error)
}

// modePoll is how often a client's pane is checked for tmux copy-mode. The
// UI hides its prompt buttons while the pane shows scrollback, so the state
// has to follow a swipe closely without hammering tmux.
const modePoll = 400 * time.Millisecond

func Handler(o Options) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/", o.Static)
	mux.HandleFunc("/api/sessions", func(w http.ResponseWriter, r *http.Request) { serveSessions(o, w, r) })
	mux.HandleFunc("/api/upload", func(w http.ResponseWriter, r *http.Request) { serveUpload(o, w, r) })
	mux.HandleFunc("/api/log", func(w http.ResponseWriter, r *http.Request) { serveLog(o, w, r) })
	mux.HandleFunc("/api/presence", func(w http.ResponseWriter, r *http.Request) { servePresence(o, w, r) })
	mux.HandleFunc("/api/notify", func(w http.ResponseWriter, r *http.Request) { serveNotifyMode(o, w, r) })
	mux.HandleFunc("/api/dirs", func(w http.ResponseWriter, r *http.Request) { serveDirs(o, w, r) })
	mux.HandleFunc("/api/presets", func(w http.ResponseWriter, r *http.Request) { servePresets(o, w, r) })
	mux.HandleFunc("/api/sessions/new", func(w http.ResponseWriter, r *http.Request) { serveNewSession(o, w, r) })
	mux.HandleFunc("/api/sessions/rename", func(w http.ResponseWriter, r *http.Request) { serveRename(o, w, r) })
	mux.HandleFunc("/api/sessions/kill", func(w http.ResponseWriter, r *http.Request) { serveKill(o, w, r) })
	mux.HandleFunc("/api/sessions/order", func(w http.ResponseWriter, r *http.Request) { serveOrder(o, w, r) })
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) { serveWS(o, w, r) })
	return mux
}

// The PWA is served from the same host; foreign origins have no business
// opening terminal sockets. Non-browser clients send no Origin header.
var upgrader = websocket.Upgrader{CheckOrigin: originOK}

// originOK compares the page's origin with the host it asked on, and the
// comparison includes the port — `https://host:8443` is not `host`.
//
// That strictness is right and it is also a trap for whoever puts this behind a
// proxy on a non-standard port. nginx's `$host` drops the port, so a page served
// on :8443 sent an Origin with the port and a Host without it: every socket
// refused with 403 while the page itself loaded perfectly. On a phone that is a
// terminal stuck on "reconnecting…" with the right sessions listed above it —
// which is how it was reported on 2026-08-10. The fix belongs on the proxy
// (`proxy_set_header Host $http_host`), so what is fixed here is the silence:
// see serveWS for the line the journal now carries.
func originOK(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && u.Host == r.Host
}

var nextID atomic.Int64

func authOK(o Options, r *http.Request) bool {
	return o.Token == "" || r.URL.Query().Get("token") == o.Token
}

func serveSessions(o Options, w http.ResponseWriter, r *http.Request) {
	if !authOK(o, r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	sessions, err := o.ListSessions()
	if err != nil {
		http.Error(w, "cannot list sessions", http.StatusInternalServerError)
		return
	}
	if sessions == nil {
		sessions = []tmuxcmd.Session{}
	}
	// In the order the owner dragged the tabs into, which is the only order anybody
	// chose: tmux sorts its own list by name, and the session you keep coming back
	// to is not the one whose name sorts first. Applied here rather than in the page
	// so the drawer's list and the strip cannot disagree about it.
	sessions = tmuxcmd.SortByOrder(sessions)
	// What each session is doing, from the watcher that reads the panes. The
	// page paints a tab with it — and it rides along with the list rather than
	// having its own endpoint, because a name and its state fetched separately
	// can disagree, and the disagreement would show as the wrong tab lit up.
	if o.Presence != nil {
		for i := range sessions {
			sessions[i].State = o.Presence.Activity(sessions[i].Name)
			sessions[i].Shells, sessions[i].Monitors, sessions[i].Agents = o.Presence.Background(sessions[i].Name)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sessions)
}

// servePresence answers who is on the page right now.
//
// "clients" counts open sockets, "visible" counts the tabs actually on screen;
// a phone in a pocket keeps its socket for hours, which is why the two are
// counted separately. The deploy script used to decide by this whether a
// restart was welcome — it installs at once now — and what is left is the
// watcher's own question, whether anybody is looking at a session it is about
// to raise a notification for.
func servePresence(o Options, w http.ResponseWriter, r *http.Request) {
	if !authOK(o, r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if o.Presence == nil {
		http.Error(w, "presence is not tracked", http.StatusNotFound)
		return
	}
	clients, visible := o.Presence.Counts()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Clients int `json:"clients"`
		Visible int `json:"visible"`
	}{clients, visible})
}

// serveNotifyMode reads and sets the one switch both notification channels
// obey: "off", "pwa" (the page while it is open) or "pwa+tg" (and Telegram when
// nothing is).
//
// It lives on the server because half of what it controls is not the page's to
// control — Telegram is sent from here, to a phone that has nothing open — and
// because the answer has to survive the page. Keeping the switch in the
// browser's storage would mean a second phone, or a reinstalled PWA, quietly
// disagreeing with what the host is actually doing.
//
// `telegram` in the answer is not the switch, it is whether the third state
// exists at all: with no bot token configured, "pwa+tg" would be a state that
// looks like more delivery and produces none.
func serveNotifyMode(o Options, w http.ResponseWriter, r *http.Request) {
	if !authOK(o, r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if o.NotifyMode == nil {
		http.Error(w, "notifications are not tracked", http.StatusNotFound)
		return
	}
	if r.Method == http.MethodPost {
		if o.SetNotifyMode == nil {
			http.Error(w, "the mode is fixed on this host", http.StatusNotFound)
			return
		}
		var body struct {
			Mode string `json:"mode"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&body); err != nil {
			http.Error(w, "expected {\"mode\": …}", http.StatusBadRequest)
			return
		}
		if err := o.SetNotifyMode(body.Mode); err != nil {
			// The page sends a mode it got from here, so a refusal means the two
			// disagree about the vocabulary — worth the client's while to hear.
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	mode, telegram := o.NotifyMode()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Mode     string `json:"mode"`
		Telegram bool   `json:"telegram"`
	}{mode, telegram})
}

// serveUpload takes an image pasted in the browser and answers with the path
// it was saved under. The client types that path into the terminal: bytes
// cannot cross a pty, a filename can.
func serveUpload(o Options, w http.ResponseWriter, r *http.Request) {
	if !authOK(o, r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if o.SaveUpload == nil {
		http.Error(w, "uploads are disabled", http.StatusNotFound)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "post the image as the request body", http.StatusMethodNotAllowed)
		return
	}
	path, err := o.SaveUpload(r.Body)
	if err != nil {
		// The message says what was wrong with the image (not an image, too
		// large); the client shows it verbatim.
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"path": path})
}

// serveLog takes a line from the browser and puts it in the server's log.
//
// The phone this runs on has no console anyone can open: it is behind mTLS,
// on a tunnel, in a browser whose clipboard and keyboard behave unlike any
// desktop. Without this, every report is "it does not work" and every fix is
// a guess.
func serveLog(o Options, w http.ResponseWriter, r *http.Request) {
	if !authOK(o, r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if o.LogClient == nil {
		http.Error(w, "client logging is off", http.StatusNotFound)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "post a json line", http.StatusMethodNotAllowed)
		return
	}
	// Bounded on purpose: this endpoint writes to the journal of a box that
	// also serves git and passwords.
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<10))
	if err != nil {
		http.Error(w, "unreadable", http.StatusBadRequest)
		return
	}
	line := strings.Map(func(c rune) rune {
		if c == '\n' || c == '\r' {
			return ' '
		}
		return c
	}, string(body))
	o.LogClient(strings.TrimSpace(line))
	w.WriteHeader(http.StatusNoContent)
}

// serveNewSession creates a session from one of the presets. There is no
// command in the request — only a name from a fixed list — because with no
// session left a phone cannot type a command anywhere, and that is the entire
// problem being solved here.
func serveNewSession(o Options, w http.ResponseWriter, r *http.Request) {
	if !authOK(o, r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if o.StartSession == nil {
		http.Error(w, "starting sessions is off", http.StatusNotFound)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "post a preset", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Preset string `json:"preset"`
		// Which folder under the projects root to start in. Absent or "." is
		// the root itself — what the plain + did before folders existed.
		Dir string `json:"dir"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&req); err != nil {
		http.Error(w, "unreadable request", http.StatusBadRequest)
		return
	}
	if err := o.StartSession(req.Preset, req.Dir); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// serveOrder takes the order the tabs were dragged into.
//
// Names and not indices: the page sends the strip it drew, and the server stamps
// each session with its place. A session that has since been closed is simply not
// found — the strip is redrawn from tmux on the next poll anyway, so a stale name
// costs nothing and is not worth refusing the whole list for.
func serveOrder(o Options, w http.ResponseWriter, r *http.Request) {
	if !authOK(o, r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if o.OrderSessions == nil {
		http.Error(w, "the strip cannot be reordered on this host", http.StatusNotFound)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "post the order", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Names []string `json:"names"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<13)).Decode(&req); err != nil {
		http.Error(w, "unreadable request", http.StatusBadRequest)
		return
	}
	if err := o.OrderSessions(req.Names); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// servePresets reads and replaces the owner's custom buttons.
//
// They live on the host rather than in the browser for the same reasons the
// notification switch does: what they start is the host's business, a second
// phone or a reinstalled PWA must find the same buttons, and CI restarts this
// binary several times on a working day.
func servePresets(o Options, w http.ResponseWriter, r *http.Request) {
	if !authOK(o, r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if o.Buttons == nil {
		http.Error(w, "custom buttons are off on this host", http.StatusNotFound)
		return
	}
	list := o.Buttons()
	if r.Method == http.MethodPost {
		if o.SetButtons == nil {
			http.Error(w, "custom buttons are read-only on this host", http.StatusNotFound)
			return
		}
		var req struct {
			Buttons []session.Custom `json:"buttons"`
			// Put the defaults back. A flag rather than an endpoint of its own:
			// it is the same list being replaced, and the answer is the same
			// list coming back.
			Reset bool `json:"reset"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<14)).Decode(&req); err != nil {
			http.Error(w, "unreadable request", http.StatusBadRequest)
			return
		}
		if req.Reset {
			if o.ResetButtons == nil {
				http.Error(w, "the defaults cannot be restored on this host", http.StatusNotFound)
				return
			}
			restored, err := o.ResetButtons()
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			writeButtons(w, restored)
			return
		}
		saved, err := o.SetButtons(req.Buttons)
		if err != nil {
			// The reason is shown to the owner: which button was refused and why
			// is the only thing that makes the refusal actionable on a phone.
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		list = saved
	} else if r.Method != http.MethodGet {
		http.Error(w, "get or post the buttons", http.StatusMethodNotAllowed)
		return
	}
	writeButtons(w, list)
}

func writeButtons(w http.ResponseWriter, list []session.Custom) {
	if list == nil {
		list = []session.Custom{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Buttons []session.Custom `json:"buttons"`
	}{list})
}

// serveDirs lists the folders a session can be started in.
//
// It is the projects root's immediate children and nothing else: the page shows
// them as rows to tap, and what a phone needs is the list it actually works in,
// not a file browser. `root` travels with them because the root is one of the
// choices — a session in ~/work itself is as ordinary as one in a project, and
// naming it after the folder means the page has to know what that folder is
// called.
func serveDirs(o Options, w http.ResponseWriter, r *http.Request) {
	if !authOK(o, r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if o.Folders == nil {
		http.Error(w, "folders are not listed on this host", http.StatusNotFound)
		return
	}
	root, dirs, err := o.Folders()
	if err != nil {
		// The reason reaches the page: an unreadable root shows as a message
		// rather than as an empty list, which would read as "no projects".
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if dirs == nil {
		dirs = []string{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Root string   `json:"root"`
		Dirs []string `json:"dirs"`
	}{root, dirs})
}

// serveRename renames a session. claude-1, claude-2, claude-3 is not a list
// anyone can navigate on a phone.
func serveRename(o Options, w http.ResponseWriter, r *http.Request) {
	if !authOK(o, r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if o.RenameSess == nil {
		http.Error(w, "renaming is off", http.StatusNotFound)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "post from and to", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&req); err != nil {
		http.Error(w, "unreadable request", http.StatusBadRequest)
		return
	}
	// The session being renamed must be one the server already lists —
	// otherwise the name in the request reaches tmux unchecked.
	sessions, err := o.ListSessions()
	if err != nil {
		http.Error(w, "cannot list sessions", http.StatusInternalServerError)
		return
	}
	if !sessionExists(sessions, req.From) {
		http.Error(w, "no such session", http.StatusNotFound)
		return
	}
	if err := o.RenameSess(req.From, req.To); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// serveKill closes a session. Only a session the server already lists can be
// closed, for the same reason renaming has that rule: the name reaches a
// command line, and this one ends processes.
func serveKill(o Options, w http.ResponseWriter, r *http.Request) {
	if !authOK(o, r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if o.KillSession == nil {
		http.Error(w, "closing sessions is off", http.StatusNotFound)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "post a name", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&req); err != nil {
		http.Error(w, "unreadable request", http.StatusBadRequest)
		return
	}
	sessions, err := o.ListSessions()
	if err != nil {
		http.Error(w, "cannot list sessions", http.StatusInternalServerError)
		return
	}
	if !sessionExists(sessions, req.Name) {
		http.Error(w, "no such session", http.StatusNotFound)
		return
	}
	if err := o.KillSession(req.Name); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func serveWS(o Options, w http.ResponseWriter, r *http.Request) {
	if !authOK(o, r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	target := r.URL.Query().Get("session")
	if target == "" {
		http.Error(w, "missing session", http.StatusBadRequest)
		return
	}
	// Only attach to a session that actually exists. This both gives a
	// clean error for a stale link and blocks attaching to an arbitrary
	// name (the value reaches tmux, so it must be a known session).
	sessions, err := o.ListSessions()
	if err != nil {
		http.Error(w, "cannot list sessions", http.StatusInternalServerError)
		return
	}
	if !sessionExists(sessions, target) {
		http.Error(w, "no such session", http.StatusNotFound)
		return
	}

	// Refused here rather than inside the upgrader, because the upgrader's
	// answer is a bare 403 and this one says why. A socket rejected on origin
	// looks exactly like a network problem from the page: the terminal shows
	// "reconnecting…" for ever and nothing anywhere says which of the two it is.
	// The proxy in front is the usual cause — it is the only thing that can make
	// Host disagree with the address a browser typed.
	if !originOK(r) {
		log.Printf("ws refused: origin %q is not the host it asked on (%q) — a proxy that rewrites Host, or drops its port, is the usual cause",
			r.Header.Get("Origin"), r.Host)
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	// writeMu serializes all writes to conn. gorilla/websocket forbids concurrent
	// writes from multiple goroutines; without this mutex, the PTY→WS goroutine
	// writing binary frames will race with the main WS→PTY loop writing pong
	// replies, causing "concurrent write to websocket connection" panic.
	var writeMu sync.Mutex

	id := nextID.Add(1)
	if o.Presence != nil {
		o.Presence.Watch(target)
		o.Presence.Join(target, id)
		defer o.Presence.Leave(target, id)
	}

	// What the page needs from the server to size a gesture and to know
	// whether it is itself out of date.
	//
	// wheelLines: how far one wheel notch scrolls. Asking tmux beats assuming
	// its default, which is what made the screen move five times faster than
	// the finger.
	//
	// version: the page this binary serves. CI installs a build the moment it
	// arrives, so the unit restarts under whoever is looking and every page
	// reconnects — this frame is that moment, and a page running the previous
	// assets cannot tell on its own that they are previous. Sent on every
	// connect rather than polled for the same reason.
	{
		cfg := struct {
			Type       string `json:"type"`
			WheelLines int    `json:"wheelLines,omitempty"`
			StatusRows int    `json:"statusRows,omitempty"`
			Version    string `json:"version,omitempty"`
			// What the notification switch is set to, and whether its third
			// state exists here. In the same frame as everything else the page
			// cannot know on its own: the button has to be right the moment it
			// is drawn, and a second request for it would show the wrong state
			// for as long as that request took.
			Notify   string `json:"notify,omitempty"`
			Telegram bool   `json:"telegram,omitempty"`
		}{Type: "config", Version: o.PageVersion}
		if o.WheelLines != nil {
			if n := o.WheelLines(); n > 0 {
				cfg.WheelLines = n
			}
		}
		// How many rows at the bottom belong to tmux rather than to the pane.
		// The page shifts the rows to follow a finger, and those must stay put.
		if o.StatusRows != nil {
			cfg.StatusRows = o.StatusRows()
		}
		if o.NotifyMode != nil {
			cfg.Notify, cfg.Telegram = o.NotifyMode()
		}
		if cfg.WheelLines > 0 || cfg.Version != "" || cfg.StatusRows > 0 || cfg.Notify != "" {
			writeMu.Lock()
			conn.WriteJSON(cfg)
			writeMu.Unlock()
		}
	}

	// The watcher's events reach this page the same way everything else does.
	// It fires only for a session nobody has visible, so a frame arriving here is
	// about something the person holding the phone cannot see — which is usually
	// one of the other sessions, not this one. That is why the socket is
	// registered by its id and not under the session it is attached to.
	if o.Notices != nil {
		o.Notices.add(id, func(n Notice) {
			writeMu.Lock()
			defer writeMu.Unlock()
			conn.WriteJSON(n)
		})
		defer o.Notices.remove(id)
	}

	// The size the page reported when it opened the socket, not a default nobody
	// asked for: see requestedSize.
	cols, rows := requestedSize(r)
	t, err := term.Start(o.Attach(id, target), cols, rows)
	if err != nil {
		log.Printf("attach failed: %v", err)
		writeMu.Lock()
		conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","error":"attach failed"}`))
		writeMu.Unlock()
		return
	}
	defer t.Close()

	// Tell the client when its pane enters or leaves copy-mode, so prompt
	// buttons can disappear while it is scrolled back into history.
	if o.InMode != nil {
		done := make(chan struct{})
		defer close(done)
		go pollMode(conn, &writeMu, func() (bool, int, int, error) { return o.InMode(id) }, done)
	}

	// PTY → WS. On PTY EOF (client killed, tmux server gone) close the
	// socket to unblock the read loop below.
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, rerr := t.File.Read(buf)
			if n > 0 {
				writeMu.Lock()
				werr := conn.WriteMessage(websocket.BinaryMessage, buf[:n])
				writeMu.Unlock()
				if werr != nil {
					return
				}
			}
			if rerr != nil {
				conn.Close()
				return
			}
		}
	}()

	// WS → PTY.
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		switch mt {
		case websocket.BinaryMessage:
			if _, err := t.File.Write(data); err != nil {
				return
			}
		case websocket.TextMessage:
			c, err := proto.Parse(data)
			if err != nil {
				log.Printf("bad control frame: %v", err)
				continue
			}
			switch c.Type {
			case "resize":
				if err := t.Resize(uint16(c.Cols), uint16(c.Rows)); err != nil {
					log.Printf("resize failed: %v", err)
				}
			case "ping":
				writeMu.Lock()
				conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"pong"}`))
				writeMu.Unlock()
			case "leave-mode":
				// Typing into a pane in copy-mode goes nowhere, so an act of
				// typing is what ends the mode — see tmuxcmd.CancelMode. Handled
				// here, in the same loop that writes the keystrokes, so the mode
				// is gone before the bytes that asked for it are delivered.
				if o.LeaveMode != nil {
					if err := o.LeaveMode(id); err != nil {
						// Refused when the pane is not in a mode, which is the
						// common case of a picture a poll out of date.
						log.Printf("leave-mode: %v", err)
					}
				}
			case "scroll-to":
				// The scrollbar was dragged. Handled here for the same reason
				// leave-mode is: this loop is the one that writes the keystrokes,
				// so a scroll asked for by a finger cannot overtake or be
				// overtaken by what is typed next.
				if o.ScrollTo != nil {
					if err := o.ScrollTo(id, c.Back); err != nil {
						log.Printf("scroll-to: %v", err)
					}
				}
			case "capture":
				// The frozen copy selection mode shows. Answered on this socket
				// rather than over an endpoint of its own: the session is the one
				// this socket is attached to, so there is no name to pass and no
				// second way in to guard.
				if o.Capture != nil {
					text, err := o.Capture(id, c.Lines)
					if err != nil {
						log.Printf("capture: %v", err)
						break
					}
					frame, err := json.Marshal(captureFrame{Type: "capture", Text: text})
					if err != nil {
						log.Printf("capture: %v", err)
						break
					}
					writeMu.Lock()
					conn.WriteMessage(websocket.TextMessage, frame)
					writeMu.Unlock()
				}
			case "visible":
				// A backgrounded tab keeps its socket open, so visibility
				// is what decides whether a notification is redundant.
				if o.Presence != nil {
					o.Presence.SetVisible(target, id, c.Visible)
				}
			}
		}
	}
}

// captureFrame carries the pane's history and screen to the page that asked for
// it — the text selection mode freezes. One frame, one answer: the page keeps
// showing the screen it froze until this arrives, so a host that cannot answer
// costs nothing but the scrollback.
type captureFrame struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// modeFrame is the server→client notification about the pane's mode.
type modeFrame struct {
	Type string `json:"type"`
	In   bool   `json:"in"`
	// How many lines the pane is scrolled back. The page shows its way back to
	// the live end by this rather than by In alone: a pane in copy-mode at the
	// end has nowhere to go back to, and the button offering it was left on
	// screen with nothing behind it.
	Back int `json:"back"`
	// How many lines of history the pane has. The scrollbar needs both numbers:
	// how far back it is and how far back it could go.
	Hist int `json:"hist"`
}

// pollMode reports the pane's copy-mode state to the client until done is
// closed. The first reading is always sent (a client attaching to a pane
// already scrolled back must not wait for a transition), then only changes;
// a failed reading is skipped rather than reported as "not in mode", so a
// transient tmux error does not make the buttons flash back.
//
// A change in the scroll position is a change worth sending: it is what tells
// the page it has arrived at the end, and tmux does not always leave copy-mode
// when it gets there.
// requestedSize reads the terminal size the page put in the socket's address.
//
// It is there because of what tmux does with a client of the wrong size. Sessions
// here are grouped — one window, several clients — and tmux's own `window-size
// latest` gives the window the size of the newest client. A client attached at a
// default 80x24 and resized a moment later therefore drags the shared window down
// under everyone else looking at that session: they keep drawing at their own
// width while tmux fills lines to 80, which shows as halves of two lines in one
// row and a cursor in the wrong place. It cleared itself when the page's first
// resize message arrived, and came back on the next attach — every tab switch is
// one.
//
// Bounds rather than trust: the value comes from a query string. Anything missing,
// unparsable or absurd falls back to the classic 80x24, which is what this did
// before the size was asked for at all.
func requestedSize(r *http.Request) (cols, rows uint16) {
	return dimension(r.URL.Query().Get("cols"), 80), dimension(r.URL.Query().Get("rows"), 24)
}

// dimension parses one of them. The ceiling is a limit on what this program will
// allocate a grid for, not a guess about screens: the value arrives from a query
// string, and tmux would take a client claiming 60000 columns at its word.
func dimension(v string, fallback uint16) uint16 {
	n, err := strconv.Atoi(v)
	if err != nil || n < 2 || n > 1000 {
		return fallback
	}
	return uint16(n)
}

func pollMode(conn *websocket.Conn, writeMu *sync.Mutex, in func() (bool, int, int, error), done <-chan struct{}) {
	ticker := time.NewTicker(modePoll)
	defer ticker.Stop()
	last, lastBack, lastHist, known := false, 0, 0, false
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			cur, back, hist, err := in()
			if err != nil {
				continue
			}
			// The history grows with every line the pane prints, so this now
			// changes while output flows and not only when somebody scrolls.
			// That is the point — a bar drawn against a stale total is wrong by
			// however much has been printed since — and it costs one small frame
			// per poll on a busy pane. The page does not write a journal line
			// for it: what it records is the state it *shows* changing.
			if known && cur == last && back == lastBack && hist == lastHist {
				continue
			}
			last, lastBack, lastHist, known = cur, back, hist, true
			writeMu.Lock()
			err = conn.WriteJSON(modeFrame{Type: "mode", In: cur, Back: back, Hist: hist})
			writeMu.Unlock()
			if err != nil {
				return
			}
		}
	}
}

func sessionExists(sessions []tmuxcmd.Session, name string) bool {
	for _, s := range sessions {
		if s.Name == name {
			return true
		}
	}
	return false
}
