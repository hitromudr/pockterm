package watch

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"

	"github.com/hitromudr/pockterm/internal/detect"
)

// Screen text goes to an outside service, so what leaves is bounded: a few
// menu options, one line for a finished run, nothing very long.
const (
	maxOptions  = 8
	maxLineLen  = 200
	promptLabel = "❓ %s просит ответ"
	doneLabel   = "✅ %s закончил"
)

// Format renders an event as the message body. With preview off only the
// fact and the session name are sent — nothing read off the screen.
func Format(e Event, link string, preview bool) string {
	var b strings.Builder
	if e.Kind == Question {
		fmt.Fprintf(&b, promptLabel, e.Session)
	} else {
		fmt.Fprintf(&b, doneLabel, e.Session)
	}
	if preview {
		if p := clip(e.Prompt); p != "" {
			b.WriteString("\n" + p)
		}
		for i, o := range e.Options {
			if i == maxOptions {
				fmt.Fprintf(&b, "\n… ещё %d", len(e.Options)-maxOptions)
				break
			}
			b.WriteString("\n" + clip(o.Key+". "+o.Label))
		}
	}
	if link != "" {
		b.WriteString("\n\n" + link)
	}
	return b.String()
}

// Notice renders the same event for a notification on the phone: a title
// that says which session and what happened, and a body worth reading in the
// two lines Android shows collapsed.
//
// It exists next to Format so both channels say the same thing in the same
// words. Only the shape differs — Telegram gets one message, a notification
// has a title of its own.
func Notice(e Event) (title, body string) {
	if e.Kind == Question {
		title = fmt.Sprintf(promptLabel, e.Session)
		lines := make([]string, 0, maxOptions+1)
		if p := clip(e.Prompt); p != "" {
			lines = append(lines, p)
		}
		for i, o := range e.Options {
			if i == maxOptions {
				lines = append(lines, fmt.Sprintf("… ещё %d", len(e.Options)-maxOptions))
				break
			}
			lines = append(lines, clip(o.Key+". "+o.Label))
		}
		return title, strings.Join(lines, "\n")
	}
	title = fmt.Sprintf(doneLabel, e.Session)
	if p := clip(e.Prompt); p != "" {
		return title, p
	}
	return title, "Вывод остановился"
}

// The mark an agent puts on its own lines, and the shape of the ones that name a
// tool rather than say anything:
//
//	● Конфиг валиден. Предупреждение doctor про websocket — следствие песочницы.
//	● Bash(cd /home/dms/work && for d in bricks devops; do …)
//
// The marker itself is stripped: it is the TUI's, not part of the sentence.
var (
	agentSaid = regexp.MustCompile(`^\s*●\s*(.*)$`)
	toolCall  = regexp.MustCompile(`^\p{Lu}[\p{L}\d_]*\(`)
)

// Tail picks the line of a pane worth showing a human.
//
// **The agent's own last sentence, wherever on screen it is.** Its lines are
// marked, and what sits under the last of them is the output of whatever it ran —
// which is how "pockterm закончил" reached the phone with `{"name":"devops",` as
// its entire body: a fragment of a curl the agent had just made, honestly the last
// line on screen and worth nothing to read. A named tool call is skipped for the
// same reason: `● Bash(…)` is the agent pointing at a command, not speaking.
//
// Reading up from the bottom is the fallback, for a pane with no such marker in
// it at all — a shell, or an agent this does not recognise. "The last non-blank
// line" is not it either: the agents this serves draw a framed input box at the
// bottom, so the honest last line is a row of box-drawing characters and the one
// above it is a hint about keyboard shortcuts. The first notification that ever
// reached the owner's phone said `[pockterm-<agent>] ✳ … 09:15 03-Aug-26` — the
// tmux status line, which is what the *browser* saw.
//
// Heuristic on purpose: this is decoration, and a wrong guess costs a less
// informative notification, not a wrong one.
func Tail(lines []string) string {
	for i := len(lines) - 1; i >= 0; i-- {
		m := agentSaid.FindStringSubmatch(ansi.ReplaceAllString(lines[i], ""))
		if m == nil {
			continue
		}
		s := strings.TrimSpace(m[1])
		// `● Bash(…)` is the agent naming a command, not saying anything.
		if s == "" || !hasWord(s) || toolCall.MatchString(s) || isChrome(s) {
			continue
		}
		return s + wrapped(lines, i)
	}
	for i := len(lines) - 1; i >= 0; i-- {
		s := strings.TrimSpace(strings.Trim(strings.TrimSpace(lines[i]), boxRunes))
		if s == "" || !hasWord(s) || isChrome(s) {
			continue
		}
		return s
	}
	return ""
}

// wrapped collects what the pane broke off the end of the sentence at line i.
//
// A pane is as wide as the narrowest client attached to it, and this page attaches
// phones: the session the notice below was read from was 51 columns, so
//
//	● API Error: 529 Overloaded. This is a
//	  server-side issue, usually temporary —
//	  try again in a moment. If it persists,
//	  check https://status.claude.com.
//
// reached the phone as its first line and nothing else — a body that stops
// mid-clause, and reported as the notifications being cut off. The same message in
// a session last attached from a laptop arrived whole, which is the tell: the
// wrapping is the pane's, not the agent's, so the marker is on the first line only
// and the rest is a continuation indented under it.
//
// It ends where the paragraph does: a blank line, a line no longer indented past
// the marker, another `●`, a tool result (`⎿`), or anything the rest of this file
// already knows to be interface. Long enough is enough, too — `clip` caps a body at
// maxLineLen anyway, and a notification is not the place to read an essay.
func wrapped(lines []string, i int) string {
	var b strings.Builder
	markerAt := indentOf(lines[i])
	for j := i + 1; j < len(lines) && b.Len() < maxLineLen; j++ {
		l := ansi.ReplaceAllString(lines[j], "")
		s := strings.TrimSpace(l)
		if s == "" || indentOf(l) <= markerAt || agentSaid.MatchString(l) {
			break
		}
		// `⎿` opens what a tool answered, which is the agent pointing at output
		// rather than speaking — the same rule as `● Bash(…)`, one line lower.
		if strings.HasPrefix(s, "⎿") || isChrome(s) || !hasWord(s) {
			break
		}
		b.WriteString(" ")
		b.WriteString(s)
	}
	return b.String()
}

// How far a line is indented, in runes. The continuation of a marked line sits
// under its text, so anything at or left of the marker is a different line
// altogether.
func indentOf(s string) int {
	n := 0
	for _, r := range s {
		if r != ' ' && r != '\t' {
			break
		}
		n++
	}
	return n
}

// ANSI escapes reach here when a pane is captured with them; the marker is at the
// start of the line and a colour sequence in front of it would hide it.
var ansi = regexp.MustCompile("\x1b\\[[0-9;?]*[ -/]*[@-~]")

// The frame characters the TUI boxes are drawn with, plus the bullets used
// as list markers on an otherwise empty line.
const boxRunes = "─│┌┐└┘├┤┬┴┼╭╮╰╯━┃╔╗╚╝║═▁▔▏▕█▌▐ ⠀·•*"

// A line has to carry a letter or a digit to be worth reading.
func hasWord(s string) bool {
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return true
		}
	}
	return false
}

// Lines that are part of the interface rather than of the work. The list is
// short and specific: everything here was seen sitting at the bottom of a
// real pane, under the last thing the agent actually said.
var chrome = []string{
	"? for shortcuts",
	"esc to interrupt",
	"ctrl+c to exit",
	"auto-accept edits on",
	"auto-accept edits off",
	"bypass permissions",
	"plan mode on",
	"context left until auto-compact",
}

// The agent's status line, which is the interface at its most convincing: it is
// full of words and none of them is about the work.
//
//	ctx 71% | dms@ai:~/work/exante (main) $ | Opus 5 (1M context)
//
// It arrived in a notification on the owner's phone as the entire body of "exante
// закончил" — a message saying how much context was left and in which directory,
// where the agent's own last sentence should have been. Matched by its shape
// rather than by a phrase, because everything in it changes but the shape.
var statusLine = regexp.MustCompile(`^ctx\s+\d+%\s*\|`)

// And the line an agent leaves where its turn was: the same verb it was counting
// under, in the past tense.
//
//	✻ Cooked for 19s · 1 shell, 1 monitor still running
//	✻ Sautéed for 18s
//
// True, and no use as the body of a notice whose title already says the session
// finished. What is wanted under that title is the last thing the agent said, and
// this line sits between the two. The verbs turn over between releases, so what is
// matched is "<one word> for <a duration>".
var turnSummary = regexp.MustCompile(`^\P{L}*\p{L}+\s+for\s+\d+[hms]`)

func isChrome(s string) bool {
	l := strings.ToLower(s)
	// The prompt line of an empty input box: a caret and nothing else.
	if l == ">" || l == "> " || strings.TrimLeft(l, "> ") == "" {
		return true
	}
	if statusLine.MatchString(l) || turnSummary.MatchString(s) {
		return true
	}
	// The live counter. It should never be the body of a notice at all — a session
	// that is counting has not finished — but it arrived as one, and the belt is
	// cheap: this line is the interface either way.
	if detect.Live([]string{s}) {
		return true
	}
	// A named tool call, so that the fallback path refuses it as well as the first
	// one: with nothing but `● Read(…)` on screen the honest body is none, which
	// Notice turns into "Вывод остановился" rather than a filename.
	if m := agentSaid.FindStringSubmatch(s); m != nil && toolCall.MatchString(strings.TrimSpace(m[1])) {
		return true
	}
	for _, c := range chrome {
		if strings.Contains(l, c) {
			return true
		}
	}
	return false
}

func clip(s string) string {
	s = strings.TrimSpace(s)
	if len(s) <= maxLineLen {
		return s
	}
	// Cut on a rune boundary: the labels are often Russian.
	r := []rune(s)
	if len(r) <= maxLineLen {
		return s
	}
	return string(r[:maxLineLen]) + "…"
}
