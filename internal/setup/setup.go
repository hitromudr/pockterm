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
