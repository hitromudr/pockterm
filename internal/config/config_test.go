package config

import "testing"

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

func TestInvalidListenRejected(t *testing.T) {
	_, err := FromEnv(env(map[string]string{"POCKTERM_LISTEN": "no-port"}))
	if err == nil {
		t.Fatal("expected error for listen without port")
	}
}
