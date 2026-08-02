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

// Question reports the menu on screen, or nil. A menu is a run of adjacent
// lines numbered 1,2,3,… (no gaps, nothing in between) carrying TUI chrome.
// The lowest such run wins: when a real prompt follows earlier output, the
// prompt is the live one.
func Question(lines []string) *Menu {
	plain := make([]string, len(lines))
	for i, l := range lines {
		plain[i] = ansi.ReplaceAllString(l, "")
	}

	type run struct {
		start  int
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
		hasChrome := m != nil && (chrome.MatchString(m[1]) || rightBorder.MatchString(line))
		// Continues the run only if this line sits right below the previous
		// option and carries the next number.
		if m != nil && cur != nil && i == cur.start+len(cur.opts) && m[2] == strconv.Itoa(len(cur.opts)+1) {
			cur.opts = append(cur.opts, Option{Key: m[2], Label: label(m[3])})
			cur.chrome = cur.chrome || hasChrome
			continue
		}
		// Anything else ends the current run; a "1." line starts a new one.
		closeRun()
		if m != nil && m[2] == "1" {
			cur = &run{start: i, opts: []Option{{Key: "1", Label: label(m[3])}}, chrome: hasChrome}
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
