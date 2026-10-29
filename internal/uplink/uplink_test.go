package uplink

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Captured on the RPi5 2026-10-23: the wire carries the world, the dongle's
// device is up without a default route of its own.
const routeWire = `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
eth0	00000000	0101A8C0	0003	0	0	100	00000000	0	0	0
incusbr0	00699D0A	00000000	0001	0	0	0	00FFFFFF	0	0	0
eth0	0001A8C0	00000000	0001	0	0	100	00FFFFFF	0	0	0
usb0	002AA8C0	00000000	0001	0	0	101	00FFFFFF	0	0	0
`

func TestDefaultRouteIsTheWire(t *testing.T) {
	rt, ok := DefaultRoute(strings.NewReader(routeWire))
	if !ok || rt != (Route{Dev: "eth0", Gateway: "192.168.1.1"}) {
		t.Fatalf("route = %+v, %v; want eth0 via 192.168.1.1", rt, ok)
	}
}

func TestDefaultRouteTakesTheLowestMetric(t *testing.T) {
	// In a fallback the dongle's profile comes up at metric 50 beside the wire's
	// 100: the kernel goes out by the dongle, and so must the answer.
	table := routeWire + "usb0	00000000	812AA8C0	0003	0	0	50	00000000	0	0	0\n"
	rt, ok := DefaultRoute(strings.NewReader(table))
	if !ok || rt != (Route{Dev: "usb0", Gateway: "192.168.42.129"}) {
		t.Fatalf("route = %+v, %v; want usb0 via 192.168.42.129", rt, ok)
	}
}

func TestNoDefaultRoute(t *testing.T) {
	table := strings.Join(strings.Split(routeWire, "\n")[2:], "\n")
	if rt, ok := DefaultRoute(strings.NewReader(table)); ok {
		t.Fatalf("route = %+v, want none", rt)
	}
}

func TestDefaultRouteSkipsARouteThatIsDown(t *testing.T) {
	table := "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n" +
		"eth0\t00000000\t0101A8C0\t0002\t0\t0\t100\t00000000\n"
	if rt, ok := DefaultRoute(strings.NewReader(table)); ok {
		t.Fatalf("route = %+v, want none: RTF_UP is not set", rt)
	}
}

func TestLabelPrefersTheGateway(t *testing.T) {
	n, err := ParseNames("192.168.1.1=роутер, usb0=свисток,wlan0=телефон")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		rt   Route
		want string
	}{
		{Route{"eth0", "192.168.1.1"}, "роутер"},
		// The same Wi-Fi card on the home network is still the router...
		{Route{"wlan0", "192.168.1.1"}, "роутер"},
		// ...and on any other network it is the phone.
		{Route{"wlan0", "10.21.4.1"}, "телефон"},
		{Route{"usb0", "192.168.42.129"}, "свисток"},
		{Route{"wlan1", "10.0.0.1"}, "wlan1"},
	} {
		if got := n.Label(c.rt); got != c.want {
			t.Errorf("Label(%+v) = %q, want %q", c.rt, got, c.want)
		}
	}
}

func TestParseNamesRefusesNonsense(t *testing.T) {
	for _, spec := range []string{"eth0", "=роутер", "eth0="} {
		if _, err := ParseNames(spec); err == nil {
			t.Errorf("ParseNames(%q) accepted it", spec)
		}
	}
}

// waitAddr polls Address until the background lookup lands.
func waitAddr(t *testing.T, p *Prober, rt Route, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		got := p.Address(rt)
		if got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("Address(%+v) = %q, want %q", rt, got, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestProberForgetsTheAddressWhenTheRouteChanges(t *testing.T) {
	var addr atomic.Value
	addr.Store("203.0.113.7")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%q\n", addr.Load()) // quoted, the way Yandex answers
	}))
	t.Cleanup(srv.Close)

	p := NewProber([]string{srv.URL})
	wire := Route{"eth0", "192.168.1.1"}
	if got := p.Address(wire); got != "" {
		t.Fatalf("first answer %q, want nothing before the lookup", got)
	}
	waitAddr(t, p, wire, "203.0.113.7")

	// The dongle takes over: the router's address must not be shown for it,
	// not even for the moment the new lookup takes.
	addr.Store("198.51.100.9")
	dongle := Route{"usb0", "192.168.42.129"}
	if got := p.Address(dongle); got != "" {
		t.Fatalf("answer on the new route %q, want nothing until it is asked", got)
	}
	waitAddr(t, p, dongle, "198.51.100.9")
}

func TestProberAsksAgainOnlyWhenDue(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		fmt.Fprintln(w, "203.0.113.7")
	}))
	t.Cleanup(srv.Close)

	now := time.Unix(1_800_000_000, 0)
	p := NewProber([]string{srv.URL})
	p.Now = func() time.Time { return now }
	rt := Route{"eth0", "192.168.1.1"}
	waitAddr(t, p, rt, "203.0.113.7")
	// The page polls every few seconds while the drawer is open.
	for i := 0; i < 20; i++ {
		p.Address(rt)
	}
	if n := hits.Load(); n != 1 {
		t.Fatalf("%d lookups within Every, want 1", n)
	}
	now = now.Add(p.Every)
	p.Address(rt)
	deadline := time.Now().Add(2 * time.Second)
	for hits.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if n := hits.Load(); n != 2 {
		t.Fatalf("%d lookups after Every, want 2", n)
	}
}

func TestProberFallsBackToTheNextService(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// An operator's stub answers 200 with a page, not an address.
		fmt.Fprintln(w, "<html>пополните баланс</html>")
	}))
	t.Cleanup(down.Close)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "203.0.113.7")
	}))
	t.Cleanup(up.Close)

	p := NewProber([]string{down.URL, up.URL})
	waitAddr(t, p, Route{"eth0", "192.168.1.1"}, "203.0.113.7")
}

// Yandex answered "127.0.0.1" with a 200 on 2026-10-29 while ipify gave the
// real address, and the drawer showed the loopback as the host's face to the
// world. An address nobody outside could have seen is a wrong answer, not one.
func TestProberSkipsAnAddressTheWorldCannotSee(t *testing.T) {
	for _, bogus := range []string{`"127.0.0.1"`, "192.168.1.222", "10.0.0.5", "169.254.1.1", "0.0.0.0", "::1"} {
		t.Run(bogus, func(t *testing.T) {
			wrong := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprintln(w, bogus)
			}))
			t.Cleanup(wrong.Close)
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprintln(w, "109.252.78.115")
			}))
			t.Cleanup(up.Close)

			p := NewProber([]string{wrong.URL, up.URL})
			waitAddr(t, p, Route{"eth0", "192.168.1.1"}, "109.252.78.115")
		})
	}
}

func TestProberIgnoresTheProxy(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	p := NewProber(nil)
	req, _ := http.NewRequest(http.MethodGet, "https://api.ipify.org", nil)
	if tr := p.Client.Transport.(*http.Transport); tr.Proxy != nil {
		if u, _ := tr.Proxy(req); u != nil {
			t.Fatalf("lookup goes through %s: the answer would be the proxy's address", u)
		}
	}
}
