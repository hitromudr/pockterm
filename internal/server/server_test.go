package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/hitromudr/pockterm/internal/push"
	"github.com/hitromudr/pockterm/internal/session"
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

// safeBuffer collects log output written from the server's own goroutines.
type safeBuffer struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (b *safeBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *safeBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// captureLog points the standard logger at w and returns the undo.
func captureLog(w io.Writer) func() {
	prev := log.Writer()
	flags := log.Flags()
	log.SetOutput(w)
	return func() { log.SetOutput(prev); log.SetFlags(flags) }
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
	var hist atomic.Int64
	hist.Store(800)
	opts.InMode = func(id int64) (bool, int, int, error) {
		return inMode.Load(), int(back.Load()), int(hist.Load()), nil
	}
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
	// The history size travels with them, and it changes on its own while the
	// pane prints: a scrollbar drawn against the total it had a minute ago is
	// wrong by everything printed since. Nothing else about the pane moved here.
	hist.Store(1200)
	waitHist(t, c, 1200)
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

// waitHist reads until a mode frame carrying the wanted history size arrives.
func waitHist(t *testing.T, c *websocket.Conn, want int) {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		mt, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("waiting for hist=%d: %v", want, err)
		}
		if mt != websocket.TextMessage {
			continue
		}
		var f struct {
			Type string `json:"type"`
			Hist int    `json:"hist"`
		}
		if err := json.Unmarshal(data, &f); err != nil || f.Type != "mode" {
			continue
		}
		if f.Hist == want {
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
	// What Activity reports per session, set by the test. A tab is coloured by
	// it, so the list has to carry it.
	activity map[string]string
	// What Background reports per session: shells and monitors still running.
	background map[string][3]int
}

func (p *fakePresence) Activity(s string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.activity[s]
}

func (p *fakePresence) Background(s string) (int, int, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	bg := p.background[s]
	return bg[0], bg[1], bg[2]
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

// shortenKeepAlive puts the socket's own clock inside a test's patience. The
// bounds in force are twenty seconds and a minute, and a test that waits for
// those is a test nobody runs.
func shortenKeepAlive(t *testing.T, every, wait time.Duration) {
	t.Helper()
	prevEvery, prevWait := pingEvery, pongWait
	pingEvery, pongWait = every, wait
	t.Cleanup(func() { pingEvery, pongWait = prevEvery, prevWait })
}

// readInBackground keeps reading so the connection's control frames are
// delivered: a ping is answered while reading and nowhere else.
func readInBackground(c *websocket.Conn) {
	go func() {
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				return
			}
		}
	}()
}

// A socket nobody is using is pinged from this side, which is the only side that
// can. The page asks after ten seconds of silence, but only while it is on
// screen — and a quiet session carries no frames at all, so between two
// keystrokes there was nothing on this socket for hours. Whatever drops an idle
// connection on the way then leaves a socket both ends still call open, and a
// notice written into it is counted as delivered.
func TestServerPingsASocketNobodyIsUsing(t *testing.T) {
	shortenKeepAlive(t, 40*time.Millisecond, 5*time.Second)
	srv := testServer(t, "")

	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	pings := make(chan struct{}, 4)
	c.SetPingHandler(func(data string) error {
		select {
		case pings <- struct{}{}:
		default:
		}
		// Answered by hand: overriding the handler takes gorilla's own pong with
		// it, and a ping nobody answers is the next test.
		return c.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(time.Second))
	})
	readInBackground(c)

	select {
	case <-pings:
	case <-time.After(5 * time.Second):
		t.Fatal("a quiet socket was never pinged: nothing holds it open between two keystrokes")
	}
}

// A far end that hears the ping and says nothing is let go, and the journal says
// so. That is what this server had no way to learn: a connection dropped
// somewhere on the way looks open from here, a write into it succeeds into the
// kernel, and every notice sent afterwards was reported as delivered to a page
// that had not existed for hours.
func TestServerLetsGoOfASocketThatStopsAnswering(t *testing.T) {
	shortenKeepAlive(t, 20*time.Millisecond, 200*time.Millisecond)
	var logs safeBuffer
	defer captureLog(&logs)()

	p := &fakePresence{}
	opts := testOptions("")
	opts.Presence = p
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetPingHandler(func(string) error { return nil })
	readInBackground(c)

	eventually(t, "the socket to be let go", func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		return len(p.left) == 1
	})
	if !strings.Contains(logs.String(), "socket gone: demo") {
		t.Fatalf("the end was not written down: %q", logs.String())
	}
}

// And a page that answers keeps its socket for as long as it answers — the
// deadline above is about silence, and a phone in a pocket is not silent by the
// protocol's measure even when nothing is typed into it for an hour.
func TestServerKeepsASocketThatAnswers(t *testing.T) {
	shortenKeepAlive(t, 20*time.Millisecond, 150*time.Millisecond)
	p := &fakePresence{}
	opts := testOptions("")
	opts.Presence = p
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	// gorilla's own handler answers the ping, which is what a browser's network
	// stack does without asking the page.
	readInBackground(c)

	// Several pongWaits with nothing typed.
	time.Sleep(time.Second)
	p.mu.Lock()
	left := len(p.left)
	p.mu.Unlock()
	if left != 0 {
		t.Fatalf("an answering socket was dropped %d time(s)", left)
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

// --- upload ---

// uploadOptions accepts anything and reports where it "saved" it, so the
// endpoint can be tested without a disk.
func uploadOptions(token string, save func(io.Reader, string) (string, error)) Options {
	o := testOptions(token)
	o.SaveUpload = save
	return o
}

func TestUploadReturnsThePath(t *testing.T) {
	var got []byte
	srv := httptest.NewServer(Handler(uploadOptions("", func(r io.Reader, name string) (string, error) {
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

// What the browser called the file is what tells a document from a note, so
// it has to reach the store — in whatever alphabet it was named in.
func TestUploadCarriesTheNameToTheStore(t *testing.T) {
	got := ""
	srv := httptest.NewServer(Handler(uploadOptions("secret", func(_ io.Reader, name string) (string, error) {
		got = name
		return "/tmp/paste-1-" + name, nil
	})))
	defer srv.Close()

	// The token rides in the same query, which is what the page assembles.
	want := "черновик письма.md"
	resp, err := http.Post(
		srv.URL+"/api/upload?token=secret&name="+url.QueryEscape(want),
		"application/octet-stream", strings.NewReader("text"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if got != want {
		t.Errorf("store was told the name is %q, want %q", got, want)
	}
}

// An upload with no name at all is the clipboard path: a screenshot arrives
// as a blob with nothing to call it, and the store answers that question.
func TestUploadWithoutANameStillReachesTheStore(t *testing.T) {
	called := false
	srv := httptest.NewServer(Handler(uploadOptions("", func(_ io.Reader, name string) (string, error) {
		called, _ = true, name
		if name != "" {
			t.Errorf("name is %q, want it empty", name)
		}
		return "/tmp/paste-1.png", nil
	})))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/upload", "image/png", strings.NewReader("PNGDATA"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if !called {
		t.Error("an unnamed upload never reached the store")
	}
}

func TestUploadRefusalReachesTheClient(t *testing.T) {
	srv := httptest.NewServer(Handler(uploadOptions("", func(io.Reader, string) (string, error) {
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
	srv := httptest.NewServer(Handler(uploadOptions("secret", func(io.Reader, string) (string, error) {
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
	srv := httptest.NewServer(Handler(uploadOptions("", func(io.Reader, string) (string, error) {
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
	o.StartSession = func(preset, dir string) (err error) {
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
	o.StartSession = func(preset, dir string) error { started = preset; return nil }
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
	o.StartSession = func(string, string) error { called = true; return nil }
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

// The endpoint that ends processes had no test at all until 2026-08-27, while
// the two beside it — rename and new — have had one each from the start. These
// are its scenarios, one per refusal, because every one of them is a way for a
// name to reach a tmux command line that closes things.

func TestKillOnlyTouchesAListedSession(t *testing.T) {
	called := ""
	o := testOptions("")
	o.KillSession = func(name string) error { called = name; return nil }
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	// testOptions lists exactly one session, "demo".
	resp, err := http.Post(srv.URL+"/api/sessions/kill", "application/json",
		strings.NewReader(`{"name":"not-listed"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status %d, want 404", resp.StatusCode)
	}
	if called != "" {
		t.Errorf("a name the server does not list reached tmux: %q", called)
	}
}

// A page cannot close another page's client session. The list it is shown never
// has one in it, so this is a second lock on the same door — closing a client
// out from under a page drops its socket with nothing anywhere saying why, and
// what the owner means by closing a tab is the session, which takes its clients
// with it.
func TestKillRefusesAClientSession(t *testing.T) {
	called := ""
	o := testOptions("")
	o.ListSessions = func() ([]tmuxcmd.Session, error) {
		return []tmuxcmd.Session{
			{Name: "demo", Windows: 1},
			{Name: tmuxcmd.ClientName(4), Windows: 1, Group: "demo"},
		}, nil
	}
	o.KillSession = func(name string) error { called = name; return nil }
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/sessions/kill", "application/json",
		strings.NewReader(`{"name":"`+tmuxcmd.ClientName(4)+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status %d, want 404", resp.StatusCode)
	}
	if called != "" {
		t.Errorf("a client session reached tmux: %q", called)
	}
}

func TestKillWorks(t *testing.T) {
	called := ""
	o := testOptions("")
	o.KillSession = func(name string) error { called = name; return nil }
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/sessions/kill", "application/json",
		strings.NewReader(`{"name":"demo"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if called != "demo" {
		t.Errorf("closed %q", called)
	}
}

// The refusal is the toast: there is no log to open on a phone, so what tmux
// said has to travel back as the body rather than as a status alone.
func TestKillRefusalReachesThePage(t *testing.T) {
	o := testOptions("")
	o.KillSession = func(string) error { return errors.New("can't find session: demo") }
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/sessions/kill", "application/json",
		strings.NewReader(`{"name":"demo"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "can't find session") {
		t.Errorf("body %q says nothing about why", body)
	}
}

func TestKillNeedsTheToken(t *testing.T) {
	called := ""
	o := testOptions("secret")
	o.KillSession = func(name string) error { called = name; return nil }
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/sessions/kill", "application/json",
		strings.NewReader(`{"name":"demo"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized || called != "" {
		t.Fatalf("status %d, closed %q", resp.StatusCode, called)
	}
}

// With no way to close a session configured the endpoint is not there at all,
// rather than there and silently doing nothing.
func TestKillAbsentWhenNotWired(t *testing.T) {
	srv := httptest.NewServer(Handler(testOptions("")))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/sessions/kill", "application/json",
		strings.NewReader(`{"name":"demo"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status %d, want 404", resp.StatusCode)
	}
}

// A GET must not close anything: it is the method a link, a prefetch or a
// crawler uses, and this one ends processes.
func TestKillRejectsGet(t *testing.T) {
	called := ""
	o := testOptions("")
	o.KillSession = func(name string) error { called = name; return nil }
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/sessions/kill")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed || called != "" {
		t.Fatalf("status %d, closed %q", resp.StatusCode, called)
	}
}

func TestKillRefusesAnUnreadableRequest(t *testing.T) {
	called := ""
	o := testOptions("")
	o.KillSession = func(name string) error { called = name; return nil }
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/sessions/kill", "application/json",
		strings.NewReader(`{"name":`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest || called != "" {
		t.Fatalf("status %d, closed %q", resp.StatusCode, called)
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

	notices.Send(Notice{
		Type: "notify", Kind: "done", Session: "demo",
		Title: "✅ demo закончил", Body: "тесты зелёные",
	}, nil)

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
		n := len(notices.m)
		notices.mu.Unlock()
		if n == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the closed page is still registered")
		}
		time.Sleep(20 * time.Millisecond)
	}
	notices.Send(Notice{Type: "notify", Kind: "done", Session: "demo", Title: "x"}, nil)
}

func TestNoticeReachesAPageLookingAtAnotherSession(t *testing.T) {
	// The notification anyone actually waits for is about the session they are not
	// looking at, and that is the one that used to reach nobody: the frame went
	// only to pages attached to the session it was about, a phone has one socket,
	// and the watcher is silent about the session that socket has visible. With
	// Telegram off, "notify this page" delivered nothing at all — reported that
	// way, and this is the case that proves it fixed.
	opts := testOptions("")
	notices := NewNotices()
	opts.Notices = notices
	opts.ListSessions = func() ([]tmuxcmd.Session, error) {
		return []tmuxcmd.Session{{Name: "demo", Windows: 1}, {Name: "natal", Windows: 1}}, nil
	}
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	readBinaryUntil(t, c, "ready")

	notices.Send(Notice{
		Type: "notify", Kind: "question", Session: "natal",
		Title: "❓ natal просит ответ", Body: "Apply this change?",
	}, nil)

	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		mt, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("waiting for a notice about the other session: %v", err)
		}
		if mt != websocket.TextMessage {
			continue
		}
		var f Notice
		if err := json.Unmarshal(data, &f); err != nil || f.Type != "notify" {
			continue
		}
		// It names the session it is about, which is what a tap on it needs: the
		// page is showing another one, and the notice is the way to this one.
		if f.Session != "natal" || f.Kind != "question" {
			t.Fatalf("frame arrived mangled: %+v", f)
		}
		return
	}
}

func TestOnlyThePageShowingTheSessionIsSkipped(t *testing.T) {
	// The exception is per page. "Somebody has it on screen" was decided once for
	// everybody upstream, and with two devices in the house that is a rule that
	// silences the wrong one: a phone open on `demo` was told nothing about `natal`
	// because the laptop had `natal` visible.
	notices := NewNotices()
	got := make(map[int64]int)
	var mu sync.Mutex
	for _, id := range []int64{1, 2} {
		client := id
		notices.add(client, func(Notice) {
			mu.Lock()
			got[client]++
			mu.Unlock()
		})
	}

	// Client 1 is the page showing `natal`; client 2 is looking at something else.
	sent, skipped := notices.Send(
		Notice{Type: "notify", Kind: "done", Session: "natal", Title: "✅ natal закончил"},
		func(id int64) bool { return id == 1 },
	)
	if sent != 1 || skipped != 1 {
		t.Fatalf("sent %d, skipped %d, want one of each", sent, skipped)
	}
	mu.Lock()
	defer mu.Unlock()
	if got[1] != 0 {
		t.Errorf("the page showing the session got %d notices", got[1])
	}
	if got[2] != 1 {
		t.Errorf("the page showing something else got %d notices, want one", got[2])
	}
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

// --- the notification switch ----------------------------------------------

func notifyOptions(mode string, telegram bool) (Options, *string) {
	stored := mode
	o := testOptions("")
	o.NotifyMode = func() (string, bool) { return stored, telegram }
	o.SetNotifyMode = func(m string) error {
		switch m {
		case "off", "pwa", "pwa+tg":
			stored = m
			return nil
		}
		return fmt.Errorf("unknown notification mode %q", m)
	}
	return o, &stored
}

func TestNotifyModeIsReadAndSet(t *testing.T) {
	// One switch for both channels, and it lives here: half of what it controls
	// is Telegram, which is sent from this host to a phone with nothing open.
	opts, stored := notifyOptions("pwa+tg", true)
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/api/notify")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var got struct {
		Mode     string `json:"mode"`
		Telegram bool   `json:"telegram"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Mode != "pwa+tg" || !got.Telegram {
		t.Fatalf("GET = %+v", got)
	}

	post, err := http.Post(srv.URL+"/api/notify", "application/json", strings.NewReader(`{"mode":"off"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer post.Body.Close()
	if post.StatusCode != http.StatusOK {
		t.Fatalf("POST status %d", post.StatusCode)
	}
	// The answer is the state after the change, so the button never has to
	// assume its tap landed.
	var after struct {
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(post.Body).Decode(&after); err != nil {
		t.Fatal(err)
	}
	if after.Mode != "off" || *stored != "off" {
		t.Fatalf("after POST: answered %q, stored %q", after.Mode, *stored)
	}
}

func TestNotifyModeRefusesWhatItDoesNotKnow(t *testing.T) {
	opts, stored := notifyOptions("pwa", true)
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	for _, body := range []string{`{"mode":"everything"}`, `not json`, `{}`} {
		res, err := http.Post(srv.URL+"/api/notify", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("POST %s: status %d, want 400", body, res.StatusCode)
		}
	}
	if *stored != "pwa" {
		t.Fatalf("a refused mode changed the state to %q", *stored)
	}
}

func TestNotifyModeNeedsTheToken(t *testing.T) {
	opts, _ := notifyOptions("pwa", true)
	opts.Token = "secret"
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/api/notify")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", res.StatusCode)
	}
}

func TestNotifyModeAbsentWhenNotTracked(t *testing.T) {
	// A deployment that does not carry the switch answers 404 rather than a
	// default: the page then leaves its own button alone instead of showing a
	// state nothing obeys.
	srv := testServer(t, "")
	res, err := http.Get(srv.URL + "/api/notify")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("status %d, want 404", res.StatusCode)
	}
}

func TestConfigFrameCarriesTheNotificationMode(t *testing.T) {
	// The button has to be right the moment it is drawn. Asking over HTTP after
	// the socket is up would show the wrong state for as long as that took, and
	// on a phone over a tunnel that is visible.
	opts, _ := notifyOptions("off", true)
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
			Type     string `json:"type"`
			Notify   string `json:"notify"`
			Telegram bool   `json:"telegram"`
		}
		if err := json.Unmarshal(data, &f); err != nil || f.Type != "config" {
			continue
		}
		if f.Notify != "off" || !f.Telegram {
			t.Fatalf("config = %+v, want notify off and telegram true", f)
		}
		return
	}
}

// --- folders under the projects root -------------------------------------

func TestDirsListsTheProjectsRoot(t *testing.T) {
	// The drawer shows these as rows to tap. The root travels with them because
	// it is one of the choices: a session in ~/work itself is as ordinary as one
	// in a project, and its tab is named after that folder too.
	o := testOptions("")
	o.Folders = func() (string, []string, error) { return "work", []string{"natal", "pockterm"}, nil }
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/api/dirs")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var got struct {
		Root string   `json:"root"`
		Dirs []string `json:"dirs"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Root != "work" || strings.Join(got.Dirs, ",") != "natal,pockterm" {
		t.Fatalf("dirs = %+v", got)
	}
}

func TestDirsReportsWhyItCannotList(t *testing.T) {
	// An unreadable root has to show as a message: an empty list would read as
	// "no projects", which is a different fact and a wrong one.
	o := testOptions("")
	o.Folders = func() (string, []string, error) { return "", nil, errors.New("cannot read the projects root") }
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/api/dirs")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", res.StatusCode)
	}
	if body, _ := io.ReadAll(res.Body); !strings.Contains(string(body), "projects root") {
		t.Fatalf("the reason did not reach the page: %q", body)
	}
}

func TestDirsAbsentWhenNotListed(t *testing.T) {
	srv := testServer(t, "")
	res, err := http.Get(srv.URL + "/api/dirs")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("status %d, want 404", res.StatusCode)
	}
}

func TestDirsNeedsTheToken(t *testing.T) {
	o := testOptions("secret")
	o.Folders = func() (string, []string, error) { return "work", []string{"natal"}, nil }
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/api/dirs")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", res.StatusCode)
	}
}

func TestNewSessionCarriesTheFolder(t *testing.T) {
	var gotPreset, gotDir string
	o := testOptions("")
	o.StartSession = func(preset, dir string) error { gotPreset, gotDir = preset, dir; return nil }
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/sessions/new", "application/json",
		strings.NewReader(`{"preset":"claude","dir":"natal"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if gotPreset != "claude" || gotDir != "natal" {
		t.Fatalf("starter saw preset %q dir %q", gotPreset, gotDir)
	}
}

func TestNewSessionWithoutAFolderIsWhatItAlwaysWas(t *testing.T) {
	// The + that was there before folders existed sends no dir, and that has to
	// keep meaning the root — a page cached from an older version still taps it.
	seen := "unset"
	o := testOptions("")
	o.StartSession = func(preset, dir string) error { seen = dir; return nil }
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/sessions/new", "application/json", strings.NewReader(`{"preset":"shell"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent || seen != "" {
		t.Fatalf("status %d, dir %q", resp.StatusCode, seen)
	}
}

func TestNewSessionRefusalAboutAFolderReachesThePage(t *testing.T) {
	o := testOptions("")
	o.StartSession = func(preset, dir string) error {
		return errors.New(`no folder "gone" in the projects root`)
	}
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/sessions/new", "application/json",
		strings.NewReader(`{"preset":"claude","dir":"gone"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "gone") {
		t.Fatalf("the reason did not reach the page: %q", body)
	}
}

func TestSessionListCarriesWhatEachSessionIsDoing(t *testing.T) {
	// The tab strip paints itself from this: purple while a session works, green
	// once it has finished. Two facts about one session must arrive together —
	// fetched separately, a name and its state can disagree, and the
	// disagreement shows as the wrong tab lit up.
	opts := testOptions("")
	opts.Presence = &fakePresence{activity: map[string]string{"demo": "working"}}
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/api/sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var got []map[string]any
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0]["state"] != "working" {
		t.Fatalf("sessions = %v", got)
	}
}

func TestSessionListCarriesWhichButtonStartedIt(t *testing.T) {
	// The drawer names the button in the row and the tab draws its glyph, and both
	// read this one list — the same reason the activity rides in it. tmux is where
	// the fact is kept, so the server passes it on rather than holding a register
	// of its own that a rename or a restart could put out of step.
	opts := testOptions("")
	opts.ListSessions = func() ([]tmuxcmd.Session, error) {
		return []tmuxcmd.Session{
			{Name: "natal", Windows: 1, Kind: "yolo"},
			{Name: "qwen", Windows: 1, Kind: "custom:b2"},
			// Nobody stamped this one, and the page says nothing about it rather
			// than guessing — the same rule as an unknown activity.
			{Name: "old", Windows: 1},
		}, nil
	}
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/api/sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var got []map[string]any
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("sessions = %v", got)
	}
	if got[0]["kind"] != "yolo" || got[1]["kind"] != "custom:b2" {
		t.Fatalf("the kind did not travel: %v", got)
	}
	if _, ok := got[2]["kind"]; ok {
		t.Fatalf("an untyped session claimed a kind: %v", got[2])
	}
}

func TestCustomButtonsAreReadAndReplacedWhole(t *testing.T) {
	// The page holds the list while it is being edited, so it saves the list —
	// not an add and a remove that could leave the two disagreeing about what
	// exists. The answer is what the host now has, which is what the drawer draws.
	store := session.LoadButtons("")
	o := testOptions("")
	o.Buttons = store.List
	o.SetButtons = store.Set
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/api/presets")
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Buttons []session.Custom `json:"buttons"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	// A fresh host has the four defaults: they are entries in this same list now,
	// which is what makes them editable at all.
	if len(got.Buttons) != len(session.DefaultButtons()) {
		t.Fatalf("a fresh host does not have the defaults: %+v", got.Buttons)
	}

	resp, err := http.Post(srv.URL+"/api/presets", "application/json",
		strings.NewReader(`{"buttons":[{"label":"Qwen","cmd":"qwen"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if len(got.Buttons) != 1 || got.Buttons[0].Cmd != "qwen" || got.Buttons[0].ID == "" {
		t.Fatalf("saved = %+v", got.Buttons)
	}
	if stored := store.List(); len(stored) != 1 || stored[0].ID != got.Buttons[0].ID {
		t.Fatalf("the store and the answer disagree: %+v vs %+v", stored, got.Buttons)
	}
}

func TestCustomButtonRefusalSaysWhy(t *testing.T) {
	// On a phone a refusal that does not say which button and why is a dead end:
	// there is no log to open and nothing to try next.
	store := session.LoadButtons("")
	o := testOptions("")
	o.Buttons = store.List
	o.SetButtons = store.Set
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/presets", "application/json",
		strings.NewReader(`{"buttons":[{"label":"evil","cmd":"qwen; rm -rf /"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "quotes") {
		t.Fatalf("the reason did not reach the page: %q", body)
	}
	if got := store.List(); len(got) != len(session.DefaultButtons()) {
		t.Fatalf("the refused list replaced what was there: %+v", got)
	}
}

func TestResetPutsTheDefaultButtonsBack(t *testing.T) {
	// The defaults are the host's list, so restoring them is a flag rather than a
	// list the page sends: a page old enough to hold different ones would
	// otherwise install them quietly.
	store := session.LoadButtons("")
	o := testOptions("")
	o.Buttons = store.List
	o.SetButtons = store.Set
	o.ResetButtons = store.Reset
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	if _, err := store.Set([]session.Custom{{Label: "Qwen", Cmd: "qwen"}}); err != nil {
		t.Fatal(err)
	}
	resp, err := http.Post(srv.URL+"/api/presets", "application/json", strings.NewReader(`{"reset":true}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got struct {
		Buttons []session.Custom `json:"buttons"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got.Buttons) != len(session.DefaultButtons())+1 {
		t.Fatalf("reset answered %+v", got.Buttons)
	}
	if got.Buttons[0].ID != "shell" || got.Buttons[len(got.Buttons)-1].Cmd != "qwen" {
		t.Fatalf("reset answered %+v", got.Buttons)
	}
}

func TestCustomButtonsAbsentWithoutAStore(t *testing.T) {
	// A host without them says so with a 404 rather than an empty list: the page
	// then knows not to offer an editor that could never save anything.
	srv := testServer(t, "")
	res, err := http.Get(srv.URL + "/api/presets")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d", res.StatusCode)
	}
}

func TestSessionListCarriesBackgroundWork(t *testing.T) {
	// A session can be quiet and still have shells and monitors running, and the
	// tab says so with a badge. Same list as the colour: one fetch, one answer.
	opts := testOptions("")
	opts.Presence = &fakePresence{
		activity:   map[string]string{"demo": "done"},
		background: map[string][3]int{"demo": {1, 2, 3}},
	}
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/api/sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var got []map[string]any
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0]["shells"] != float64(1) || got[0]["monitors"] != float64(2) {
		t.Fatalf("sessions = %v", got)
	}
	// And the subagents the session lists, which the tab draws a head each for.
	if got[0]["agents"] != float64(3) {
		t.Fatalf("agents = %v, want 3 — sessions = %v", got[0]["agents"], got)
	}
}

func TestSessionListLeavesOutBackgroundWhenThereIsNone(t *testing.T) {
	// Nothing running is the common case, and it says nothing rather than
	// sending two zeroes the page would have to know to ignore.
	opts := testOptions("")
	opts.Presence = &fakePresence{activity: map[string]string{"demo": "done"}}
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/api/sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var got []map[string]any
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if _, ok := got[0]["shells"]; ok {
		t.Fatalf("a count appeared with nothing running: %v", got[0])
	}
	if _, ok := got[0]["monitors"]; ok {
		t.Fatalf("a count appeared with nothing running: %v", got[0])
	}
}

func TestSessionListSaysNothingWhenThereIsNoWatcher(t *testing.T) {
	// A deployment without the watcher leaves the field out rather than sending
	// a state it made up; the page then paints every tab neutral.
	srv := testServer(t, "")
	res, err := http.Get(srv.URL + "/api/sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var got []map[string]any
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("sessions = %v", got)
	}
	if _, ok := got[0]["state"]; ok {
		t.Fatalf("a state appeared without a watcher: %v", got[0])
	}
}

func TestTheSizeTheClientAsksForIsTheSizeItAttachesAt(t *testing.T) {
	// A client attached at the wrong size does not only look wrong to itself.
	// Sessions here are grouped, tmux gives the shared window the newest client's
	// size, and 80x24 for one moment is 80 columns for the laptop and every other
	// tab on that session — halves of two lines in one row, twice reported from
	// the phone.
	for _, c := range []struct {
		query      string
		cols, rows uint16
		why        string
	}{
		{"cols=51&rows=44", 51, 44, "a phone"},
		{"cols=172&rows=52", 172, 52, "a laptop"},
		{"", 80, 24, "a client that says nothing keeps the classic default"},
		{"cols=0&rows=0", 80, 24, "a size nothing can be drawn in"},
		{"cols=-4&rows=nine", 80, 24, "nonsense in a query string"},
		{"cols=60000&rows=60000", 80, 24, "a grid this will not allocate"},
	} {
		r := httptest.NewRequest("GET", "/ws?"+c.query, nil)
		cols, rows := requestedSize(r)
		if cols != c.cols || rows != c.rows {
			t.Errorf("%q (%s) = %dx%d, want %dx%d", c.query, c.why, cols, rows, c.cols, c.rows)
		}
	}
}

func TestTheStripKeepsTheOrderItWasDraggedInto(t *testing.T) {
	// tmux sorts its list by name, which is the one order nobody chose. The order
	// the owner dragged the tabs into is a session option, so it is applied where
	// the list is served — the drawer and the strip read the same list, and they
	// must not disagree about it.
	o := testOptions("")
	o.ListSessions = func() ([]tmuxcmd.Session, error) {
		return []tmuxcmd.Session{
			{Name: "aaa"},
			{Name: "work", Order: 2},
			{Name: "devops", Order: 1},
		}, nil
	}
	var got []string
	o.OrderSessions = func(names []string) error { got = names; return nil }
	srv := httptest.NewServer(Handler(o))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/api/sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var list []tmuxcmd.Session
	if err := json.NewDecoder(res.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	names := []string{list[0].Name, list[1].Name, list[2].Name}
	if names[0] != "devops" || names[1] != "work" || names[2] != "aaa" {
		t.Fatalf("order = %v, want the placed ones first", names)
	}

	// And the page hands back the row it drew, by name.
	resp, err := http.Post(srv.URL+"/api/sessions/order", "application/json",
		strings.NewReader(`{"names":["work","devops"]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if len(got) != 2 || got[0] != "work" {
		t.Fatalf("the order did not reach the host: %v", got)
	}
}

func TestOrderingIsAbsentWithoutIt(t *testing.T) {
	// A host that cannot reorder says so, and the page then leaves the gesture off
	// rather than pretending a drag was saved.
	srv := testServer(t, "")
	resp, err := http.Post(srv.URL+"/api/sessions/order", "application/json",
		strings.NewReader(`{"names":["a"]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d", resp.StatusCode)
	}
}

// The Origin check, and the one thing that was missing from it: a reason.
//
// A socket refused on origin looks exactly like a network problem from the page —
// the terminal shows "reconnecting…" for ever and nothing anywhere says which of
// the two it is. That cost half an hour on 2026-08-10: the page loaded, the
// sessions listed, every socket answered 403, and the journal was silent. The
// cause was in front of the server rather than in it — nginx's `$host` drops the
// port, so a page served on :8443 sent an Origin carrying it and a Host without
// — but a server that cannot say what it refused makes the proxy indistinguishable
// from the network.
func TestOriginOK(t *testing.T) {
	cases := []struct {
		name, origin, host string
		want               bool
	}{
		// Non-browser clients send no Origin at all, and they are not the threat
		// this check exists for.
		{"no origin", "", "cc.example", true},
		{"same host", "https://cc.example", "cc.example", true},
		{"same host and port", "https://cc.example:8443", "cc.example:8443", true},
		// The one that mattered: strictly speaking a different host, and behind a
		// proxy that drops the port it is the *only* shape a legitimate page has.
		{"port only on the origin", "https://cc.example:8443", "cc.example", false},
		{"port only on the host", "https://cc.example", "cc.example:8443", false},
		{"a foreign page", "https://evil.example", "cc.example", false},
		{"junk", "://", "cc.example", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/ws?session=demo", nil)
			r.Host = c.host
			if c.origin != "" {
				r.Header.Set("Origin", c.origin)
			}
			if got := originOK(r); got != c.want {
				t.Fatalf("originOK(origin=%q, host=%q) = %v, want %v", c.origin, c.host, got, c.want)
			}
		})
	}
}

func TestWSRefusedOnOriginSaysWhatItRefused(t *testing.T) {
	var logged safeBuffer
	restore := captureLog(&logged)
	defer restore()

	srv := testServer(t, "")
	// A browser's own Origin, and a Host as a proxy on a non-standard port would
	// forward it. Dialed against the test server, so everything from the mux
	// inwards is the real path.
	// The host the dialer will send, with a different port on the Origin — which
	// is exactly the shape a proxy that drops the port produces. Built rather than
	// concatenated: "https://" + addr + ":8443" is not a URL with a different
	// port, it is a broken URL, and a test that refuses one of those proves
	// nothing about this check.
	host, _, err := net.SplitHostPort(srv.Listener.Addr().String())
	if err != nil {
		t.Fatalf("cannot read the test server's address: %v", err)
	}
	h := http.Header{}
	h.Set("Origin", "https://"+net.JoinHostPort(host, "8443"))
	_, resp, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo"), h)
	if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for a mismatched origin, got err=%v resp=%v", err, resp)
	}

	line := logged.String()
	if !strings.Contains(line, "ws refused") {
		t.Fatalf("the journal says nothing about the refusal: %q", line)
	}
	// Both values, because the pair is the diagnosis: which of them carries the
	// port says whether the proxy or the page is wrong.
	if !strings.Contains(line, ":8443") {
		t.Fatalf("the line does not name the origin it refused: %q", line)
	}
	if !strings.Contains(line, "proxy") {
		t.Fatalf("the line does not point at the usual cause: %q", line)
	}
}

func TestWSAcceptsAnOriginThatMatches(t *testing.T) {
	// The other half: the check must not be a wall. Same server, Origin equal to
	// the Host the dialer sends, and the socket opens.
	srv := testServer(t, "")
	h := http.Header{}
	h.Set("Origin", "http://"+srv.Listener.Addr().String())
	c, resp, err := websocket.DefaultDialer.Dial(wsURL(srv, "?session=demo"), h)
	if err != nil {
		t.Fatalf("a matching origin was refused: err=%v resp=%v", err, resp)
	}
	defer c.Close()
	readBinaryUntil(t, c, "ready")
}

// --- Web Push -------------------------------------------------------------
//
// The endpoints exist because a suspended page cannot be reached down its own
// socket: Android stops it answering, the socket is closed a minute later, and
// what was written into it is counted as delivered and drawn nowhere. What is
// checked here is the handing-over, not the encryption — internal/push covers
// that against the RFC's own vectors.

func TestPushHandsOutTheKeyAndTakesTheSubscription(t *testing.T) {
	opts := testOptions("")
	var stored push.Subscription
	opts.PushKey = func() string { return "BKey" }
	opts.Subscribe = func(sub push.Subscription) error { stored = sub; return nil }
	opts.PushDevices = func(endpoint string) (bool, int) {
		return endpoint == stored.Endpoint && endpoint != "", 1
	}
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/api/push")
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Key     string `json:"key"`
		Here    bool   `json:"here"`
		Devices int    `json:"devices"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if got.Key != "BKey" {
		t.Fatalf("key = %q — without it no browser can subscribe at all", got.Key)
	}

	body := `{"subscription":{"endpoint":"https://push.example.net/abc","keys":{"p256dh":"BQ","auth":"AA"}},"device":"phone"}`
	res, err = http.Post(srv.URL+"/api/push", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("subscribe answered %d", res.StatusCode)
	}
	if stored.Endpoint != "https://push.example.net/abc" || stored.Keys.P256dh != "BQ" {
		t.Fatalf("the subscription did not arrive whole: %+v", stored)
	}
	if stored.Device != "phone" {
		t.Fatalf("device = %q — without it one phone becomes five subscriptions", stored.Device)
	}
}

func TestAHostWithoutPushSaysSoRatherThanFailing(t *testing.T) {
	// The page has to tell "push is off here" from "push is broken here": the
	// first means keep drawing notices from the frame, the second means somebody
	// should look at the journal.
	opts := testOptions("")
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()
	res, err := http.Get(srv.URL + "/api/push")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", res.StatusCode)
	}
}

func TestUnsubscribeForgetsOneEndpoint(t *testing.T) {
	opts := testOptions("")
	opts.PushKey = func() string { return "BKey" }
	gone := ""
	opts.Unsubscribe = func(endpoint string) error { gone = endpoint; return nil }
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	res, err := http.Post(srv.URL+"/api/push/off", "application/json",
		strings.NewReader(`{"endpoint":"https://push.example.net/abc"}`))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if gone != "https://push.example.net/abc" {
		t.Fatalf("forgot %q", gone)
	}
}

func TestTheProbeIsDelayedAndBounded(t *testing.T) {
	// Delayed on purpose: the failure it tests happens while the app is off
	// screen, so a probe raised while the settings panel is open proves nothing.
	// Bounded because the delay comes from a page, and a page can be older than
	// this binary or simply wrong.
	opts := testOptions("")
	opts.PushKey = func() string { return "BKey" }
	var asked []time.Duration
	opts.PushTest = func(d time.Duration) error { asked = append(asked, d); return nil }
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	for _, tc := range []struct {
		send string
		want time.Duration
	}{
		{`{"delay":10}`, 10 * time.Second},
		{`{"delay":-5}`, 0},
		{`{"delay":9000}`, 60 * time.Second},
		{``, 0},
	} {
		res, err := http.Post(srv.URL+"/api/push/test", "application/json", strings.NewReader(tc.send))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusAccepted {
			t.Fatalf("%s: status = %d", tc.send, res.StatusCode)
		}
	}
	want := []time.Duration{10 * time.Second, 0, 60 * time.Second, 0}
	if len(asked) != len(want) {
		t.Fatalf("asked = %v", asked)
	}
	for i := range want {
		if asked[i] != want[i] {
			t.Fatalf("delay %d = %s, want %s", i, asked[i], want[i])
		}
	}
}

func TestPushEndpointsWantTheToken(t *testing.T) {
	// Everything else behind the token is, and a subscription is somebody else's
	// phone: an unauthenticated POST here would let a stranger have this server
	// notify a device of their choosing.
	opts := testOptions("secret")
	opts.PushKey = func() string { return "BKey" }
	opts.Subscribe = func(push.Subscription) error { return nil }
	opts.PushTest = func(time.Duration) error { return nil }
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()

	for _, path := range []string{"/api/push", "/api/push/off", "/api/push/test"} {
		res, err := http.Post(srv.URL+path, "application/json", strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s answered %d without a token", path, res.StatusCode)
		}
	}
}
