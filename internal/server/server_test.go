package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
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

func TestPresenceEndpointReportsWhoIsLooking(t *testing.T) {
	p := &fakePresence{clients: 3, viewing: 1}
	opts := testOptions("")
	opts.Presence = p
	srv := httptest.NewServer(Handler(opts))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/api/presence")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	// Two counts, not one: a pocketed phone holds a socket for hours, so only
	// "visible" ever reaches zero, and the watcher's question is that one.
	if got["clients"] != 3.0 || got["visible"] != 1.0 {
		t.Fatalf("presence = %v, want clients 3 and visible 1", got)
	}
}

func TestPresenceEndpointNeedsTheToken(t *testing.T) {
	// It says whether the owner is at the terminal right now; that is not for
	// anyone who reaches the port.
	opts := testOptions("s3cret")
	opts.Presence = &fakePresence{}
	srv := httptest.NewServer(Handler(opts))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/api/presence")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d without a token, want 401", resp.StatusCode)
	}

	ok, err := http.Get(srv.URL + "/api/presence?token=s3cret")
	if err != nil {
		t.Fatal(err)
	}
	defer ok.Body.Close()
	if ok.StatusCode != http.StatusOK {
		t.Fatalf("status %d with the token, want 200", ok.StatusCode)
	}
}

func TestPresenceAbsentWhenNotTracked(t *testing.T) {
	srv := testServer(t, "") // testOptions leaves Presence nil
	resp, err := http.Get(srv.URL + "/api/presence")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status %d, want 404 when nothing tracks presence", resp.StatusCode)
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

func TestCopyModeReported(t *testing.T) {
	// The client hides its prompt buttons while the pane shows history, so
	// the server has to push pane-mode changes as they happen.
	opts := testOptions("")
	var inMode atomic.Bool
	var back atomic.Int64
	opts.InMode = func(id int64) (bool, int, error) { return inMode.Load(), int(back.Load()), nil }
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	readBinaryUntil(t, c, "ready")

	// The initial state arrives without a transition: a client attaching to
	// a pane already scrolled back must not wait for one.
	waitMode(t, c, false, 0)
	inMode.Store(true)
	back.Store(30)
	waitMode(t, c, true, 30)
	// Scrolled back to the live end while tmux stays in copy-mode. This is the
	// reading the page needs and the one it used to be denied: the state has
	// not changed, only the position, and without it the page goes on offering
	// a way back from where it already is.
	back.Store(0)
	waitMode(t, c, true, 0)
	inMode.Store(false)
	waitMode(t, c, false, 0)
}

// waitMode reads until a mode frame with the wanted state arrives.
func waitMode(t *testing.T, c *websocket.Conn, want bool, wantBack int) {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		mt, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("waiting for mode=%v back=%d: %v", want, wantBack, err)
		}
		if mt != websocket.TextMessage {
			continue
		}
		var f struct {
			Type string `json:"type"`
			In   bool   `json:"in"`
			Back int    `json:"back"`
		}
		if err := json.Unmarshal(data, &f); err != nil || f.Type != "mode" {
			continue
		}
		if f.In == want && f.Back == wantBack {
			return
		}
	}
}

func TestModePollOptional(t *testing.T) {
	// Without InMode wired the socket still works; no mode frames are sent.
	srv := testServer(t, "")
	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	readBinaryUntil(t, c, "ready")
}

// fakePresence records the notifier bookkeeping the socket performs.
type fakePresence struct {
	mu      sync.Mutex
	watched []string
	joined  []int64
	visible []bool
	left    []int64
	clients int // what Counts reports, set by the test
	viewing int
}

func (p *fakePresence) Watch(s string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.watched = append(p.watched, s)
}

func (p *fakePresence) Join(s string, id int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.joined = append(p.joined, id)
}

func (p *fakePresence) SetVisible(s string, id int64, visible bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.visible = append(p.visible, visible)
}

func (p *fakePresence) Leave(s string, id int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.left = append(p.left, id)
}

func (p *fakePresence) Counts() (int, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.clients, p.viewing
}

// eventually polls cond until it holds or the deadline passes.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestPresenceTracksTheClient(t *testing.T) {
	p := &fakePresence{}
	opts := testOptions("")
	opts.Presence = p
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo"), nil)
	if err != nil {
		t.Fatal(err)
	}
	readBinaryUntil(t, c, "ready")

	eventually(t, "watch and join", func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		return len(p.watched) == 1 && p.watched[0] == "demo" && len(p.joined) == 1
	})

	if err := c.WriteMessage(websocket.TextMessage, []byte(`{"type":"visible","visible":false}`)); err != nil {
		t.Fatal(err)
	}
	eventually(t, "visibility change", func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		return len(p.visible) == 1 && !p.visible[0]
	})

	c.Close()
	eventually(t, "leave on disconnect", func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		return len(p.left) == 1
	})
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

// --- image upload ---

// uploadOptions accepts anything and reports where it "saved" it, so the
// endpoint can be tested without a disk.
func uploadOptions(token string, save func(io.Reader) (string, error)) Options {
	o := testOptions(token)
	o.SaveUpload = save
	return o
}

func TestUploadReturnsThePath(t *testing.T) {
	var got []byte
	srv := httptest.NewServer(Handler(uploadOptions("", func(r io.Reader) (string, error) {
		var err error
		got, err = io.ReadAll(r)
		return "/tmp/paste-1.png", err
	})))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/upload", "image/png", strings.NewReader("PNGDATA"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var answer struct{ Path string }
	if err := json.NewDecoder(resp.Body).Decode(&answer); err != nil {
		t.Fatal(err)
	}
	if answer.Path != "/tmp/paste-1.png" {
		t.Errorf("path is %q", answer.Path)
	}
	if string(got) != "PNGDATA" {
		t.Errorf("store received %q", got)
	}
}

func TestUploadRefusalReachesTheClient(t *testing.T) {
	srv := httptest.NewServer(Handler(uploadOptions("", func(io.Reader) (string, error) {
		return "", errors.New("not an image (looks like text/plain)")
	})))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/upload", "image/png", strings.NewReader("hello"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	// A silent failure here looks like "the paste did nothing".
	if !strings.Contains(string(body), "not an image") {
		t.Errorf("reason lost on the way to the client: %q", body)
	}
}

func TestUploadNeedsTheToken(t *testing.T) {
	called := false
	srv := httptest.NewServer(Handler(uploadOptions("secret", func(io.Reader) (string, error) {
		called = true
		return "/tmp/x.png", nil
	})))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/upload", "image/png", strings.NewReader("PNGDATA"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", resp.StatusCode)
	}
	if called {
		t.Error("an unauthorized upload reached the store")
	}
}

func TestUploadIsAbsentWhenNoStore(t *testing.T) {
	srv := testServer(t, "")
	resp, err := http.Post(srv.URL+"/api/upload", "image/png", strings.NewReader("PNGDATA"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status %d, want 404", resp.StatusCode)
	}
}

func TestUploadRejectsGet(t *testing.T) {
	srv := httptest.NewServer(Handler(uploadOptions("", func(io.Reader) (string, error) {
		return "/tmp/x.png", nil
	})))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/upload")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status %d, want 405", resp.StatusCode)
	}
}

// --- creating and renaming sessions ---

func TestNewSessionRefusesAnUnknownPreset(t *testing.T) {
	asked := ""
	o := testOptions("")
	o.StartSession = func(preset string) (err error) {
		asked = preset
		if preset != "claude" {
			return errors.New("unknown preset")
		}
		return nil
	}
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/sessions/new", "application/json",
		strings.NewReader(`{"preset":"rm -rf /"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", resp.StatusCode)
	}
	// The preset still reached the starter, which is what validates it —
	// this only checks the answer is a refusal, not a 500.
	if asked != "rm -rf /" {
		t.Errorf("starter saw %q", asked)
	}
}

func TestNewSessionStarts(t *testing.T) {
	started := ""
	o := testOptions("")
	o.StartSession = func(preset string) error { started = preset; return nil }
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/sessions/new", "application/json", strings.NewReader(`{"preset":"claude"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if started != "claude" {
		t.Errorf("started %q", started)
	}
}

func TestNewSessionNeedsTheToken(t *testing.T) {
	called := false
	o := testOptions("secret")
	o.StartSession = func(string) error { called = true; return nil }
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/sessions/new", "application/json", strings.NewReader(`{"preset":"claude"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized || called {
		t.Fatalf("status %d, starter called: %v", resp.StatusCode, called)
	}
}

func TestRenameOnlyTouchesAListedSession(t *testing.T) {
	called := false
	o := testOptions("")
	o.RenameSess = func(from, to string) error { called = true; return nil }
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	// testOptions lists exactly one session, "demo".
	resp, err := http.Post(srv.URL+"/api/sessions/rename", "application/json",
		strings.NewReader(`{"from":"not-listed","to":"whatever"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status %d, want 404", resp.StatusCode)
	}
	if called {
		t.Error("a name the server does not list reached tmux")
	}
}

func TestRenameWorks(t *testing.T) {
	var gotFrom, gotTo string
	o := testOptions("")
	o.RenameSess = func(from, to string) error { gotFrom, gotTo = from, to; return nil }
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/sessions/rename", "application/json",
		strings.NewReader(`{"from":"demo","to":"notes"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if gotFrom != "demo" || gotTo != "notes" {
		t.Errorf("renamed %q -> %q", gotFrom, gotTo)
	}
}

func TestNoticeReachesTheAttachedPage(t *testing.T) {
	// The watcher decides; the page only renders. That handover is this
	// frame, and before it existed the page guessed from the byte stream —
	// which on a tmux session is mostly the status line's clock.
	opts := testOptions("")
	notices := NewNotices()
	opts.Notices = notices
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	readBinaryUntil(t, c, "ready")

	// Sent for a session with nobody attached: nothing to deliver, and
	// nothing to panic over either.
	notices.Send("nobody", Notice{Type: "notify", Kind: "done", Session: "nobody", Title: "x"})

	notices.Send("demo", Notice{
		Type: "notify", Kind: "done", Session: "demo",
		Title: "✅ demo закончил", Body: "тесты зелёные",
	})

	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		mt, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("waiting for the notify frame: %v", err)
		}
		if mt != websocket.TextMessage {
			continue
		}
		var f Notice
		if err := json.Unmarshal(data, &f); err != nil || f.Type != "notify" {
			continue
		}
		if f.Session != "demo" || f.Kind != "done" || f.Title != "✅ demo закончил" || f.Body != "тесты зелёные" {
			t.Fatalf("frame arrived mangled: %+v", f)
		}
		return
	}
}

func TestNoticesForgetAClosedPage(t *testing.T) {
	opts := testOptions("")
	notices := NewNotices()
	opts.Notices = notices
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo"), nil)
	if err != nil {
		t.Fatal(err)
	}
	readBinaryUntil(t, c, "ready")
	c.Close()

	// The registry drops the client when its socket goes; sending after that
	// must not write to a dead connection.
	deadline := time.Now().Add(5 * time.Second)
	for {
		notices.mu.Lock()
		n := len(notices.m["demo"])
		notices.mu.Unlock()
		if n == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the closed page is still registered")
		}
		time.Sleep(20 * time.Millisecond)
	}
	notices.Send("demo", Notice{Type: "notify", Kind: "done", Session: "demo", Title: "x"})
}

func TestConfigFrameNamesThePageItServes(t *testing.T) {
	// The page cannot work out on its own that its own code is out of date: it
	// reconnects after CI restarts the unit and looks exactly as healthy as
	// before. So the server says what it serves, on every connect, and the page
	// compares — one number, and the button in the page depends on it.
	opts := testOptions("")
	opts.PageVersion = "v99"
	opts.WheelLines = func() int { return 2 }
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		mt, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("waiting for the config frame: %v", err)
		}
		if mt != websocket.TextMessage {
			continue
		}
		var f struct {
			Type       string `json:"type"`
			WheelLines int    `json:"wheelLines"`
			Version    string `json:"version"`
		}
		if err := json.Unmarshal(data, &f); err != nil || f.Type != "config" {
			continue
		}
		// Both in one frame: the page sizes a gesture and judges its own age
		// from the same message, so neither can arrive without the other.
		if f.Version != "v99" || f.WheelLines != 2 {
			t.Fatalf("config = %+v, want version v99 and 2 lines", f)
		}
		return
	}
}

func TestConfigFrameIsSkippedWhenThereIsNothingToSay(t *testing.T) {
	// A deployment with neither number configured must not send an empty frame
	// the page would have to guard against.
	opts := testOptions("")
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	readBinaryUntil(t, c, "ready")
	c.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	for {
		mt, data, err := c.ReadMessage()
		if err != nil {
			return // nothing more arrived, which is the point
		}
		if mt != websocket.TextMessage {
			continue
		}
		var f struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(data, &f) == nil && f.Type == "config" {
			t.Fatalf("a config frame arrived with nothing in it: %s", data)
		}
	}
}

func TestConfigFrameSaysHowMuchOfTheBottomIsTmux(t *testing.T) {
	// The page shifts the rows to follow a finger between whole lines, and
	// tmux's status line is the bottom row of the same grid — so it rode along,
	// which is what "the green strip rises two lines" was. The page cannot work
	// out which rows those are; this is how it is told.
	opts := testOptions("")
	opts.StatusRows = func() int { return 2 }
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		mt, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("waiting for the config frame: %v", err)
		}
		if mt != websocket.TextMessage {
			continue
		}
		var f struct {
			Type       string `json:"type"`
			StatusRows int    `json:"statusRows"`
		}
		if err := json.Unmarshal(data, &f); err != nil || f.Type != "config" {
			continue
		}
		if f.StatusRows != 2 {
			t.Fatalf("config = %+v, want statusRows 2", f)
		}
		return
	}
}
