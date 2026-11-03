package config

import (
	"os"
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestDefaults(t *testing.T) {
	c, err := FromEnv(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Listen != "127.0.0.1:8130" || c.Token != "" {
		t.Fatalf("unexpected defaults: %+v", c)
	}
}

func TestOverrides(t *testing.T) {
	c, err := FromEnv(env(map[string]string{
		"POCKTERM_LISTEN": "127.0.0.1:9999",
		"POCKTERM_TOKEN":  "s3cret",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Listen != "127.0.0.1:9999" || c.Token != "s3cret" {
		t.Fatalf("unexpected config: %+v", c)
	}
}

func TestNonLoopbackWithoutTokenRefused(t *testing.T) {
	_, err := FromEnv(env(map[string]string{"POCKTERM_LISTEN": "0.0.0.0:8130"}))
	if err == nil {
		t.Fatal("expected error for non-loopback listen without token")
	}
}

func TestNonLoopbackWithTokenAllowed(t *testing.T) {
	_, err := FromEnv(env(map[string]string{
		"POCKTERM_LISTEN": "0.0.0.0:8130",
		"POCKTERM_TOKEN":  "s3cret",
	}))
	if err != nil {
		t.Fatal(err)
	}
}

func TestNotificationDefaults(t *testing.T) {
	c, err := FromEnv(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Notify() {
		t.Fatal("notifications must be off until a bot token is set")
	}
	if c.Idle != 30*time.Second {
		t.Fatalf("idle = %v, want 30s", c.Idle)
	}
	if !c.TGPreview {
		t.Fatal("preview is on unless switched off")
	}
}

func TestNotificationConfig(t *testing.T) {
	c, err := FromEnv(env(map[string]string{
		"POCKTERM_TG_TOKEN":   "42:abc",
		"POCKTERM_TG_CHAT":    "777",
		"POCKTERM_TG_LINK":    "https://cc.example",
		"POCKTERM_TG_PREVIEW": "off",
		"POCKTERM_IDLE":       "45s",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !c.Notify() || c.TGLink != "https://cc.example" || c.TGPreview || c.Idle != 45*time.Second {
		t.Fatalf("unexpected config: %+v", c)
	}
}

func TestHalfConfiguredNotificationsRefused(t *testing.T) {
	// A token without a chat id would fail at the first event, in a log
	// nobody reads. Fail at startup instead.
	if _, err := FromEnv(env(map[string]string{"POCKTERM_TG_TOKEN": "42:abc"})); err == nil {
		t.Fatal("expected an error for a token without a chat id")
	}
	if _, err := FromEnv(env(map[string]string{"POCKTERM_TG_CHAT": "777"})); err == nil {
		t.Fatal("expected an error for a chat id without a token")
	}
}

func TestInvalidIdleRejected(t *testing.T) {
	for _, bad := range []string{"soon", "-5s", "0"} {
		if _, err := FromEnv(env(map[string]string{"POCKTERM_IDLE": bad})); err == nil {
			t.Fatalf("expected an error for POCKTERM_IDLE=%q", bad)
		}
	}
}

func TestSessionDirFallsBackToTheWorkingDirectory(t *testing.T) {
	// No fixed path: a binary that looked in one absolute directory started
	// sessions on the machine it was written on and nowhere else.
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	c, err := FromEnv(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	dir, on, err := c.SessionDir()
	if err != nil {
		t.Fatal(err)
	}
	if !on || dir != wd {
		t.Fatalf("dir = %q, on = %v, want %q and on", dir, on, wd)
	}
}

func TestSessionDirHonoursTheVariable(t *testing.T) {
	c, err := FromEnv(env(map[string]string{"POCKTERM_SESSION_DIR": "/srv/work"}))
	if err != nil {
		t.Fatal(err)
	}
	dir, on, err := c.SessionDir()
	if err != nil {
		t.Fatal(err)
	}
	if !on || dir != "/srv/work" {
		t.Fatalf("dir = %q, on = %v", dir, on)
	}
}

func TestSessionDirOffRefusesToStart(t *testing.T) {
	c, err := FromEnv(env(map[string]string{"POCKTERM_SESSION_DIR": "off"}))
	if err != nil {
		t.Fatal(err)
	}
	dir, on, err := c.SessionDir()
	if err != nil {
		t.Fatal(err)
	}
	if on || dir != "" {
		t.Fatalf("dir = %q, on = %v, want the feature off", dir, on)
	}
}

func TestInvalidListenRejected(t *testing.T) {
	_, err := FromEnv(env(map[string]string{"POCKTERM_LISTEN": "no-port"}))
	if err == nil {
		t.Fatal("expected error for listen without port")
	}
}

// The direct door and the pages it trusts are compared as browsers write
// origins, so what is read is normalised to that and anything that could never
// match — a path, a trailing slash — is refused at start rather than left to
// turn the door off in silence.
func TestDirectDoorOrigins(t *testing.T) {
	c, err := FromEnv(env(map[string]string{
		"POCKTERM_DIRECT_URL":      "https://LAN.example:8135",
		"POCKTERM_TRUSTED_ORIGINS": " https://cc.example , ,http://127.0.0.1:8130",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.DirectURL != "https://lan.example:8135" {
		t.Fatalf("DirectURL = %q", c.DirectURL)
	}
	want := []string{"https://cc.example", "http://127.0.0.1:8130"}
	if len(c.TrustedOrigins) != len(want) || c.TrustedOrigins[0] != want[0] || c.TrustedOrigins[1] != want[1] {
		t.Fatalf("TrustedOrigins = %q, want %q", c.TrustedOrigins, want)
	}

	none, err := FromEnv(env(nil))
	if err != nil || none.DirectURL != "" || none.TrustedOrigins != nil {
		t.Fatalf("defaults: %+v, %v", none, err)
	}

	for _, bad := range []string{"https://cc.example/", "https://cc.example/ws", "cc.example", "wss://cc.example", "https://u@cc.example", "https://cc.example?x=1"} {
		if _, err := FromEnv(env(map[string]string{"POCKTERM_TRUSTED_ORIGINS": bad})); err == nil {
			t.Errorf("trusted origin %q accepted", bad)
		}
		if _, err := FromEnv(env(map[string]string{"POCKTERM_DIRECT_URL": bad})); err == nil {
			t.Errorf("direct URL %q accepted", bad)
		}
	}
}

func TestDoorListenIsLoopbackOnly(t *testing.T) {
	c, err := FromEnv(env(map[string]string{"POCKTERM_DOOR_LISTEN": "127.0.0.1:8131"}))
	if err != nil || c.DoorListen != "127.0.0.1:8131" {
		t.Fatalf("%+v, %v", c.DoorListen, err)
	}
	for _, bad := range []string{"0.0.0.0:8131", "192.168.1.222:8131", ":8131", "8131"} {
		if _, err := FromEnv(env(map[string]string{"POCKTERM_DOOR_LISTEN": bad})); err == nil {
			t.Errorf("door listener %q accepted", bad)
		}
	}
}

func TestPeersParsed(t *testing.T) {
	c, err := FromEnv(env(map[string]string{
		"POCKTERM_HOST_NAME": "rpi5",
		"POCKTERM_PEERS": " rpi5=https://cc.example|https://lan.example:8135 , " +
			"ser8=HTTPS://CC.example:8446|https://lan8.example:8135,box=https://cc.example/@box",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := []Peer{
		{Name: "rpi5", URL: "https://cc.example", Direct: "https://lan.example:8135"},
		{Name: "ser8", URL: "https://cc.example:8446", Direct: "https://lan8.example:8135"},
		{Name: "box", URL: "https://cc.example/@box", Direct: ""},
	}
	if len(c.Peers) != len(want) {
		t.Fatalf("Peers = %+v, want %+v", c.Peers, want)
	}
	for i := range want {
		if c.Peers[i] != want[i] {
			t.Fatalf("Peers[%d] = %+v, want %+v", i, c.Peers[i], want[i])
		}
	}
	if c.HostName != "rpi5" {
		t.Fatalf("HostName = %q, want rpi5", c.HostName)
	}
}

func TestNoPeersIsOneHost(t *testing.T) {
	c, err := FromEnv(env(map[string]string{"POCKTERM_HOST_NAME": "rpi5"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Peers != nil {
		t.Fatalf("Peers = %+v, want none", c.Peers)
	}
}

func TestPeersRefused(t *testing.T) {
	for _, v := range []string{
		"ser8",                                          // no URL
		"ser8=",                                         // empty URL
		"ser8=cc.example:8446",                          // no scheme
		"ser8=ftp://cc.example",                         // wrong scheme
		"ser8=https://cc.example/",                      // trailing slash
		"ser8=https://cc.example/@ser8/",                // trailing slash after a prefix
		"ser8=https://cc.example?x=1",                   // query
		"ser8=https://user@cc.example",                  // credentials
		"ser8=https://cc.example|https://lan/x",         // door with a path
		"ser8=https://cc.example|lan8.example",          // door without a scheme
		"ser8=https://a.example,ser8=https://b.example", // twice
		"ser 8=https://cc.example",                      // space in the name
		"ser@8=https://cc.example",                      // the page's separator
		"=https://cc.example",                           // no name
	} {
		if _, err := FromEnv(env(map[string]string{"POCKTERM_PEERS": v})); err == nil {
			t.Errorf("POCKTERM_PEERS=%q accepted, want refused", v)
		}
	}
}

func TestHostNameDefault(t *testing.T) {
	defer func(f func() (string, error)) { hostname = f }(hostname)
	for in, want := range map[string]string{
		"ser8":                       "ser8",
		"AI.local":                   "ai",
		"my host.example.org":        "my-host",
		"_weird":                     "weird",
		"abcdefghijklmnopqrstuvwxyz": "abcdefghijklmnopqrstuvwx",
		"…":                          "host",
	} {
		hostname = func() (string, error) { return in, nil }
		c, err := FromEnv(env(nil))
		if err != nil {
			t.Fatal(err)
		}
		if c.HostName != want {
			t.Errorf("hostname %q → HostName %q, want %q", in, c.HostName, want)
		}
	}
}

func TestHostNameRefused(t *testing.T) {
	for _, v := range []string{"a@b", "has space", "-lead", strings.Repeat("x", 25)} {
		if _, err := FromEnv(env(map[string]string{"POCKTERM_HOST_NAME": v})); err == nil {
			t.Errorf("POCKTERM_HOST_NAME=%q accepted, want refused", v)
		}
	}
}
