// Package server bridges a WebSocket client and a PTY attached to a
// user-chosen tmux session. It never creates sessions of its own.
package server

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
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
	Static       http.Handler                           // the embedded PWA
}

// modePoll is how often a client's pane is checked for tmux copy-mode. The
// UI hides its prompt buttons while the pane shows scrollback, so the state
// has to follow a swipe closely without hammering tmux.
const modePoll = 400 * time.Millisecond

func Handler(o Options) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/", o.Static)
	mux.HandleFunc("/api/sessions", func(w http.ResponseWriter, r *http.Request) { serveSessions(o, w, r) })
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
