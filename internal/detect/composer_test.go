package detect

import "testing"

// The pane the input box was measured on: the ❯ of the composer, then a
// non-breaking space. The same glyph with an ordinary space after it is a menu
// pointer, and that is the whole difference.
func TestInputBoxIsTheAgentsOwnPrompt(t *testing.T) {
	box := []string{
		"───────────────────────────────",
		"❯\u00a01. Надо разнести иконки",
		"  монитора на табах и в меню.",
		"───────────────────────────────",
		"  ctx 4% | dms@ai:~/work $",
	}
	if !InputBox(box) {
		t.Error("the input box was not seen on a pane showing one")
	}
	menu := []string{
		"Do you want to make this edit?",
		"❯ 1. Yes",
		"  2. No",
	}
	if InputBox(menu) {
		t.Error("a menu pointer was read as the input box")
	}
	if InputBox([]string{"building...", "done in 2.3s"}) {
		t.Error("plain output was read as the input box")
	}
	// Where it starts is what a reader of the pane needs: below that line there is
	// no output left, only the rest of the box and the status lines under it.
	if got := InputBoxAt(box); got != 1 {
		t.Errorf("InputBoxAt = %d, want the line the ❯ is on", got)
	}
	if got := InputBoxAt(menu); got != -1 {
		t.Errorf("InputBoxAt = %d on a pane with no box", got)
	}
}
