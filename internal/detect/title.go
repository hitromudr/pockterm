package detect

import "strings"

// TitleLive reports whether the pane's title says a turn is running.
//
// Gemini CLI keeps no counter on screen the way Claude Code does: while a tool
// runs — a build, a script — its screen is a box with the command in it and
// nothing that moves, so the silence rule called the turn over thirty seconds
// in and the tab went green with the work still going. What it does keep is the
// terminal's title, set on every change of state and led by a glyph:
//
//	✦  Working… (Vita)            streaming, or thinking
//	⏲  Working… (Vita)            a tool running with nothing to show
//	✋  Action Required (Vita)     waiting for a confirmation
//	◇  Ready (Vita)               idle
//
// Measured on Gemini CLI 0.66.0, read out of its own bundle
// (packages/cli/src/utils/windowTitle.ts) and off a live pane. The glyph is the
// whole rule — the words after it are a thought's subject while it thinks, so
// they are nobody's vocabulary to match.
//
// **Only ◇ ends a turn.** ✋ was read as the end too, for one deploy: it is also
// what Gemini raises when a running command has printed something and then gone
// quiet for a while (useShellInactivityStatus — a guess that the shell wants
// input), and a build doing exactly that sent "закончил" twice in forty seconds,
// flipping back to ✦ in between. The title cannot tell that guess from a real
// confirmation, and in both the turn is still open. The cost is a confirmation
// asked outside YOLO going unannounced — a tab that stays purple — against a
// notice that says the opposite of what is true.
//
// The title outlives the program in tmux. Gemini clears it on its way out, so
// a title left standing takes a process killed outright — and then the tab
// stays purple, the cheap side of being wrong.
func TitleLive(title string) bool {
	t := strings.TrimLeft(title, " ")
	return strings.HasPrefix(t, "✦") || strings.HasPrefix(t, "⏲") || strings.HasPrefix(t, "✋")
}
