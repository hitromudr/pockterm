package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/hitromudr/pockterm/internal/tmuxcmd"
)

type peersAnswer struct {
	Self  string `json:"self"`
	Hosts []Peer `json:"hosts"`
}

func getPeers(t *testing.T, opts Options) peersAnswer {
	t.Helper()
	srv := httptest.NewServer(Handler(opts))
	defer srv.Close()
	res, err := http.Get(srv.URL + "/api/peers")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type %q", ct)
	}
	var a peersAnswer
	if err := json.NewDecoder(res.Body).Decode(&a); err != nil {
		t.Fatal(err)
	}
	return a
}

func TestPeersWithoutAListIsThisHostAlone(t *testing.T) {
	opts := testOptions("")
	opts.HostName = "rpi5"
	opts.DirectURL = "https://lan.example:8135"
	got := getPeers(t, opts)
	want := peersAnswer{Self: "rpi5", Hosts: []Peer{{Name: "rpi5", Direct: "https://lan.example:8135"}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestPeersKeepTheListAndItsOrder(t *testing.T) {
	opts := testOptions("")
	opts.HostName = "ser8"
	opts.DirectURL = "https://lan8.example:8135"
	opts.Peers = []Peer{
		{Name: "rpi5", URL: "https://cc.example", Direct: "https://lan.example:8135"},
		// This host's own entry without a door takes the one it was configured with.
		{Name: "ser8", URL: "https://cc.example:8446"},
	}
	got := getPeers(t, opts)
	want := peersAnswer{Self: "ser8", Hosts: []Peer{
		{Name: "rpi5", URL: "https://cc.example", Direct: "https://lan.example:8135"},
		{Name: "ser8", URL: "https://cc.example:8446", Direct: "https://lan8.example:8135"},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	// The answer is built from a copy: the configured list is not rewritten.
	if opts.Peers[1].Direct != "" {
		t.Fatalf("configured peers modified: %+v", opts.Peers)
	}
}

func TestPeersPutThisHostFirstWhenUnlisted(t *testing.T) {
	opts := testOptions("")
	opts.HostName = "rpi5"
	opts.Peers = []Peer{{Name: "ser8", URL: "https://cc.example:8446"}}
	got := getPeers(t, opts)
	want := peersAnswer{Self: "rpi5", Hosts: []Peer{
		{Name: "rpi5"},
		{Name: "ser8", URL: "https://cc.example:8446"},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestPeersNeedTheToken(t *testing.T) {
	srv := testServer(t, "s3cret")
	res, err := http.Get(srv.URL + "/api/peers")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", res.StatusCode)
	}
	res, err = http.Get(srv.URL + "/api/peers?token=s3cret")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d with the token, want 200", res.StatusCode)
	}
}

// corsServer is a host whose page lives at a trusted origin elsewhere, with a
// session list and a kill that records what it was asked.
func corsServer(t *testing.T, killed *[]string) *httptest.Server {
	t.Helper()
	opts := testOptions("")
	opts.TrustedOrigins = []string{"https://cc.example"}
	opts.ListSessions = func() ([]tmuxcmd.Session, error) {
		return []tmuxcmd.Session{{Name: "demo", Windows: 1}}, nil
	}
	opts.KillSession = func(name string) error {
		*killed = append(*killed, name)
		return nil
	}
	srv := httptest.NewServer(Handler(opts))
	t.Cleanup(srv.Close)
	return srv
}

func do(t *testing.T, method, url, origin, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if body != "" {
		// What the page sends across origins: a simple request, no preflight.
		req.Header.Set("Content-Type", "text/plain;charset=UTF-8")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res
}

func TestCORSForATrustedPage(t *testing.T) {
	var killed []string
	srv := corsServer(t, &killed)

	res := do(t, http.MethodGet, srv.URL+"/api/sessions", "https://cc.example", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET status %d", res.StatusCode)
	}
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "https://cc.example" {
		t.Fatalf("Allow-Origin %q, want the page's own origin", got)
	}
	if got := res.Header.Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("Allow-Credentials %q, want true", got)
	}
	if got := res.Header.Values("Vary"); !reflect.DeepEqual(got, []string{"Origin"}) {
		t.Fatalf("Vary %q, want [Origin]", got)
	}

	res = do(t, http.MethodPost, srv.URL+"/api/sessions/kill", "https://cc.example", `{"name":"demo"}`)
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("POST status %d, want 204", res.StatusCode)
	}
	if !reflect.DeepEqual(killed, []string{"demo"}) {
		t.Fatalf("killed %q, want [demo]", killed)
	}
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "https://cc.example" {
		t.Fatalf("POST Allow-Origin %q", got)
	}
}

func TestCORSPreflightForATrustedPage(t *testing.T) {
	var killed []string
	srv := corsServer(t, &killed)
	req, _ := http.NewRequest(http.MethodOptions, srv.URL+"/api/upload", nil)
	req.Header.Set("Origin", "https://cc.example")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "content-type")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("status %d, want 204", res.StatusCode)
	}
	want := map[string]string{
		"Access-Control-Allow-Origin":      "https://cc.example",
		"Access-Control-Allow-Credentials": "true",
		"Access-Control-Allow-Methods":     "GET, POST",
		"Access-Control-Allow-Headers":     "Content-Type",
		"Access-Control-Max-Age":           "600",
	}
	for k, v := range want {
		if got := res.Header.Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
}

func TestCORSRefusesAForeignPageAnyChange(t *testing.T) {
	var killed []string
	srv := corsServer(t, &killed)

	res := do(t, http.MethodPost, srv.URL+"/api/sessions/kill", "https://evil.example", `{"name":"demo"}`)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("POST from a foreign page: status %d, want 403", res.StatusCode)
	}
	if killed != nil {
		t.Fatalf("a foreign page closed %q", killed)
	}
	// A trusted origin on another port is another origin.
	res = do(t, http.MethodPost, srv.URL+"/api/sessions/kill", "https://cc.example:8446", `{"name":"demo"}`)
	if res.StatusCode != http.StatusForbidden || killed != nil {
		t.Fatalf("POST from another port: status %d, killed %q", res.StatusCode, killed)
	}

	// A GET is served as before, without anything that would let the page read it.
	res = do(t, http.MethodGet, srv.URL+"/api/sessions", "https://evil.example", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET from a foreign page: status %d, want 200", res.StatusCode)
	}
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Allow-Origin %q for a foreign page", got)
	}
	res = do(t, http.MethodOptions, srv.URL+"/api/sessions/kill", "https://evil.example", "")
	if res.StatusCode != http.StatusForbidden || res.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("preflight from a foreign page: status %d, Allow-Origin %q",
			res.StatusCode, res.Header.Get("Access-Control-Allow-Origin"))
	}
}

func TestCORSLeavesTheHostsOwnPageAlone(t *testing.T) {
	var killed []string
	srv := corsServer(t, &killed)
	// The page this host served: Origin is the host it asks on.
	res := do(t, http.MethodPost, srv.URL+"/api/sessions/kill", srv.URL, `{"name":"demo"}`)
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("own page: status %d, want 204", res.StatusCode)
	}
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("own page got Allow-Origin %q, nothing is needed", got)
	}
	// And a client that sends no Origin at all (curl, the deploy script).
	res = do(t, http.MethodPost, srv.URL+"/api/sessions/kill", "", `{"name":"demo"}`)
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("no Origin: status %d, want 204", res.StatusCode)
	}
	if !reflect.DeepEqual(killed, []string{"demo", "demo"}) {
		t.Fatalf("killed %q", killed)
	}
}
