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
	gemini := []string{
		"✦ Готово.",
		"─────────────────────────────────────────────────────────",
		" YOLO Ctrl+Y",
		"",
		"─────────────────────────────────────────────────────────",
		" *   Жду результата",
		"─────────────────────────────────────────────────────────",
		" 12%   ·   gemini-4-argon   ·    ~/work/anabasis   ·   …",
	}
	if !InputBox(gemini) {
		t.Error("the Gemini input box was not seen on a pane showing one")
	}
	if got := InputBoxAt(gemini); got != 1 {
		t.Errorf("InputBoxAt(gemini) = %d, want 1", got)
	}
}

// opencode 2.3, off Sanya's server on 2026-11-15: a column of `┃` closed by
// `╹▀▀▀`, the box starting on the first `┃`.
func TestInputBoxOpencode(t *testing.T) {
	box := []string{
		"     Build · DeepSeek V4.1 Flash 1017 · 3.5s · 136.4 tok/s · 2.4s ttft",
		"",
		"  ┃",
		"  ┃  проверь",
		"  ┃  Build · DeepSeek V4.1 Flash 1017 DeepSeek · max",
		"  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
		"  ~/admin           7.1K (1%) · $0.00  ctrl+p commands    ~/admin",
	}
	if got := InputBoxAt(box); got != 2 {
		t.Errorf("InputBoxAt(opencode) = %d, want 2", got)
	}
	// A quoted bar with nothing closing it is somebody's text, not the box.
	if InputBox([]string{"  ┃ цитата", "  ┃ дальше", "обычный текст"}) {
		t.Error("an unclosed column of bars was read as the opencode box")
	}
}
