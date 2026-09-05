// Package config reads pockterm settings from the environment
// (systemd-friendly: no flags, no files).
package config

import (
	"fmt"
	"net"
	"os"
	"time"
)

type Config struct {
	Listen string // POCKTERM_LISTEN, host:port
	Token  string // POCKTERM_TOKEN, required for non-loopback listen

	// Where images pasted in the browser are saved. Empty means the
	// default under the user's cache directory; "off" disables uploads.
	UploadDir string // POCKTERM_UPLOAD_DIR

	// Directory holding the session Makefile the page may run presets from.
	// Empty means the working directory; "off" refuses to start any.
	SessionMakeDir string // POCKTERM_SESSION_DIR

	// Telegram notifications; empty TGToken disables them entirely.
	TGToken   string        // POCKTERM_TG_TOKEN, bot token
	TGChat    string        // POCKTERM_TG_CHAT, chat id to notify
	TGLink    string        // POCKTERM_TG_LINK, URL appended to messages
	TGPreview bool          // POCKTERM_TG_PREVIEW=off sends no screen text
	TGAPI     string        // POCKTERM_TG_API, Bot API root (a local bot server, or a test double)
	Idle      time.Duration // POCKTERM_IDLE, silence that counts as "finished"

	// Where the notification switch is remembered. Empty means a file under
	// the user's config directory; "off" keeps the mode in memory, which loses
	// it on the next restart — and CI restarts this binary on every push.
	NotifyFile string // POCKTERM_NOTIFY_FILE

	// Where the owner's custom session buttons are kept, on the same terms as
	// NotifyFile: empty means a file under the user's config directory, "off"
	// keeps them in memory and loses them on the next restart.
	PresetsFile string // POCKTERM_PRESETS_FILE

	// Web Push: the VAPID key pair and the devices subscribed to it. Both are
	// files because both outlive the process by months — the public half of the
	// key is baked into every subscription a browser made, and CI installs a new
	// binary several times a working day. "off" turns push off entirely, which
	// is the state for anyone who does not want the browser's push service in
	// the path at all.
	VapidFile string // POCKTERM_VAPID_FILE
	PushFile  string // POCKTERM_PUSH_FILE
	// Who a push service should complain to about this sender. RFC 8292 wants a
	// mailto: or an https URL; empty names the program.
	PushSubject string // POCKTERM_PUSH_SUBJECT
}

func FromEnv(getenv func(string) string) (Config, error) {
	idle, err := duration(getenv("POCKTERM_IDLE"), 30*time.Second)
	if err != nil {
		return Config{}, err
	}
	c := Config{
		Listen:         orDefault(getenv("POCKTERM_LISTEN"), "127.0.0.1:8130"),
		Token:          getenv("POCKTERM_TOKEN"),
		UploadDir:      getenv("POCKTERM_UPLOAD_DIR"),
		SessionMakeDir: getenv("POCKTERM_SESSION_DIR"),
		TGToken:        getenv("POCKTERM_TG_TOKEN"),
		TGChat:         getenv("POCKTERM_TG_CHAT"),
		TGLink:         getenv("POCKTERM_TG_LINK"),
		TGPreview:      getenv("POCKTERM_TG_PREVIEW") != "off",
		TGAPI:          getenv("POCKTERM_TG_API"),
		Idle:           idle,
		NotifyFile:     getenv("POCKTERM_NOTIFY_FILE"),
		PresetsFile:    getenv("POCKTERM_PRESETS_FILE"),
		VapidFile:      getenv("POCKTERM_VAPID_FILE"),
		PushFile:       getenv("POCKTERM_PUSH_FILE"),
		PushSubject:    getenv("POCKTERM_PUSH_SUBJECT"),
	}
	if err := c.validate(); err != nil {
		return Config{}, err
	}
	return c, nil
}

// Notify reports whether Telegram notifications are configured.
func (c Config) Notify() bool { return c.TGToken != "" && c.TGChat != "" }

// SessionDir resolves the directory whose Makefile the page runs presets
// from, and reports whether starting sessions is allowed at all.
//
// The fallback is the process's working directory — for a unit, whatever
// WorkingDirectory= says. It used to be one absolute path compiled into the
// binary, which is the author's own work directory: the button then worked on
// exactly one machine and silently did nothing everywhere else.
func (c Config) SessionDir() (dir string, on bool, err error) {
	switch c.SessionMakeDir {
	case "off":
		return "", false, nil
	case "":
		wd, err := os.Getwd()
		if err != nil {
			return "", false, fmt.Errorf("no working directory to look for a session Makefile in: %w", err)
		}
		return wd, true, nil
	default:
		return c.SessionMakeDir, true, nil
	}
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func duration(v string, def time.Duration) (time.Duration, error) {
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("invalid POCKTERM_IDLE %q: %w", v, err)
	}
	if d <= 0 {
		return 0, fmt.Errorf("POCKTERM_IDLE must be positive, got %q", v)
	}
	return d, nil
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
	// Half-configured notifications would fail silently at the first event.
	if (c.TGToken == "") != (c.TGChat == "") {
		return fmt.Errorf("POCKTERM_TG_TOKEN and POCKTERM_TG_CHAT must be set together")
	}
	return nil
}
