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
	// Other is a count the footer printed and did not get to name: the width of
	// the pane cut the item off before its word. It is not a third kind of thing
	// — it is the two above with the name eaten — and it exists because at the 48
	// columns a phone gives a shared window the line arrives as "3 shells, 3",
	// with "monitors" gone whole (captured off the owner's pane 13.09.2026). The
	// number is what the agent claims and the kind is what the width ate, so the
	// tab says "and this many more" rather than picking a kind for it.
	Other int
	// Agents is how many subagents the session's own list shows — see ReadAgents.
	// Not part of Total: a subagent is somebody else's turn rather than a command
	// left running, and the tab draws it in its own place.
	Agents int
}

// Total is how many things are running, whatever kind.
func (b Background) Total() int { return b.Shells + b.Monitors + b.Other }

// One count in the footer: "1 shell", "2 monitors" — and, at the end of a line
// the pane has cut short, however much of the word fitted.
//
// The word is matched loosely here and named afterwards (backgroundKind) rather
// than spelled out in the pattern, because the status line is clipped at the
// pane's width rather than wrapped: at the 48 columns a phone gives a shared
// window, "1 shell, 1 monitor · ← for agents" arrives as "1 shell, 1 monito",
// and a pattern that insists on the whole word drew the shell's plate and not
// the monitor's on every session that had both.
var backgroundItem = regexp.MustCompile(`(?i)(\d{1,3})\s+([a-z]{2,})`)

// The words the footer counts with. A whole word is one of these, singular or
// plural; a clipped one is a prefix of it.
var backgroundKinds = []string{"shells", "monitors"}

// What may stand between the last word and the end of the line and still leave
// it clipped: the ellipsis the agent puts where it cut something off.
var clipTail = regexp.MustCompile(`^\s*(\x{2026}|\.\.\.)?\s*$`)

// A count the line ends on with nothing left to name it by. Anchored to the
// ", " the footer separates its counted items with, so what is read is that list
// cut short rather than a line of prose that happens to end in a number; the
// optional letters are the case where a stump too short to name survived the cut
// ("3 shells, 3 mo").
var backgroundCut = regexp.MustCompile(`,\s*(\d{1,3})(?:\s+[a-z]{1,2})?\s*(?:\x{2026}|\.\.\.)?\s*$`)

// How much of a word it takes to name a kind. "she" and "mon" tell the two
// apart and tell them from what else a status line ends in; two letters would
// let "1 mo…" claim a monitor, and a plate drawn on a guess says something the
// session never claimed — so a shorter stump is read as nothing at all, which
// is the cheap failure here.
const backgroundStump = 3

// backgroundKind says which of the two counted words this one is, and it is the
// only thing that decides: the pattern above matches any word after a number.
//
// A whole word counts wherever it sits on the line. A word cut short counts only
// at the end of one, because the end is the only place the width can cut — a
// prefix in the middle of a line is prose that happens to start the same way.
func backgroundKind(word string, atEnd bool) (string, bool) {
	w := strings.ToLower(word)
	for _, kind := range backgroundKinds {
		if w == kind || w+"s" == kind {
			return kind, true
		}
		if atEnd && len(w) >= backgroundStump && strings.HasPrefix(kind, w) {
			return kind, true
		}
	}
	return "", false
}

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
		var bg Background
		read := false
		other, lastItem := 0, -1
		for _, g := range backgroundItem.FindAllStringSubmatchIndex(line, -1) {
			n, err := strconv.Atoi(line[g[2]:g[3]])
			if err != nil {
				continue
			}
			lastItem = g[5]
			atEnd := clipTail.MatchString(line[g[5]:])
			kind, ok := backgroundKind(line[g[4]:g[5]], atEnd)
			if !ok {
				// A count this line ends on and does not name: a stump too short to
				// tell "monitors" from "months", or a word the strip draws no plate
				// for. Kept as a number without a kind rather than dropped — what is
				// still running is the question, and "two more of something" answers
				// more of it than silence does. Only at the end of the line, which is
				// the only place the width can cut: a count in the middle of one is
				// prose, by the same rule the stump goes by.
				if atEnd {
					other += n
				}
				continue
			}
			if kind == "shells" {
				bg.Shells += n
			} else {
				bg.Monitors += n
			}
			read = true
		}
		// And the item cut off before its word got to start at all. The footer
		// separates its counts with ", ", so a bare number at the end of the line
		// is the next one with its name eaten: at 48 columns "3 shells, 3 monitors
		// · ← for agents" arrives as "3 shells, 3", and the monitors' plate had
		// nothing left to read. Skipped when it overlaps the last item, which is
		// the stump case above and already counted.
		if g := backgroundCut.FindStringSubmatchIndex(line); g != nil && g[0] >= lastItem {
			if n, err := strconv.Atoi(line[g[2]:g[3]]); err == nil {
				other += n
			}
		}
		// A count of something else is not this line answering nothing: "Read 1
		// file" has the shape and names neither kind, so the search goes on up
		// instead of returning empty from it.
		if !read {
			continue
		}
		bg.Other = other
		return bg
	}
	return Background{}
}
