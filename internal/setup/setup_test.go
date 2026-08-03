package setup

import (
	"net"
	"os"
	"path/filepath"
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
		// Without it the unit runs in "/", and the session Makefile the "+"
		// button looks for by default would never be found.
		"WorkingDirectory=-~",
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

func TestIsWildcard(t *testing.T) {
	for _, listen := range []string{"0.0.0.0:8130", ":8130", "[::]:8130"} {
		if !IsWildcard(listen) {
			t.Errorf("%q is a wildcard address", listen)
		}
	}
	for _, listen := range []string{"127.0.0.1:8130", "192.168.1.5:8130", "[::1]:8130", "nonsense"} {
		if IsWildcard(listen) {
			t.Errorf("%q is not a wildcard address", listen)
		}
	}
}

func TestListenURL(t *testing.T) {
	cases := []struct {
		name, listen, host, want string
	}{
		// The wildcard is the case this exists for: "http://0.0.0.0:8130" is
		// what the phone cannot open.
		{"wildcard takes the given host", "0.0.0.0:8130", "192.168.1.5", "http://192.168.1.5:8130"},
		{"empty host is a wildcard too", ":8130", "192.168.1.5", "http://192.168.1.5:8130"},
		{"a real address is left alone", "127.0.0.1:8130", "192.168.1.5", "http://127.0.0.1:8130"},
		{"no host to substitute", "0.0.0.0:8130", "", "http://0.0.0.0:8130"},
		{"ipv6 literal keeps its brackets", "[::]:8130", "fd00::5", "http://[fd00::5]:8130"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ListenURL(c.listen, c.host); got != c.want {
				t.Fatalf("ListenURL(%q, %q) = %q, want %q", c.listen, c.host, got, c.want)
			}
		})
	}
}

func TestPickLAN(t *testing.T) {
	ips := func(list ...string) []net.IP {
		out := make([]net.IP, 0, len(list))
		for _, s := range list {
			out = append(out, net.ParseIP(s))
		}
		return out
	}

	// A host running docker and wireguard has several addresses; the one worth
	// printing is the private IPv4 a phone on the same Wi-Fi can reach.
	got, ok := PickLAN(ips("127.0.0.1", "172.17.0.1", "192.168.1.5"))
	if !ok || got.String() != "172.17.0.1" {
		t.Fatalf("picked %v (ok=%v), want the first private IPv4", got, ok)
	}

	got, ok = PickLAN(ips("127.0.0.1", "169.254.3.4", "203.0.113.7"))
	if !ok || got.String() != "203.0.113.7" {
		t.Fatalf("picked %v (ok=%v), want the global address when nothing is private", got, ok)
	}

	if _, ok := PickLAN(ips("127.0.0.1", "::1", "169.254.3.4")); ok {
		t.Fatal("loopback and link-local addresses reach nobody else")
	}

	if _, ok := PickLAN(nil); ok {
		t.Fatal("no addresses means no answer")
	}
}

func TestUpdateEnvFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pockterm.env")

	// A file that does not exist yet is the first-run case.
	if err := UpdateEnvFile(path, [][2]string{{"POCKTERM_TG_TOKEN", "42:abc"}}); err != nil {
		t.Fatal(err)
	}
	if mode := statMode(t, path); mode != 0o600 {
		t.Fatalf("mode is %o, want 600 for a file holding a bot token", mode)
	}

	// Existing content survives, and an existing key is replaced where it
	// stands rather than appended: systemd takes the last assignment, and a
	// file with two of the same key is unreadable to whoever debugs it.
	if err := os.WriteFile(path, []byte("# notes\nPOCKTERM_TOKEN=keepme\nPOCKTERM_TG_TOKEN=old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := UpdateEnvFile(path, [][2]string{
		{"POCKTERM_TG_TOKEN", "42:new"},
		{"POCKTERM_TG_CHAT", "777"},
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := "# notes\nPOCKTERM_TOKEN=keepme\nPOCKTERM_TG_TOKEN=42:new\nPOCKTERM_TG_CHAT=777\n"
	if string(got) != want {
		t.Fatalf("file is:\n%s\nwant:\n%s", got, want)
	}
}

func statMode(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
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
