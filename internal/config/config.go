// Package config reads pockterm settings from the environment
// (systemd-friendly: no flags, no files).
package config

import (
	"fmt"
	"net"
)

type Config struct {
	Listen    string // POCKTERM_LISTEN, host:port
	Session   string // POCKTERM_SESSION, tmux target session/group
	Bootstrap string // POCKTERM_BOOTSTRAP, command for a missing session ("" = login shell)
	Token     string // POCKTERM_TOKEN, required for non-loopback listen
}

func FromEnv(getenv func(string) string) (Config, error) {
	c := Config{
		Listen:    orDefault(getenv("POCKTERM_LISTEN"), "127.0.0.1:8130"),
		Session:   orDefault(getenv("POCKTERM_SESSION"), "claude"),
		Bootstrap: getenv("POCKTERM_BOOTSTRAP"),
		Token:     getenv("POCKTERM_TOKEN"),
	}
	if err := c.validate(); err != nil {
		return Config{}, err
	}
	return c, nil
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func (c Config) validate() error {
	host, _, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return fmt.Errorf("invalid POCKTERM_LISTEN %q: %w", c.Listen, err)
	}
	ip := net.ParseIP(host)
	loopback := host == "localhost" || (ip != nil && ip.IsLoopback())
	// A terminal without auth must never face a network: fail closed.
	if !loopback && c.Token == "" {
		return fmt.Errorf("refusing to listen on non-loopback %q without POCKTERM_TOKEN", c.Listen)
	}
	return nil
}
