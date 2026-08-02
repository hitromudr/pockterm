// Package server bridges a WebSocket client and a PTY attached to a
// user-chosen tmux session. It never creates sessions of its own.
package server

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/hitromudr/pockterm/internal/proto"
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
}

type Options struct {
	Token        string                                 // "" disables token auth (loopback-only deployments)
	ListSessions func() ([]tmuxcmd.Session, error)      // current tmux sessions
	Attach       func(id int64, target string) []string // argv attaching a client to target
	InMode       func(id int64) (bool, error)           // client pane in tmux copy-mode; nil disables the poll
	Presence     Presence                               // notification bookkeeping; nil disables it
	Idle         time.Duration                          // silence that counts as "finished"; told to the client
	Static       http.Handler                           // the embedded PWA
	SaveUpload   func(io.Reader) (string, error)        // store a pasted image, return its path; nil disables /api/upload
	LogClient    func(string)                           // record a line the browser sent; nil disables /api/log
	StartSession func(preset string) error              // create a session from a fixed preset; nil disables /api/sessions/new
	RenameSess   func(from, to string) error            // rename a session; nil disables /api/sessions/rename
	KillSession  func(name string) error                // close a session; nil disables /api/sessions/kill
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
	mux.HandleFunc("/api/sessions/new", func(w http.ResponseWriter, r *http.Request) { serveNewSession(o, w, r) })
	mux.HandleFunc("/api/sessions/rename", func(w http.ResponseWriter, r *http.Request) { serveRename(o, w, r) })
	mux.HandleFunc("/api/sessions/kill", func(w http.ResponseWriter, r *http.Request) { serveKill(o, w, r) })
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) { serveWS(o, w, r) })
	return mux
}

// The PWA is served from the same host; foreign origins have no business
// opening terminal sockets. Non-browser clients send no Origin header.
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		u, err := url.Parse(origin)
		return err == nil && u.Host == r.Host
	},
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
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sessions)
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
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&req); err != nil {
		http.Error(w, "unreadable request", http.StatusBadRequest)
		return
	}
	if err := o.StartSession(req.Preset); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
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

	t, err := term.Start(o.Attach(id, target), 80, 24)
	if err != nil {
		log.Printf("attach failed: %v", err)
		writeMu.Lock()
		conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","error":"attach failed"}`))
		writeMu.Unlock()
		return
	}
	defer t.Close()

	// The page raises its own notifications while it is open, and it has to
	// agree with the server about what counts as "finished" — otherwise the
	// same run is announced twice, at two different moments.
	if o.Idle > 0 {
		writeMu.Lock()
		conn.WriteJSON(struct {
			Type string `json:"type"`
			Idle int    `json:"idle"`
		}{"config", int(o.Idle.Seconds())})
		writeMu.Unlock()
	}

	// Tell the client when its pane enters or leaves copy-mode, so prompt
	// buttons can disappear while it is scrolled back into history.
	if o.InMode != nil {
		done := make(chan struct{})
		defer close(done)
		go pollMode(conn, &writeMu, func() (bool, error) { return o.InMode(id) }, done)
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

// modeFrame is the server→client notification about the pane's mode.
type modeFrame struct {
	Type string `json:"type"`
	In   bool   `json:"in"`
}

// pollMode reports the pane's copy-mode state to the client until done is
// closed. The first reading is always sent (a client attaching to a pane
// already scrolled back must not wait for a transition), then only changes;
// a failed reading is skipped rather than reported as "not in mode", so a
// transient tmux error does not make the buttons flash back.
func pollMode(conn *websocket.Conn, writeMu *sync.Mutex, in func() (bool, error), done <-chan struct{}) {
	ticker := time.NewTicker(modePoll)
	defer ticker.Stop()
	last, known := false, false
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			cur, err := in()
			if err != nil {
				continue
			}
			if known && cur == last {
				continue
			}
			last, known = cur, true
			writeMu.Lock()
			err = conn.WriteJSON(modeFrame{Type: "mode", In: cur})
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
