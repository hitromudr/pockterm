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

func TestPendingFileDefaultsToWhereTheDeployScriptParks(t *testing.T) {
	c, err := FromEnv(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.PendingFile != "/var/lib/pockterm/incoming/pockterm.pending" {
		t.Fatalf("PendingFile = %q", c.PendingFile)
	}
	c, err = FromEnv(env(map[string]string{"POCKTERM_PENDING_FILE": "off"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.PendingFile != "off" {
		t.Fatalf("PendingFile = %q, want the switch to survive", c.PendingFile)
	}
}

func TestInvalidListenRejected(t *testing.T) {
	_, err := FromEnv(env(map[string]string{"POCKTERM_LISTEN": "no-port"}))
	if err == nil {
		t.Fatal("expected error for listen without port")
	}
}
