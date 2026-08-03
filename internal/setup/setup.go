// Package setup holds the pieces installation needs: a token, a systemd
// unit, the URL a phone opens, and that URL as a QR code.
//
// They live in Go rather than in the install script so they can be tested,
// and so the script stays a thin wrapper that anyone can read in one sitting.
package setup

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"strings"

	qrcode "github.com/skip2/go-qrcode"
)

// Token returns a fresh shared token. base64url without padding: it goes into
// a query string and a QR code, so it must survive both without escaping.
func Token() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("reading random bytes: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

type UnitOptions struct {
	User    string // account the terminal runs as; its tmux sessions are the ones served
	Listen  string // host:port, loopback unless a proxy sits in front
	EnvFile string // optional file with the token and any other secrets
	Binary  string // path to the installed binary
}

// Unit renders the systemd unit. The token is deliberately absent: units are
// world-readable, so secrets go to EnvFile (0600) instead.
func Unit(o UnitOptions) string {
	var b strings.Builder
	b.WriteString(`[Unit]
Description=pockterm - mobile web terminal for your tmux sessions
After=network.target

[Service]
Type=simple
`)
	fmt.Fprintf(&b, "User=%s\n", o.User)
	// The working directory is where the "+" button looks for a session
	// Makefile when POCKTERM_SESSION_DIR says nothing; systemd's own default
	// is "/", where nobody keeps one. The leading "-" keeps the unit starting
	// for an account without a home directory.
	b.WriteString("WorkingDirectory=-~\n")
	fmt.Fprintf(&b, "Environment=POCKTERM_LISTEN=%s\n", o.Listen)
	if o.EnvFile != "" {
		// The leading "-" keeps the unit starting when the file is absent.
		fmt.Fprintf(&b, "EnvironmentFile=-%s\n", o.EnvFile)
	}
	b.WriteString(`Restart=always
RestartSec=3
`)
	fmt.Fprintf(&b, "ExecStart=%s\n", o.Binary)
	b.WriteString(`
[Install]
WantedBy=multi-user.target
`)
	return b.String()
}

// IsWildcard reports whether a listen address accepts connections on every
// interface — the case where the address itself is useless to a phone.
func IsWildcard(listen string) bool {
	host, _, err := net.SplitHostPort(listen)
	if err != nil {
		return false
	}
	if host == "" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsUnspecified()
}

// ListenURL turns a listen address into something a browser can open. A
// wildcard address is rewritten to host, which is what the machine is
// reachable as from the rest of the network.
func ListenURL(listen, host string) string {
	h, port, err := net.SplitHostPort(listen)
	if err != nil {
		return "http://" + listen
	}
	if host != "" && (h == "" || net.ParseIP(h).IsUnspecified()) {
		h = host
	}
	// JoinHostPort brackets an IPv6 literal itself.
	return "http://" + net.JoinHostPort(h, port)
}

// PickLAN chooses the address to hand out from a machine's own addresses.
//
// A private IPv4 wins: that is what a phone on the same Wi-Fi can reach, and
// on a host with docker or wireguard the list is long enough that "the first
// one" is a coin toss. Loopback and link-local are never useful here.
func PickLAN(addrs []net.IP) (net.IP, bool) {
	var global net.IP
	for _, ip := range addrs {
		if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
			continue
		}
		if v4 := ip.To4(); v4 != nil {
			if v4.IsPrivate() {
				return v4, true
			}
			if global == nil {
				global = v4
			}
			continue
		}
		if global == nil {
			global = ip
		}
	}
	return global, global != nil
}

// LANAddress is PickLAN over this machine's interfaces.
func LANAddress() (string, error) {
	ifaceAddrs, err := net.InterfaceAddrs()
	if err != nil {
		return "", fmt.Errorf("reading interface addresses: %w", err)
	}
	var ips []net.IP
	for _, a := range ifaceAddrs {
		if n, ok := a.(*net.IPNet); ok {
			ips = append(ips, n.IP)
		}
	}
	ip, ok := PickLAN(ips)
	if !ok {
		return "", errors.New("no address of this machine is reachable from another one")
	}
	return ip.String(), nil
}

// ClientURL is what the phone opens: the public address plus the token.
func ClientURL(base, token string) string {
	url := strings.TrimRight(base, "/") + "/"
	if token != "" {
		url += "?token=" + token
	}
	return url
}

// QR renders the URL as a QR code for a terminal. Half-block characters keep
// it small enough to fit an 80-column window.
func QR(url string) (string, error) {
	if url == "" {
		return "", errors.New("empty URL")
	}
	// Medium recovery: a terminal render is crisp, so the extra redundancy of
	// a higher level would only make the code bigger.
	code, err := qrcode.New(url, qrcode.Medium)
	if err != nil {
		return "", fmt.Errorf("encoding QR: %w", err)
	}
	return code.ToSmallString(false), nil
}
