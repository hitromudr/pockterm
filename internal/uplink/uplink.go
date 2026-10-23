// Package uplink says which way the host goes out to the world: the interface
// and gateway its default route leaves by, under a name the owner gave it, and
// the address the world sees the host from.
//
// Asked for on the RPi5 (2026-10-23), which falls back from the home router to
// a 4G dongle or the phone's hotspot on its own (wired-wifi-toggle) and gives
// no sign of it to whoever is looking at the terminal.
package uplink

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Route is the default route the kernel takes: the device and, when there is
// one, the gateway behind it.
type Route struct {
	Dev     string
	Gateway string
}

// DefaultRoute reads /proc/net/route and picks the default route with the
// lowest metric — the one the kernel uses. The file rather than `ip route`:
// nothing to exec, and the table is the kernel's own word.
func DefaultRoute(r io.Reader) (Route, bool) {
	var best Route
	bestMetric := -1
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		// Iface Destination Gateway Flags RefCnt Use Metric Mask ...
		if len(f) < 8 || f[1] != "00000000" || f[7] != "00000000" {
			continue
		}
		flags, err := strconv.ParseUint(f[3], 16, 32)
		if err != nil || flags&1 == 0 { // RTF_UP
			continue
		}
		metric, err := strconv.Atoi(f[6])
		if err != nil || (bestMetric >= 0 && metric >= bestMetric) {
			continue
		}
		best, bestMetric = Route{Dev: f[0], Gateway: hexIPv4(f[2])}, metric
	}
	return best, bestMetric >= 0
}

// hexIPv4 turns the table's host-order hex into dotted form; "" for none.
func hexIPv4(s string) string {
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != 4 || binary.LittleEndian.Uint32(b) == 0 {
		return ""
	}
	return net.IPv4(b[3], b[2], b[1], b[0]).String()
}

// Names are the owner's names for the ways out.
//
// A gateway is matched before a device: on the RPi5 the home router answers at
// one address whether the host reaches it by the wire or by its own Wi-Fi,
// while the same wlan0 that reaches the router also joins the phone's hotspot.
type Names struct {
	byGateway map[string]string
	byDev     map[string]string
}

// ParseNames reads "192.168.1.1=роутер,usb0=свисток": a key that is an IP
// address names a gateway, any other key a device.
func ParseNames(spec string) (Names, error) {
	n := Names{byGateway: map[string]string{}, byDev: map[string]string{}}
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key, label, ok := strings.Cut(part, "=")
		key, label = strings.TrimSpace(key), strings.TrimSpace(label)
		if !ok || key == "" || label == "" {
			return Names{}, fmt.Errorf("uplink name %q is not key=label", part)
		}
		if ip := net.ParseIP(key); ip != nil {
			n.byGateway[ip.String()] = label
		} else {
			n.byDev[key] = label
		}
	}
	return n, nil
}

// Label names a route; a way out nobody named is called by its device, which
// says more than nothing and less than a guess.
func (n Names) Label(rt Route) string {
	if l, ok := n.byGateway[rt.Gateway]; ok && rt.Gateway != "" {
		return l
	}
	if l, ok := n.byDev[rt.Dev]; ok {
		return l
	}
	return rt.Dev
}

// Prober learns the host's public address from services that echo it back.
//
// The answer belongs to the route it was learnt on: a new way out forgets it
// at once rather than show the router's address while the host is on the
// dongle — a wrong address looks exactly like the right one. It is asked again
// every Every while somebody is looking, sooner after a failure.
type Prober struct {
	URLs   []string
	Every  time.Duration
	Retry  time.Duration
	Client *http.Client
	Now    func() time.Time

	mu    sync.Mutex
	route Route
	addr  string
	at    time.Time // when the last lookup for route finished; zero = never
	ok    bool      // whether it found an address
	busy  bool
}

// NewProber asks urls in order. Proxy is nil on purpose: the service has to see
// the host itself, and pockterm's environment carries HTTPS_PROXY for the push
// services — through it the answer would be the proxy's address.
func NewProber(urls []string) *Prober {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	return &Prober{
		URLs:   urls,
		Every:  5 * time.Minute,
		Retry:  30 * time.Second,
		Client: &http.Client{Transport: tr, Timeout: 5 * time.Second},
		Now:    time.Now,
	}
}

// Address answers at once with what is known for rt ("" while nothing is) and
// starts a lookup in the background when the answer is due.
func (p *Prober) Address(rt Route) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if rt != p.route {
		p.route, p.addr, p.at, p.ok = rt, "", time.Time{}, false
	}
	wait := p.Every
	if !p.ok {
		wait = p.Retry
	}
	if !p.busy && (p.at.IsZero() || p.Now().Sub(p.at) >= wait) {
		p.busy = true
		go p.lookup(rt)
	}
	return p.addr
}

func (p *Prober) lookup(rt Route) {
	addr, err := p.ask()
	p.mu.Lock()
	defer p.mu.Unlock()
	p.busy = false
	if rt != p.route {
		return // the way out changed while asking: the answer is about the old one
	}
	if err != nil && p.ok {
		log.Printf("uplink: public address unknown: %v", err)
	}
	if err == nil && addr != p.addr {
		log.Printf("uplink: public address %s via %s", addr, rt.Dev)
	}
	p.addr, p.ok, p.at = addr, err == nil, p.Now()
}

func (p *Prober) ask() (string, error) {
	var errs []string
	for _, u := range p.URLs {
		addr, err := p.askOne(u)
		if err == nil {
			return addr, nil
		}
		errs = append(errs, err.Error())
	}
	return "", fmt.Errorf("%s", strings.Join(errs, "; "))
}

// askOne takes a bare address, with or without quotes around it — the shape
// of both ipify and Yandex's internet.yandex.ru.
func (p *Prober) askOne(u string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	resp, err := p.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s: %s", u, resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 256))
	if err != nil {
		return "", err
	}
	s := strings.Trim(strings.TrimSpace(string(body)), `"`)
	ip := net.ParseIP(s)
	if ip == nil {
		return "", fmt.Errorf("%s: not an address: %q", u, s)
	}
	return ip.String(), nil
}
