package detect

import (
	"regexp"
	"strconv"
	"strings"
)

// Background is what an agent still has running while it says nothing: the
// shells and monitors Claude Code counts in its own footer ("1 shell, 1
// monitor"). A session can be quiet and still be doing work, and that is the
// case a tab could not tell apart — "gone quiet" and "gone quiet with two
// monitors still watching" painted the same green.
type Background struct {
	Shells   int
	Monitors int
}

// Total is how many things are running, whatever kind.
func (b Background) Total() int { return b.Shells + b.Monitors }

// One count in the footer: "1 shell", "2 monitors".
var backgroundItem = regexp.MustCompile(`(?i)(\d{1,3})\s+(shells?|monitors?)\b`)

// How far up from the bottom the live counter can sit. The footer is the last
// few lines of the pane — the status line, and sometimes a limit warning under
// it — and anything above that belongs to output that has already scrolled.
const footerLines = 4

// ReadBackground reads the counts off the bottom of the pane.
//
// Only the footer counts, and only the lowest line of it that carries a
// number: the same words appear in the line an agent prints when a turn ends
// ("Cogitated for 2m 23s · 1 shell, 1 monitor still running"), which was true
// when it was printed and says nothing about now. That line is skipped by its
// own wording, and the search stops at the first line with a count so an older
// footer scrolled just above the live one cannot add to it.
func ReadBackground(lines []string) Background {
	seen := 0
	for i := len(lines) - 1; i >= 0 && seen < footerLines; i-- {
		line := strings.TrimSpace(ansi.ReplaceAllString(lines[i], ""))
		if line == "" {
			continue
		}
		seen++
		if strings.Contains(strings.ToLower(line), "still running") {
			continue
		}
		m := backgroundItem.FindAllStringSubmatch(line, -1)
		if m == nil {
			continue
		}
		var bg Background
		for _, g := range m {
			n, err := strconv.Atoi(g[1])
			if err != nil {
				continue
			}
			if strings.HasPrefix(strings.ToLower(g[2]), "shell") {
				bg.Shells += n
			} else {
				bg.Monitors += n
			}
		}
		return bg
	}
	return Background{}
}
