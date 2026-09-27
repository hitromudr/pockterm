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
	// Workflows is how many dynamic workflows the same list shows. Counted apart
	// from the agents because one workflow is a whole orchestration — dozens of
	// subagents across phases — and a head apiece would say it is one of them.
	Workflows int
}

// Total is how many things are running, whatever kind.
func (b Background) Total() int { return b.Shells + b.Monitors }

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

// A count the line ends on with nothing left to name it by, and it is the
// monitors. Anchored to the ", " the footer separates its counted items with,
// which is what makes the kind knowable: the agent writes one phrase per group
// and groups by kind, so the only comma in that line is the one inside "N
// shells, M monitors" — shells and monitors are one kind of task to it (a
// command left running, with a flag for the ones that watch), and every other
// kind prints alone ("2 teams", "1 MCP task", "3 cloud sessions"), a mixture of
// kinds collapsing to "N background tasks" with no comma at all. Read off the
// binary 20.09.2026, version 2.1.278.
//
// So it is the pair that is being read here, and the second half of that pair is
// the monitors. The optional letters are the case where a stump too short to
// name survived the cut ("3 shells, 3 mo"): after the comma it is the monitors
// as well, and the three-letter floor below is for a count standing on its own,
// where position says nothing and the word is all there is.
//
// What this rests on is the shape of that line rather than its words, and the
// shape is the agent's: a release that counted another kind alongside the shells
// would make this plate claim a kind the session never named, and nothing here
// would notice.
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
//
// The pointer in front is the footer's own selection (← for agents, then the
// arrows): the row it stands on keeps its circle, and dropping out of the count
// while it is looked at would make the tab blink under the owner's thumb.
var agentLine = regexp.MustCompile(`^\s*(?:❯\s+)?[◯○⭘]\s+\S`)

// The block always opens with the main agent, and that is what tells it from a
// stray circle in output.
var agentHead = regexp.MustCompile(`^\s*●\s+main\s*$`)

// A dynamic workflow's row in the same block, below the subagents: the same
// circle, its name, then a progress bar of pills — `◯ audit-wave-a  ▱▱▱▱▱▱  ↓
// 678.0k`. The bar is what tells it from a subagent's row, which has an elapsed
// time where this has the bar, and it is drawn on every width: the agent picks
// 20, 12 or 8 pills and gives up the counts beside it before it gives up the
// bar. `█░` is the same bar on a terminal the agent believes bleeds geometric
// shapes. A workflow paused on a rate limit trades its circle for ⏸ and its bar
// for the wait, and ⏸ is drawn in that list for nothing else.
//
// There is no head of its own: with no subagents the block is these rows and
// nothing above them, which is why a session running only workflows grew no
// heads at all while `● main` was the anchor. The bar anchors them instead, and
// only a run of them at the very bottom counts — the block is the last thing the
// agent draws, and the workflows are the last thing in the block. Read off the
// binary 27.09.2026, version 2.1.283 (the row is `VN`, the bar `qv` with variant
// "pill").
var workflowLine = regexp.MustCompile(`^\s*(?:❯\s+)?(?:[◯○⭘]\s+\S.*(?:[▰▱]{3,}|[█░]{3,})|⏸\s+\S)`)

// How far up from the bottom the agents block can reach: its own head, a line
// per agent, and the status lines under which it is drawn. The workflows'
// rows are not counted against it — they are recognised by their own shape.
const agentLines = 12

// ReadAgents counts the subagents and the dynamic workflows the session's own
// footer lists.
func ReadAgents(lines []string) (agents, workflows int) {
	seen, anchored, bottom := 0, false, true
	for i := len(lines) - 1; i >= 0 && seen < agentLines; i-- {
		line := strings.TrimRight(ansi.ReplaceAllString(lines[i], ""), " ")
		if strings.TrimSpace(line) == "" {
			continue
		}
		if bottom && workflowLine.MatchString(line) {
			workflows++
			continue
		}
		bottom = false
		seen++
		if agentHead.MatchString(line) {
			anchored = true
			break
		}
		if agentLine.MatchString(line) {
			agents++
		}
	}
	if !anchored {
		agents = 0
	}
	return agents, workflows
}

// taskLine is a row of that block, of either kind.
func taskLine(line string) bool {
	return agentHead.MatchString(line) || agentLine.MatchString(line) || workflowLine.MatchString(line)
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
		if taskLine(line) {
			continue
		}
		seen++
		if strings.Contains(strings.ToLower(line), "still running") {
			continue
		}
		var bg Background
		read := false
		named := -1
		for _, g := range backgroundItem.FindAllStringSubmatchIndex(line, -1) {
			n, err := strconv.Atoi(line[g[2]:g[3]])
			if err != nil {
				continue
			}
			atEnd := clipTail.MatchString(line[g[5]:])
			kind, ok := backgroundKind(line[g[4]:g[5]], atEnd)
			if !ok {
				// A word that names neither kind gets no plate of its own. The footer
				// counts more kinds than these two — teams, MCP tasks, cloud sessions
				// — and each of them prints alone, so a number beside one of their
				// words is a count of something this strip does not draw. What is
				// left of such a word when the width cuts it is covered below, where
				// the comma says which kind it was.
				continue
			}
			if kind == "shells" {
				bg.Shells += n
			} else {
				bg.Monitors += n
			}
			named = g[5]
			read = true
		}
		// And the item cut off before its word got to start at all: at 48 columns
		// "3 shells, 3 monitors · ← for agents" arrives as "3 shells, 3", and the
		// monitors' plate had nothing left to read. The comma is what names it —
		// see backgroundCut. Skipped where it overlaps an item already counted,
		// which is the whole word arriving intact.
		if g := backgroundCut.FindStringSubmatchIndex(line); g != nil && g[0] >= named {
			if n, err := strconv.Atoi(line[g[2]:g[3]]); err == nil {
				bg.Monitors += n
			}
		}
		// A count of something else is not this line answering nothing: "Read 1
		// file" has the shape and names neither kind, so the search goes on up
		// instead of returning empty from it.
		if !read {
			continue
		}
		return bg
	}
	return Background{}
}
