package server

import "sync"

// Notices carries a notification to the pages that are open.
//
// The decision itself is not made here and not in the browser: the watcher
// reads the pane with capture-pane and knows, for every session, whether it
// asked something or went quiet. Before this, the page tried to work the same
// thing out from the bytes arriving on its socket — and got it wrong twice
// over. tmux redraws its status line on a timer, so "output arrived" meant
// "the clock ticked", and the countdown to "finished" never ran out; and the
// timer that checked it is throttled to a crawl once Android backgrounds the
// WebView, which is exactly when a notification matters. What reached the
// phone was unpredictable, and the owner said so.
//
// So the page no longer decides anything. It renders what arrives.
type Notice struct {
	Type    string `json:"type"` // always "notify"
	Kind    string `json:"kind"` // "question" | "done"
	Session string `json:"session"`
	Title   string `json:"title"`
	Body    string `json:"body"`
}

// Notices holds one send per open socket, by client id.
//
// By id and not by session, and that is the whole point of this type. It used
// to route a notice only to the pages attached to the session it was about,
// which is a channel that cannot deliver the notice anyone actually waits for:
// a phone has one socket, on the session being looked at, and the watcher stays
// silent about that one on purpose. So a question in the session next to it
// reached nobody — with Telegram off, "notify this page" delivered nothing at
// all, and it was reported exactly that way.
//
// The notice names its session and a tap on it switches there (see
// notificationclick in web/sw.js), so a page has always been able to show one
// about a session it is not attached to. Only the routing was narrow.
type Notices struct {
	mu sync.Mutex
	m  map[int64]func(Notice)
}

func NewNotices() *Notices {
	return &Notices{m: make(map[int64]func(Notice))}
}

func (n *Notices) add(id int64, send func(Notice)) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.m[id] = send
}

func (n *Notices) remove(id int64) {
	n.mu.Lock()
	defer n.mu.Unlock()
	delete(n.m, id)
}

// Send delivers to every page with a socket open, except the ones `showing`
// answers for — the pages that have this very session visible.
//
// The exception is per page, and that is the point. "Somebody has it on screen"
// was the whole rule and it was decided upstream for everyone at once: a phone
// open on one session was told nothing about the session beside it, because
// another screen had that one visible. A page cannot see the other screens and
// has no business being silenced by them; what it does know is what it is showing
// itself, and about that one a notice would be news to nobody.
//
// A nil `showing` sends to everyone, which is what an event about a session
// nobody has open comes to.
//
// It reports how many pages took it and how many were skipped, because "the
// notifications do not arrive" is otherwise an impression: with this the journal
// says whether the frame was sent and to how many sockets.
func (n *Notices) Send(notice Notice, showing func(id int64) bool) (sent, skipped int) {
	n.mu.Lock()
	sends := make([]func(Notice), 0, len(n.m))
	for id, s := range n.m {
		if showing != nil && showing(id) {
			skipped++
			continue
		}
		sends = append(sends, s)
	}
	n.mu.Unlock()
	for _, s := range sends {
		s(notice)
	}
	return len(sends), skipped
}
