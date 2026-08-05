package watch

import "testing"

// The per-page question: this client, this session.
func TestWatchingIsPerClient(t *testing.T) {
	v := NewViewers()
	v.Join("natal", 1)
	v.Join("demo", 2)
	if !v.Watching("natal", 1) {
		t.Error("the client attached to natal is not watching it")
	}
	// The client looking at demo is not watching natal, however visible natal is
	// to somebody else — that difference is the whole point of this method.
	if v.Watching("natal", 2) {
		t.Error("a client on another session counts as watching natal")
	}
	if !v.Viewing("natal") {
		t.Error("natal is visible to somebody")
	}
	// Backgrounded: the socket is open and nobody is looking.
	v.SetVisible("natal", 1, false)
	if v.Watching("natal", 1) || v.Viewing("natal") {
		t.Error("a backgrounded tab still counts as watching")
	}
	// And a client that never joined is not watching anything.
	if v.Watching("natal", 99) {
		t.Error("an unknown client counts as watching")
	}
}
