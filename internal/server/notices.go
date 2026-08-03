package server

import "sync"

// Notices carries a notification to the pages attached to a session.
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

type Notices struct {
	mu sync.Mutex
	m  map[string]map[int64]func(Notice)
}

func NewNotices() *Notices {
	return &Notices{m: make(map[string]map[int64]func(Notice))}
}

func (n *Notices) add(session string, id int64, send func(Notice)) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.m[session] == nil {
		n.m[session] = make(map[int64]func(Notice))
	}
	n.m[session][id] = send
}

func (n *Notices) remove(session string, id int64) {
	n.mu.Lock()
	defer n.mu.Unlock()
	c, ok := n.m[session]
	if !ok {
		return
	}
	delete(c, id)
	if len(c) == 0 {
		delete(n.m, session)
	}
}

// Send delivers to every page attached to the session. Whether it *should*
// be sent was decided upstream — the watcher stays silent for a session
// somebody is looking at, so anything arriving here is for a page that is
// open but in the background.
func (n *Notices) Send(session string, notice Notice) {
	n.mu.Lock()
	sends := make([]func(Notice), 0, len(n.m[session]))
	for _, s := range n.m[session] {
		sends = append(sends, s)
	}
	n.mu.Unlock()
	for _, s := range sends {
		s(notice)
	}
}
