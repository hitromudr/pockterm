package detect

import "regexp"

// The composer is the agent's own input box: the line you type into, drawn at
// the bottom of the pane between two rules. Claude Code marks it with the same
// ❯ it points at a menu's highlighted option with — and that collision is what
// put answer buttons under a numbered list nobody had sent yet.
//
// What tells the two apart is the space after the glyph. The composer draws a
// non-breaking one (U+00A0); a menu pointer draws an ordinary one. Measured on
// v2.1.222 off both panes at 51 columns — the input box while a list was being
// typed into it, and the /model dialog — rather than assumed, because the whole
// rule rests on it.
//
// Written as an escape and not as the character: a non-breaking space is
// invisible in the source, and being that one is the entire rule.
var composerPrompt = regexp.MustCompile("^\\s*❯\\x{00a0}")

// InputBox reports whether the agent's own input box is on screen.
//
// It is the answer to "does this pane belong to an agent that reports its
// turns": the box and the counter are drawn by the same TUI, so a pane showing
// the box and no counter is a pane with no turn running. Without it the only
// evidence of work in such a session is the screen changing — and the change a
// person makes most often is typing their next message into that very box.
func InputBox(lines []string) bool {
	for _, l := range lines {
		if composerPrompt.MatchString(ansi.ReplaceAllString(l, "")) {
			return true
		}
	}
	return false
}
