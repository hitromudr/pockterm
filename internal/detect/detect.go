// Package detect finds an interactive numbered menu (a Claude Code
// permission prompt and friends) in the visible lines of a terminal.
//
// It is a port of web/js/detect.js: the browser needs the verdict to draw
// answer buttons, the notifier needs it to say "asks for an answer", and
// neither can call the other. Both run against test/fixtures/menus.json so
// the two copies cannot drift apart quietly.
package detect

import (
	"regexp"
	"strconv"
	"strings"
)

// option is a menu line: optional pointer/box glyphs, a number, a
// separator, then a label. Matches "❯ 1. Yes", "  2) No", "│ 3. …".
var option = regexp.MustCompile(`^([\s│>❯›*-]*)(\d{1,2})[.):]\s+(\S.*?)\s*$`)

// TUI chrome: the pointer at the highlighted option, or the box the prompt
// is drawn in. A numbered list in prose has neither, and that list is the
// false positive worth killing.
var (
	chrome      = regexp.MustCompile(`[>❯›│]`)
	rightBorder = regexp.MustCompile(`│\s*$`)
	ansi        = regexp.MustCompile("\x1b\\[[0-9;?]*[ -/]*[@-~]")
	boxGlyphs   = regexp.MustCompile(`[│╭╮╰╯─]`)
)

// Option is one answer: the digit to send and what it says.
type Option struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

// Menu is a detected prompt with its answers.
type Menu struct {
	Prompt  string
	Options []Option
}

// Question reports the menu on screen, or nil. A menu is a run of lines
// numbered 1,2,3,… in order, carrying TUI chrome, with nothing between them but
// each option's own continuation. The lowest such run wins: when a real prompt
// follows earlier output, the prompt is the live one.
//
// The options used to have to be adjacent, and that was wrong for the menu the
// page needs most. A question with a description under each option — what
// AskUserQuestion draws — puts two or three lines between the numbers, so the
// run broke at the first option and no menu was found at all: no answer
// buttons, no blue tab, no notification, for the one prompt that is always
// worth answering. Reported from a phone looking at a menu the page said
// nothing about.
func Question(lines []string) *Menu {
	plain := make([]string, len(lines))
	for i, l := range lines {
		plain[i] = ansi.ReplaceAllString(l, "")
	}

	type run struct {
		start  int
		last   int // where the last option was found; the gap is measured from it
		indent int // the column the numbers sit in, which continuations sit past
		opts   []Option
		chrome bool
	}
	var best, cur *run
	closeRun := func() {
		if cur != nil && len(cur.opts) >= 2 && cur.chrome {
			best = cur
		}
		cur = nil
	}
	for i, line := range plain {
		m := option.FindStringSubmatch(line)
		// Not a numbered line: it may still belong to the option above, so the
		// run is left open and the next number is what decides. Closing here is
		// what made a description under an option end the menu.
		if m == nil {
			continue
		}
		hasChrome := chrome.MatchString(m[1]) || rightBorder.MatchString(line)
		// Continues the run if this line carries the next number and everything
		// between it and the previous option belongs to that option.
		if cur != nil && m[2] == strconv.Itoa(len(cur.opts)+1) && continues(plain[cur.last+1:i], cur.indent) {
			cur.opts = append(cur.opts, Option{Key: m[2], Label: label(m[3])})
			cur.chrome = cur.chrome || hasChrome
			cur.last = i
			continue
		}
		// A number out of turn ends the current run; a "1." starts a new one.
		closeRun()
		if m[2] == "1" {
			cur = &run{start: i, last: i, indent: indentOf(line),
				opts: []Option{{Key: "1", Label: label(m[3])}}, chrome: hasChrome}
		}
	}
	closeRun()
	if best == nil {
		return nil
	}

	// Prompt: nearest non-empty line just above the first option.
	prompt := ""
	for i := best.start - 1; i >= 0 && i > best.start-6; i-- {
		if t := strings.TrimSpace(boxGlyphs.ReplaceAllString(plain[i], "")); t != "" {
			prompt = t
			break
		}
	}
	return &Menu{Prompt: prompt, Options: best.opts}
}

// label drops the box's right border and its padding.
func label(s string) string {
	return strings.TrimSpace(rightBorder.ReplaceAllString(s, ""))
}

// continues reports whether every line between two options belongs to the
// first one — a description wrapped under it, a blank, or a rule drawn across
// the menu.
//
// Indentation is what tells a description from a paragraph, and it is the whole
// defence against reading prose as a menu: an option's own continuation is set
// past the column its number sits in, while a numbered list in prose has its
// text back at the margin. That, and each line the run swallows must not itself
// be a numbered option — 1, 5, 2 is not a menu whatever the indentation says.
func continues(between []string, indent int) bool {
	for _, line := range between {
		// A rule or an empty box row is chrome, not content: AskUserQuestion
		// draws one between its answers and the "chat about this" way out, and a
		// boxed prompt pads its options with "│      │".
		if strings.TrimSpace(boxGlyphs.ReplaceAllString(line, "")) == "" {
			continue
		}
		if option.MatchString(line) {
			return false
		}
		if indentOf(line) <= indent {
			return false
		}
	}
	return true
}

// indentOf is the column of the first character that is neither space nor the
// chrome a TUI draws down the left edge — the box's border and the pointer at
// the highlighted option. Measured past those so a boxed menu's descriptions
// still read as deeper than its options: in "│ ❯ 1. Yes" the number sits at 4,
// and "│     more about it" starts at 6.
//
// In columns and not in bytes. The descriptions this exists to recognise are
// written in whatever language the prompt is, and one Cyrillic letter is two
// bytes to a box glyph's three — comparing byte offsets made a description look
// shallower than the option above it.
func indentOf(line string) int {
	col := 0
	for _, r := range line {
		switch r {
		case ' ', '\t', '│', '>', '❯', '›':
			col++
		default:
			return col
		}
	}
	return col
}
