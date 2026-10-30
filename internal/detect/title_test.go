package detect

import "testing"

// Titles as tmux hands them back (#{pane_title}): Gemini's padded to eighty
// columns, taken off a live pane on 2026-10-30 and out of Gemini CLI 0.66.0;
// Claude Code's and a shell's off the same machine, which must say nothing.
func TestTitleLive(t *testing.T) {
	for _, c := range []struct {
		title string
		want  bool
	}{
		{"✦  Working… (Vita)                                                              ", true},
		{"✦  Reading the build script (Vita)", true},
		{"⏲  Working… (Vita)", true},
		{"◇  Ready (Vita)", false},
		// Raised by a quiet running command as well as by a confirmation: the
		// turn is open in both (see TitleLive).
		{"✋  Action Required (Vita)", true},
		{"✳ Запуск Gemini 3.1 Pro через Pocketterm", false},
		{"ai", false},
		{"", false},
	} {
		if got := TitleLive(c.title); got != c.want {
			t.Errorf("TitleLive(%q) = %v, want %v", c.title, got, c.want)
		}
	}
}
