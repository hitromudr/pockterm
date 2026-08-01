package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/hitromudr/pockterm/internal/tmuxcmd"
)

// testОptions wires a fake session list and an echo command so the server
// can be exercised without a real tmux.
func testOptions(token string) Options {
	return Options{
		Token: token,
		ListSessions: func() ([]tmuxcmd.Session, error) {
			return []tmuxcmd.Session{{Name: "demo", Windows: 1}}, nil
		},
		Attach: func(id int64, target string) []string {
			return []string{"sh", "-c", "echo ready; cat"}
		},
		Static: http.NotFoundHandler(),
	}
}

func testServer(t *testing.T, token string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(Handler(testOptions(token)))
	t.Cleanup(srv.Close)
	return srv
}

func wsURL(srv *httptest.Server, q string) string {
	return "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws" + q
}

func readBinaryUntil(t *testing.T, c *websocket.Conn, want string) {
	t.Helper()
	var got strings.Builder
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for !strings.Contains(got.String(), want) {
		mt, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("waiting for %q, got %q, err %v", want, got.String(), err)
		}
		if mt == websocket.BinaryMessage {
			got.Write(data)
		}
	}
}

func TestSessionsEndpoint(t *testing.T) {
	srv := testServer(t, "")
	resp, err := http.Get(srv.URL + "/api/sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var sessions []tmuxcmd.Session
	if err := json.NewDecoder(resp.Body).Decode(&sessions); err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].Name != "demo" {
		t.Fatalf("unexpected sessions: %+v", sessions)
	}
}

func TestEchoRoundTrip(t *testing.T) {
	srv := testServer(t, "")
	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	readBinaryUntil(t, c, "ready")
	if err := c.WriteMessage(websocket.BinaryMessage, []byte("marco\n")); err != nil {
		t.Fatal(err)
	}
	readBinaryUntil(t, c, "marco")
}

func TestUnknownSessionRejected(t *testing.T) {
	srv := testServer(t, "")
	// A session name not in the list must be refused before any attach.
	_, resp, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=ghost"), nil)
	if err == nil || resp == nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown session, got err=%v resp=%v", err, resp)
	}
}

func TestMissingSessionRejected(t *testing.T) {
	srv := testServer(t, "")
	_, resp, err := websocket.DefaultDialer.Dial(wsURL(srv, ""), nil)
	if err == nil || resp == nil || resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 without session param, got err=%v resp=%v", err, resp)
	}
}

func TestResizeAndPing(t *testing.T) {
	srv := testServer(t, "")
	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	readBinaryUntil(t, c, "ready")

	if err := c.WriteMessage(websocket.TextMessage, []byte(`{"type":"resize","cols":100,"rows":30}`)); err != nil {
		t.Fatal(err)
	}
	if err := c.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping"}`)); err != nil {
		t.Fatal(err)
	}
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		mt, data, err := c.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if mt == websocket.TextMessage && strings.Contains(string(data), "pong") {
			return
		}
	}
}

func TestTokenRequired(t *testing.T) {
	srv := testServer(t, "s3cret")
	if _, resp, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo"), nil); err == nil || resp == nil || resp.StatusCode != 401 {
		t.Fatalf("expected 401, got err=%v resp=%v", err, resp)
	}
	if _, _, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo&token=s3cret"), nil); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentOutputAndPing(t *testing.T) {
	// Regression test for concurrent writes to websocket connection.
	// The PTY→WS goroutine and the main WS→PTY loop must not write concurrently.
	opts := testOptions("")
	opts.Attach = func(id int64, target string) []string {
		return []string{"sh", "-c", "while true; do echo spam; done"}
	}
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	// Give the PTY a moment to start generating output.
	time.Sleep(100 * time.Millisecond)

	// Send many ping frames while PTY spam output flows concurrently.
	// This triggers the race condition if writes are not serialized.
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for i := 0; i < 50; i++ {
		if err := c.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping"}`)); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Verify we receive pong responses without a panic.
	pongCount := 0
	for {
		mt, data, err := c.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if mt == websocket.TextMessage && strings.Contains(string(data), "pong") {
			pongCount++
			if pongCount >= 50 {
				return
			}
		}
	}
}
