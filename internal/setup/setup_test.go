package setup

import (
	"strings"
	"testing"
)

func TestTokenIsRandomAndURLSafe(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 100; i++ {
		tok, err := Token()
		if err != nil {
			t.Fatal(err)
		}
		if len(tok) < 32 {
			t.Fatalf("token too short: %q", tok)
		}
		// The token travels in a query string and in a QR code; anything
		// needing escaping would break both.
		if strings.ContainsAny(tok, "+/=?&# ") {
			t.Fatalf("token needs escaping: %q", tok)
		}
		if seen[tok] {
			t.Fatalf("token repeated after %d draws: %q", i, tok)
		}
		seen[tok] = true
	}
}

func TestUnitRendersTheEssentials(t *testing.T) {
	u := Unit(UnitOptions{
		User:    "pi",
		Listen:  "127.0.0.1:8130",
		EnvFile: "/etc/pockterm/pockterm.env",
		Binary:  "/usr/local/bin/pockterm",
	})
	for _, want := range []string{
		"User=pi",
		"Environment=POCKTERM_LISTEN=127.0.0.1:8130",
		// The leading "-" keeps the unit starting when the file is absent.
		"EnvironmentFile=-/etc/pockterm/pockterm.env",
		"ExecStart=/usr/local/bin/pockterm",
		"WantedBy=multi-user.target",
	} {
		if !strings.Contains(u, want) {
			t.Errorf("unit is missing %q\n%s", want, u)
		}
	}
	// A token must never be baked into the unit: units are world-readable.
	if strings.Contains(u, "POCKTERM_TOKEN") {
		t.Errorf("unit carries the token instead of the env file:\n%s", u)
	}
}

func TestClientURL(t *testing.T) {
	cases := []struct {
		name, base, token, want string
	}{
		{"token appended", "https://cc.example", "abc", "https://cc.example/?token=abc"},
		{"trailing slash kept single", "https://cc.example/", "abc", "https://cc.example/?token=abc"},
		{"no token, no query", "https://cc.example", "", "https://cc.example/"},
		{"loopback for local use", "http://127.0.0.1:8130", "xyz", "http://127.0.0.1:8130/?token=xyz"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ClientURL(c.base, c.token); got != c.want {
				t.Fatalf("ClientURL(%q, %q) = %q, want %q", c.base, c.token, got, c.want)
			}
		})
	}
}

func TestQRContainsSomethingScannable(t *testing.T) {
	// The point of the QR is the phone, which cannot be tested here; what can
	// be checked is that a code is produced and is not a blank square.
	out, err := QR("https://cc.example/?token=abc")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) < 100 || !strings.Contains(out, "█") {
		t.Fatalf("does not look like a rendered QR code:\n%s", out)
	}
}

func TestQRRejectsEmptyURL(t *testing.T) {
	if _, err := QR(""); err == nil {
		t.Fatal("expected an error for an empty URL")
	}
}
