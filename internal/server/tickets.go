package server

import (
	"crypto/rand"
	"encoding/base64"
	"sync"
	"time"
)

// Tickets are what lets a page through the nearer door without a client
// certificate.
//
// The door used to ask for the same certificate as the public one, and Chrome
// on Android remembers the choice only for as long as its process lives: every
// start of the installed app put the system's certificate picker over the
// terminal for the second host (2026-10-30, five times in thirteen hours, one
// of them a Chrome update). Nothing a page can do keeps that choice, so the
// door stopped asking. What it takes instead is a ticket handed out on a
// socket that was already let in — through the public door's certificate, or
// through the nearer door's own ticket — so the chain starts at a certificate
// all the same.
//
// A ticket opens one socket and is gone, and it is held only in this process:
// it travels in the door's query string, which the proxy writes to its log,
// and a line in a log must not be a way in. A restart forgets them all; the
// page then goes the long way once and is handed a new one there.
type Tickets struct {
	mu   sync.Mutex
	live map[string]time.Time // ticket → when it stops opening anything
	ttl  time.Duration
	max  int
	now  func() time.Time
}

// TicketTTL is how long a ticket waits for its socket. A page holds the one it
// was handed until its next connect, which on a phone left in a pocket can be
// the next morning.
const TicketTTL = 24 * time.Hour

// ticketsMax bounds what pages that never came back leave behind. Every socket
// is handed one and every page holds one, so this is far above the pages any
// one host has open.
const ticketsMax = 512

func NewTickets() *Tickets {
	return &Tickets{live: map[string]time.Time{}, ttl: TicketTTL, max: ticketsMax, now: time.Now}
}

// Mint returns a new ticket.
func (t *Tickets) Mint() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand does not fail on any platform this runs on
	}
	s := base64.RawURLEncoding.EncodeToString(b[:])
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	for k, until := range t.live {
		if !now.Before(until) {
			delete(t.live, k)
		}
	}
	for len(t.live) >= t.max {
		var oldest string
		var at time.Time
		for k, until := range t.live {
			if oldest == "" || until.Before(at) {
				oldest, at = k, until
			}
		}
		delete(t.live, oldest)
	}
	t.live[s] = now.Add(t.ttl)
	return s
}

// Take reports whether s is a live ticket, and spends it either way.
func (t *Tickets) Take(s string) bool {
	if s == "" {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	until, ok := t.live[s]
	delete(t.live, s)
	return ok && t.now().Before(until)
}
