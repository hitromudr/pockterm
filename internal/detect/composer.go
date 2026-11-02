package detect

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

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
//
// Gemini CLI draws its prompt indented by one space (` > `, ` * `, ` ! `)
// directly under a full-width top border (`─` or `▄`) and closes the box with a
// matching bottom border (`─` or `▀`) of the same width.
var (
	composerPrompt = regexp.MustCompile("^\\s*❯\\x{00a0}")
	geminiPrompt   = regexp.MustCompile("^[ \t][>*!] ")
	composerTop    = regexp.MustCompile("^[ \t]*(?:[─━═]{3,}|▄{3,})[ \t]*$")
	composerBottom = regexp.MustCompile("^[ \t]*(?:[─━═]{3,}|▀{3,})[ \t]*$")
)

func geminiBoxAt(plain []string, i int) bool {
	if i <= 0 || !geminiPrompt.MatchString(plain[i]) || !composerTop.MatchString(plain[i-1]) {
		return false
	}
	w := utf8.RuneCountInString(strings.TrimSpace(plain[i-1]))
	stop := i + 10
	if stop >= len(plain) {
		stop = len(plain) - 1
	}
	for j := i + 1; j <= stop; j++ {
		if composerBottom.MatchString(plain[j]) && utf8.RuneCountInString(strings.TrimSpace(plain[j])) == w {
			return true
		}
	}
	return false
}

func geminiChromeAt(plain []string, i int) int {
	w := utf8.RuneCountInString(strings.TrimSpace(plain[i-1]))
	for k := max(0, i-5); k < i-1; k++ {
		if composerTop.MatchString(plain[k]) && utf8.RuneCountInString(strings.TrimSpace(plain[k])) == w {
			return k
		}
	}
	return i - 1
}

// InputBox reports whether the agent's own input box is on screen.
//
// It is the answer to "does this pane belong to an agent that reports its
// turns": the box and the counter are drawn by the same TUI, so a pane showing
// the box and no counter is a pane with no turn running. Without it the only
// evidence of work in such a session is the screen changing — and the change a
// person makes most often is typing their next message into that very box.
func InputBox(lines []string) bool { return InputBoxAt(lines) >= 0 }

// InputBoxAt says where that box begins, or -1 when there is none.
//
// It is the bottom of the TUI, so the line it starts on is also where the pane
// stops being the agent's output: below it are the rest of what is being typed,
// the rules around it and the status lines. Anything reading the screen for
// something the agent *said* has to stop there — see watch.Tail, which did not
// and sent the reply Claude had suggested to the phone instead.
func InputBoxAt(lines []string) int {
	plain := make([]string, len(lines))
	for i, l := range lines {
		plain[i] = ansi.ReplaceAllString(l, "")
	}
	for i, l := range plain {
		if composerPrompt.MatchString(l) {
			return i
		}
		if geminiBoxAt(plain, i) {
			return geminiChromeAt(plain, i)
		}
	}
	return -1
}
