package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func testServer(t *testing.T, token string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(Handler(Options{
		Token:      token,
		NewSession: func(id int64) []string { return []string{"sh", "-c", "echo ready; cat"} },
		Static:     http.NotFoundHandler(),
	}))
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

func TestEchoRoundTrip(t *testing.T) {
	srv := testServer(t, "")
	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv, ""), nil)
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

func TestResizeAndPing(t *testing.T) {
	srv := testServer(t, "")
	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv, ""), nil)
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
	if _, resp, err := websocket.DefaultDialer.Dial(wsURL(srv, ""), nil); err == nil || resp == nil || resp.StatusCode != 401 {
		t.Fatalf("expected 401, got err=%v resp=%v", err, resp)
	}
	if _, _, err := websocket.DefaultDialer.Dial(wsURL(srv, "?token=s3cret"), nil); err != nil {
		t.Fatal(err)
	}
}
