package config

import (
	"os"
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
