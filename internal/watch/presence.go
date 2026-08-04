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

func (p Presence) Join(session string, id int64) { p.Viewers.Join(session, id) }

func (p Presence) SetVisible(session string, id int64, visible bool) {
	p.Viewers.SetVisible(session, id, visible)
}

func (p Presence) Leave(session string, id int64) { p.Viewers.Leave(session, id) }

func (p Presence) Counts() (clients, visible int) { return p.Viewers.Counts() }

// Activity is what the session list carries to the page so a tab can be
// coloured by what the session is doing. A string rather than the Activity type:
// the server must not have to import this package to describe its own wire
// format, which is the same reason Presence exists at all.
func (p Presence) Activity(session string) string { return string(p.Watcher.Activity(session)) }
