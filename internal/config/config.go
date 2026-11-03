// Package config reads pockterm settings from the environment
// (systemd-friendly: no flags, no files).
package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"regexp"
	"strings"
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

	// The host's way out, shown in the drawer's header: names for gateways and
	// devices ("192.168.1.1=роутер,usb0=свисток"); empty shows nothing. The
	// public address beside it is asked of the services listed in PublicIPURLs
	// (comma-separated, tried in order); empty asks nobody.
	Uplinks      string // POCKTERM_UPLINKS
	PublicIPURLs string // POCKTERM_PUBLIC_IP_URLS

	// A second door to this same server, nearer than the one a page was opened
	// through: the page tries its socket there first and keeps its own address
	// for everything else (an origin, "https://lan.example:8135"; empty tries
	// nothing). The server behind that door has to take a socket from a page it
	// did not serve, so it names the pages it trusts — origins, comma-separated —
	// on top of its own, which is always trusted.
	DirectURL      string   // POCKTERM_DIRECT_URL
	TrustedOrigins []string // POCKTERM_TRUSTED_ORIGINS
	// Where the nearer door's proxy hands its sockets to this server: a second
	// listener that serves the terminal socket alone, to a page with a ticket
	// from this same process. Empty opens no such listener, and the page then
	// never tries the door.
	DoorListen string // POCKTERM_DOOR_LISTEN

	// Other hosts running a pockterm of their own, whose sessions the page lists
	// beside this one's and starts new ones on. The page talks to each of them
	// itself — nothing here is proxied — so this is only the list it is handed
	// (/api/peers). Empty is one host, exactly as before.
	//
	// Format: entries separated by commas, each `name=URL` or `name=URL|DOOR`.
	// URL is where the page reaches that host's API and socket: an origin, or an
	// origin with a path when a proxy puts the host under a prefix of another
	// door. DOOR is that host's nearer door (see DirectURL), an origin. The list
	// may name this host as well, so one value serves every host; HostName says
	// which entry that is.
	Peers []Peer // POCKTERM_PEERS
	// What this host is called in that list, and on the page beside each of its
	// sessions. Empty means the machine's hostname, up to the first dot.
	HostName string // POCKTERM_HOST_NAME
}

// Peer is one host of POCKTERM_PEERS.
type Peer struct {
	Name   string `json:"name"`
	URL    string `json:"url"`
	Direct string `json:"direct,omitempty"`
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
		Uplinks:        getenv("POCKTERM_UPLINKS"),
		PublicIPURLs:   getenv("POCKTERM_PUBLIC_IP_URLS"),
		DoorListen:     getenv("POCKTERM_DOOR_LISTEN"),
	}
	if c.DirectURL, err = origin("POCKTERM_DIRECT_URL", getenv("POCKTERM_DIRECT_URL")); err != nil {
		return Config{}, err
	}
	for _, v := range strings.Split(getenv("POCKTERM_TRUSTED_ORIGINS"), ",") {
		o, err := origin("POCKTERM_TRUSTED_ORIGINS", v)
		if err != nil {
			return Config{}, err
		}
		if o != "" {
			c.TrustedOrigins = append(c.TrustedOrigins, o)
		}
	}
	if c.HostName, err = hostName(getenv("POCKTERM_HOST_NAME")); err != nil {
		return Config{}, err
	}
	if c.Peers, err = peers(getenv("POCKTERM_PEERS")); err != nil {
		return Config{}, err
	}
	if err := c.validate(); err != nil {
		return Config{}, err
	}
	return c, nil
}

// hostname is os.Hostname, replaceable by the tests.
var hostname = os.Hostname

// hostNameOK is what a host may be called: it is shown beside a session's name
// and joined to it with "@" on the page, so it keeps to the alphabet a session
// name keeps to (session.ValidName) and can never contain the separator.
var (
	hostNameOK  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$`)
	hostNameBad = regexp.MustCompile(`[^a-z0-9_-]+`)
)

func hostName(v string) (string, error) {
	v = strings.TrimSpace(v)
	if v != "" {
		if !hostNameOK.MatchString(v) {
			return "", fmt.Errorf("invalid POCKTERM_HOST_NAME %q: want letters, digits, - and _, up to 24", v)
		}
		return v, nil
	}
	// The default has nobody to complain to, so it is made to fit rather than
	// refused: a host whose name does not fit is still one host.
	h, err := hostname()
	if err != nil {
		return "host", nil
	}
	h, _, _ = strings.Cut(strings.ToLower(h), ".")
	h = hostNameBad.ReplaceAllString(h, "-")
	h = strings.TrimLeft(h, "-_")
	if len(h) > 24 {
		h = h[:24]
	}
	if !hostNameOK.MatchString(h) {
		return "host", nil
	}
	return h, nil
}

// peers reads POCKTERM_PEERS. Every fault is refused rather than skipped: a
// host left out of the list without a word is a host whose sessions simply are
// not there, and nothing on the phone would say why.
func peers(v string) ([]Peer, error) {
	var out []Peer
	seen := map[string]bool{}
	for _, entry := range strings.Split(v, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		name, rest, ok := strings.Cut(entry, "=")
		name = strings.TrimSpace(name)
		if !ok || !hostNameOK.MatchString(name) {
			return nil, fmt.Errorf("invalid POCKTERM_PEERS entry %q: want name=https://host[:port][/path][|https://door:port]", entry)
		}
		if seen[name] {
			return nil, fmt.Errorf("POCKTERM_PEERS names %q twice", name)
		}
		seen[name] = true
		base, door, _ := strings.Cut(rest, "|")
		p := Peer{Name: name}
		var err error
		if p.URL, err = baseURL(base); err != nil {
			return nil, fmt.Errorf("POCKTERM_PEERS %s: %w", name, err)
		}
		if p.Direct, err = origin("POCKTERM_PEERS "+name+" door", door); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

// baseURL reads where a host's API lives: an origin, optionally followed by a
// path a proxy has put it under. The page joins "/api/…" and "/ws" to it, so a
// trailing slash is refused — the result would be "//api", which a proxy may
// or may not fold — and so is anything after the path.
func baseURL(v string) (string, error) {
	v = strings.TrimSpace(v)
	u, err := url.Parse(v)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" ||
		u.RawQuery != "" || u.Fragment != "" || u.User != nil || strings.HasSuffix(u.Path, "/") ||
		strings.Contains(v, "?") || strings.Contains(v, "#") {
		return "", fmt.Errorf("invalid URL %q: want https://host[:port] or https://host[:port]/prefix, no trailing slash", v)
	}
	return strings.ToLower(u.Scheme+"://"+u.Host) + u.EscapedPath(), nil
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

// origin reads an origin as a browser writes one: scheme and host, lower case,
// nothing after them. A path or a trailing slash is refused rather than cut,
// because the server compares origins as strings, and an entry that never
// matches would turn a door off with nothing to say why.
func origin(name, v string) (string, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return "", nil
	}
	u, err := url.Parse(v)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" ||
		u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return "", fmt.Errorf("invalid %s %q: want an origin such as https://host:port, nothing after it", name, v)
	}
	return strings.ToLower(u.Scheme + "://" + u.Host), nil
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
	if c.DoorListen != "" {
		host, _, err := net.SplitHostPort(c.DoorListen)
		if err != nil {
			return fmt.Errorf("invalid POCKTERM_DOOR_LISTEN %q: %w", c.DoorListen, err)
		}
		// A ticket is a way in only for a page that was let in before; the
		// listener itself is for a proxy on this machine.
		if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return fmt.Errorf("refusing POCKTERM_DOOR_LISTEN on non-loopback %q", c.DoorListen)
		}
	}
	// Half-configured notifications would fail silently at the first event.
	if (c.TGToken == "") != (c.TGChat == "") {
		return fmt.Errorf("POCKTERM_TG_TOKEN and POCKTERM_TG_CHAT must be set together")
	}
	return nil
}
