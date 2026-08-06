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
	// Agents is how many subagents the session's own list shows — see ReadAgents.
	// Not part of Total: a subagent is somebody else's turn rather than a command
	// left running, and the tab draws it in its own place.
	Agents int
}

// Total is how many things are running, whatever kind.
func (b Background) Total() int { return b.Shells + b.Monitors }

// One count in the footer: "1 shell", "2 monitors".
var backgroundItem = regexp.MustCompile(`(?i)(\d{1,3})\s+(shells?|monitors?)\b`)

// Agents is the block Claude Code draws under its status lines while it has
// subagents: `● main` for itself, then one line per subagent — its type, what it
// was given to do, how long it has been at it. The head of the block is what
// anchors it; the circles are what get counted.
//
// Counted rather than summed with the shells and monitors because it is a
// different kind of thing: a shell is a command left running, a subagent is
// somebody else's whole turn. And it is drawn one head per agent rather than a
// number, so the strip says how many without being read.
//
// What it claims is exactly what the agent's own list claims — the same rule the
// shells and monitors badge goes by. An agent that has finished but has not been
// collected is still on that list, and this counts it: the honest statement is
// "the session lists this many", not "this many are running".
var agentLine = regexp.MustCompile(`^\s*[◯○⭘]\s+\S`)

// The block always opens with the main agent, and that is what tells it from a
// stray circle in output.
var agentHead = regexp.MustCompile(`^\s*●\s+main\s*$`)

// How far up from the bottom the agents block can reach: its own head, a line
// per agent, and the status lines under which it is drawn.
const agentLines = 12

// ReadAgents counts the subagents the session's own footer lists.
func ReadAgents(lines []string) int {
	seen, n, anchored := 0, 0, false
	for i := len(lines) - 1; i >= 0 && seen < agentLines; i-- {
		line := strings.TrimRight(ansi.ReplaceAllString(lines[i], ""), " ")
		if strings.TrimSpace(line) == "" {
			continue
		}
		seen++
		if agentHead.MatchString(line) {
			anchored = true
			break
		}
		if agentLine.MatchString(line) {
			n++
		}
	}
	if !anchored {
		return 0
	}
	return n
}

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
		// The agents block sits below the status lines and can be as tall as the
		// session has subagents. It is footer either way, so it is stepped over
		// rather than counted: with three of them on screen the line saying "1
		// shell, 2 monitors" fell out of the window and the plates went away while
		// the shell was still running.
		if agentHead.MatchString(line) || agentLine.MatchString(line) {
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
