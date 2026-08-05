package watch

import "sync"

// Viewers tracks who is looking at which session right now, so a
// notification is not sent for something already on the user's screen.
//
// A visible tab counts; a backgrounded one does not, even though its socket
// stays open — that case is the whole reason visibility is tracked at all.
type Viewers struct {
	mu sync.Mutex
	m  map[string]map[int64]bool // session → client id → visible
}

func NewViewers() *Viewers {
	return &Viewers{m: make(map[string]map[int64]bool)}
}

// Join registers a client that just attached; a fresh client is looking.
func (v *Viewers) Join(session string, id int64) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.m[session] == nil {
		v.m[session] = make(map[int64]bool)
	}
	v.m[session][id] = true
}

// SetVisible records a tab going to the background or coming back.
func (v *Viewers) SetVisible(session string, id int64, visible bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if c, ok := v.m[session]; ok {
		if _, joined := c[id]; joined {
			c[id] = visible
		}
	}
}

// Leave drops a client whose socket closed.
func (v *Viewers) Leave(session string, id int64) {
	v.mu.Lock()
	defer v.mu.Unlock()
	c, ok := v.m[session]
	if !ok {
		return
	}
	delete(c, id)
	if len(c) == 0 {
		delete(v.m, session)
	}
}

// Counts reports how many clients are attached at all, and how many of them
// have their tab on screen right now.
//
// It exists for the deploy script rather than for the UI: installing a new
// binary restarts the unit, and the one moment not to do that is while
// somebody is typing into the terminal it serves. A backgrounded tab still
// holds its socket, so "attached" alone would never give an install window —
// the visible count is the one worth waiting on.
func (v *Viewers) Counts() (clients, visible int) {
	v.mu.Lock()
	defer v.mu.Unlock()
	for _, c := range v.m {
		for _, seen := range c {
			clients++
			if seen {
				visible++
			}
		}
	}
	return clients, visible
}

// Watching reports whether this one client has this session visible.
//
// The per-page question, and the one a notice is routed by: "somebody has it
// visible" is not an answer for a page that is showing something else. It was
// the reason a phone open on one session heard nothing about the session next to
// it — the laptop had that one on screen, and that silenced every page there is.
func (v *Viewers) Watching(session string, id int64) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.m[session][id]
}

// Viewing reports whether any client has this session visible.
func (v *Viewers) Viewing(session string) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	for _, visible := range v.m[session] {
		if visible {
			return true
		}
	}
	return false
}
