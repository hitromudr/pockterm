package watch

import (
	"fmt"
	"strings"
	"unicode"
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

// Tail picks the last line of a pane worth showing a human.
//
// "The last non-blank line" is not it: the agents this serves draw a framed
// input box at the bottom, so the honest last line is a row of box-drawing
// characters, and the one above it is a hint about keyboard shortcuts. The
// first notification that reached the owner's phone said
// `[pockterm-<agent>] ✳ … 09:15 03-Aug-26` — the tmux status line, which is
// what the *browser* saw; capture-pane does not include it, but the box does
// come from the pane and had to be dealt with here.
//
// Heuristic on purpose: this is decoration, and a wrong guess costs a less
// informative notification, not a wrong one.
func Tail(lines []string) string {
	for i := len(lines) - 1; i >= 0; i-- {
		s := strings.TrimSpace(strings.Trim(strings.TrimSpace(lines[i]), boxRunes))
		if s == "" || !hasWord(s) || isChrome(s) {
			continue
		}
		return s
	}
	return ""
}

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

func isChrome(s string) bool {
	l := strings.ToLower(s)
	// The prompt line of an empty input box: a caret and nothing else.
	if l == ">" || l == "> " || strings.TrimLeft(l, "> ") == "" {
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
