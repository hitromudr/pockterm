// Package server bridges a WebSocket client and a PTY session.
package server

import (
	"log"
	"net/http"
	"net/url"
	"sync/atomic"

	"github.com/gorilla/websocket"

	"pockterm/internal/proto"
	"pockterm/internal/term"
)

type Options struct {
	Token       string                    // "" disables token auth (loopback-only deployments)
	NewSession  func(id int64) []string   // argv for a new client's session
	EnsureGroup func() error              // pre-attach hook (bootstrap); nil = no-op
	Static      http.Handler              // the embedded PWA
}

func Handler(o Options) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/", o.Static)
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

func serveWS(o Options, w http.ResponseWriter, r *http.Request) {
	if o.Token != "" && r.URL.Query().Get("token") != o.Token {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	if o.EnsureGroup != nil {
		if err := o.EnsureGroup(); err != nil {
			log.Printf("bootstrap failed: %v", err)
			conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","error":"bootstrap failed"}`))
			return
		}
	}
	t, err := term.Start(o.NewSession(nextID.Add(1)), 80, 24)
	if err != nil {
		log.Printf("session start failed: %v", err)
		conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","error":"session start failed"}`))
		return
	}
	defer t.Close()

	// PTY → WS. On PTY EOF (client killed, tmux server gone) close the
	// socket to unblock the read loop below.
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, rerr := t.File.Read(buf)
			if n > 0 {
				if werr := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
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
				conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"pong"}`))
			}
		}
	}
}
