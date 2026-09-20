package watch

// Presence couples the two registries for the server: attaching to a
// session puts it under observation and marks the client as looking at it.
// It satisfies server.Presence without the server importing this package's
// concrete types.
type Presence struct {
	Watcher *Watcher
	Viewers *Viewers
}

func (p Presence) Watch(session string) { p.Watcher.Watch(session) }

// Join and Leave both rebase the watcher's idea of the screen: a client arriving
// or going resizes the pane, and the redraw that follows is nobody's work. See
// Watcher.Rebase for what it cost — a tab purple for the idle threshold at every
// tap, and a session announced as finished for having been left.
func (p Presence) Join(session string, id int64) {
	p.Viewers.Join(session, id)
	p.Watcher.Rebase(session)
}

func (p Presence) SetVisible(session string, id int64, visible bool) {
	p.Viewers.SetVisible(session, id, visible)
}

func (p Presence) Leave(session string, id int64) {
	p.Viewers.Leave(session, id)
	p.Watcher.Rebase(session)
}

func (p Presence) Counts() (clients, visible int) { return p.Viewers.Counts() }

// Activity is what the session list carries to the page so a tab can be
// coloured by what the session is doing. A string rather than the Activity type:
// the server must not have to import this package to describe its own wire
// format, which is the same reason Presence exists at all.
func (p Presence) Activity(session string) string { return string(p.Watcher.Activity(session)) }

// Background travels with the session list for the same reason Activity does,
// and is spelled in plain ints for the same reason it is spelled as a string:
// the server describes its own wire format without importing this package.
func (p Presence) Background(session string) (shells, monitors, agents int) {
	bg := p.Watcher.Background(session)
	return bg.Shells, bg.Monitors, bg.Agents
}
