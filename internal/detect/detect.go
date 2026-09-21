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
//
// The space after the separator is optional, and the label of a line without
// one has to begin with neither space nor digit. A menu drawn beside a preview
// column glues the number to the text — " 1.архитектура с" is what a 48-column
// pane shows, see previewColumn — and under the old rule such a line was not an
// option at all, so a three-option question came down to the one option drawn
// the ordinary way and no menu was found. The digit is what keeps "1.2.3" out:
// a version number is not an answer, and silence is the cheap failure there.
//
// The label comes back in one of two groups: the third when a space separates
// it, the fourth when nothing does. The fourth is also what says the widget has
// moved the number a line down — see widen.
var option = regexp.MustCompile(`^([\s│>❯›*-]*)(\d{1,2})[.):](?:\s+(\S.*?)|([^\s\d].*?))\s*$`)

// row is a line split into the chrome drawn down its left edge and its own
// words, which is how a wrapped label's continuation is read off a two-column
// menu.
var row = regexp.MustCompile(`^([\s│>❯›]*)(\S.*?)\s*$`)

// TUI chrome: the pointer at the highlighted option, or the box the prompt
// is drawn in. A numbered list in prose has neither, and that list is the
// false positive worth killing.
var (
	chrome      = regexp.MustCompile(`[>❯›│]`)
	rightBorder = regexp.MustCompile(`│\s*$`)
	ansi        = regexp.MustCompile("\x1b\\[[0-9;?]*[ -/]*[@-~]")
	boxGlyphs   = regexp.MustCompile(`[│╭╮╰╯─]`)
	// A rule drawn across the menu: a horizontal line and nothing else.
	// Deliberately blind to the border glyphs — a box's own edges are chrome
	// around a list, while this is a line through one.
	rule = regexp.MustCompile(`^[\s─]*─{3,}[\s─]*$`)
	// The checkbox a question that takes several answers draws after the
	// number: "1. [ ] Label", and "[✔]" once it has been chosen. Captured off a
	// real pane at 51 columns 2026-08-17 and shared with the fixtures. It comes
	// off the label because the label is what a notification reads out, and
	// because the page recognises the menu's own text field by its words.
	checkbox = regexp.MustCompile(`^\[(.?)\]\s+`)
	// The keys a menu says it takes, drawn under its options. This package
	// presses nothing and so does not read them; the line is recognised because
	// it ends the list of options, which is where a wrapped label stops.
	navigation = regexp.MustCompile(`(?i)(enter to select|to navigate)`)
	// The corners and tees of a box drawn beside the options — see
	// previewColumn. "│" is left out on purpose: a prompt drawn in a box has
	// one down both edges, and every boxed menu would look like this one.
	boxEdge   = regexp.MustCompile(`[┌└├┐┘┤]`)
	boxCorner = regexp.MustCompile(`[┌└]`)
)

// previewMinCol is how far in a second column has to start to be one: the
// answers themselves are drawn at the left margin.
const previewMinCol = 8

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

// run is a candidate list of options as it is being read off the screen.
type run struct {
	start  int
	last   int  // where the last option was found; the gap is measured from it
	indent int  // the column the numbers sit in, which continuations sit past
	flush  bool // ...unless the option carries a checkbox; see continues
	opts   []Option
	chrome bool
	at     []int  // the line each option was found on
	glued  []bool // ...and whether its number had the label glued to it
}

// previewColumn is the column a box drawn *beside* the options starts at, or -1.
// It is the whole of what tells the two-column menu from every other one.
//
// AskUserQuestion draws a preview next to its answers as soon as one option
// carries one, and on a phone that second column lands in the middle of every
// option line:
//
//	❯   Монолитная             ┌────────────┐
//	 1.архитектура с           │ Система    │
//
// Measured at 48 columns on 2026-09-21, Claude Code 2.1.241; the pane is in the
// shared fixtures. Three things follow and each one cost the answer row on the
// phone and the labels in a notification here: the number is glued to the text,
// the label's first words sit on the line above the number, and what a line says
// about indentation is about both columns at once. So the column is found once
// and every line is read with the preview taken off.
//
// Two lines have to agree on it, and it has to be past the column the answers
// are drawn in.
//
// **What is found has to be a column beside a list, not merely a box.** The agent
// prints trees, and tree draws "├──" and "└──" down a column of its own: nested
// three deep that column is past the margin, and a pane holding one above a real
// menu would have every line cut at it — the menu taken apart and the
// notification silent, which is the defect this reading exists to fix. So two of
// the lines the box is drawn against have to be options once it is taken off
// them. A tree has nothing but path names to its left.
func previewColumn(plain []string) int {
	type candidate struct {
		lines  int
		corner bool
	}
	corners := map[int]*candidate{}
	for _, line := range plain {
		cols := []rune(line)
		for c := previewMinCol; c < len(cols); c++ {
			if !boxEdge.MatchString(string(cols[c])) {
				continue
			}
			at := corners[c]
			if at == nil {
				at = &candidate{}
				corners[c] = at
			}
			at.lines++
			at.corner = at.corner || boxCorner.MatchString(string(cols[c]))
			break
		}
	}
	best := -1
	for col, at := range corners {
		if at.lines < 2 || !at.corner {
			continue
		}
		if best >= 0 && col > best {
			continue
		}
		options := 0
		for _, line := range plain {
			if besideBox(line, col) && option.MatchString(cutAt(line, col)) {
				options++
			}
		}
		if options >= 2 {
			best = col
		}
	}
	return best
}

// cutAt is one line with the preview column taken off.
func cutAt(line string, col int) string {
	if col < 0 {
		return line
	}
	cols := []rune(line)
	if len(cols) <= col {
		return line
	}
	return string(cols[:col])
}

// besideBox reports whether the preview box is drawn beside this line. That box
// is chrome in exactly the sense the right border is — a widget drew it, and
// prose draws no boxes — and without it a two-column menu carries no chrome at
// all: its pointer is on the line above the number it belongs to, so every
// option line looks like a sentence beginning with a figure.
func besideBox(line string, col int) bool {
	if col < 0 {
		return false
	}
	cols := []rune(line)
	for c := col; c < len(cols); c++ {
		if cols[c] == '│' || boxEdge.MatchString(string(cols[c])) {
			return true
		}
	}
	return false
}

// widen reads a two-column menu back as the list it is: the labels wrap, and
// where a number is glued to its text the widget has pushed it one line down, so
// the label begins on the line above and that line belongs to this option rather
// than to the one before it.
//
// Taking the number's own line alone made two of three options read
// "архитектура с" — one option's words against another option's answer, which is
// the worst shape a mistake has here: a notification that names the wrong answer
// reads exactly like one that names the right one. Checked against the strings
// the tool was called with: what this rebuilds is what went into
// AskUserQuestion, character for character.
//
// The page reads one more thing off the same shape — the pointer, which travels
// with those first words rather than with the number (web/js/detect.js, widen).
// This package presses nothing, so it reads only the labels.
func widen(rows []string, r *run) {
	begin := func(j int) int {
		i := r.at[j]
		if !r.glued[j] || i == 0 || strings.TrimSpace(rows[i-1]) == "" {
			return i
		}
		return i - 1
	}
	words := func(line string) string {
		m := row.FindStringSubmatch(line)
		if m == nil {
			return ""
		}
		return label(m[2])
	}
	for j := range r.at {
		first := begin(j)
		indent := indentOf(rows[r.at[j]])
		// Where this option's own lines stop: at the next option's first line, at
		// anything that is not a wrap, or at the end of the pane.
		stop := len(rows)
		if j+1 < len(r.at) {
			stop = begin(j + 1)
		}
		last := r.at[j]
		for k := r.at[j] + 1; k < stop; k++ {
			if strings.TrimSpace(rows[k]) == "" || rule.MatchString(rows[k]) ||
				navigation.MatchString(rows[k]) || option.MatchString(rows[k]) ||
				indentOf(rows[k]) <= indent {
				break
			}
			last = k
		}
		parts := make([]string, 0, last-first+1)
		for k := first; k <= last; k++ {
			text := words(rows[k])
			if k == r.at[j] {
				text = r.opts[j].Label
			}
			if text != "" {
				parts = append(parts, text)
			}
		}
		r.opts[j].Label = strings.Join(parts, " ")
		if j == 0 {
			r.start = first
		}
	}
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
	// A preview beside the answers is read off and set aside: what the menu says
	// about itself is in the left column, and the right one is another widget
	// whose borders and figures are not the list's. The prompt is still read off
	// the whole line — the question is drawn across both columns.
	pcol := previewColumn(plain)
	rows := plain
	if pcol >= 0 {
		rows = make([]string, len(plain))
		for i, l := range plain {
			rows[i] = cutAt(l, pcol)
		}
	}

	var best, cur *run
	closeRun := func() {
		if cur != nil && len(cur.opts) >= 2 && cur.chrome {
			best = cur
		}
		cur = nil
	}
	for i, line := range rows {
		m := option.FindStringSubmatch(line)
		// Not a numbered line: it may still belong to the option above, so the
		// run is left open and the next number is what decides. Closing here is
		// what made a description under an option end the menu.
		if m == nil {
			continue
		}
		// The agent's own input box carries the same ❯ a menu points with, and
		// what is under it is whatever is being typed — see composer.go for how
		// the two are told apart. A line from there brings no chrome, so a
		// numbered list in a half-written message is prose like any other.
		hasChrome := (chrome.MatchString(m[1]) || rightBorder.MatchString(line) ||
			besideBox(plain[i], pcol)) && !composerPrompt.MatchString(line)
		// The label, and whether anything separated it from its number.
		text, glued := m[3], false
		if m[4] != "" {
			text, glued = m[4], true
		}
		// Continues the run if this line carries the next number and everything
		// between it and the previous option belongs to that option. Counted from
		// the option before it rather than from the length of the run, because a
		// run no longer has to start at 1 — see below.
		if cur != nil && m[2] == nextKey(cur.opts) && continues(rows[cur.last+1:i], cur.indent, cur.flush) {
			shown, boxed := unbox(label(text))
			cur.opts = append(cur.opts, Option{Key: m[2], Label: shown})
			cur.at = append(cur.at, i)
			cur.glued = append(cur.glued, glued)
			cur.chrome = cur.chrome || hasChrome
			// Asked of the option the gap opens under, not of the run: what may
			// stand between two options is a fact about the one above them.
			cur.flush = boxed
			cur.last = i
			continue
		}
		// A number out of turn ends the current run, and any number starts a new
		// one — it does not have to be a 1.
		//
		// It had to be, and that left the tab neutral in front of a screen full of
		// question. AskUserQuestion scrolls its own list of options to keep the
		// pointer in view, so on a phone-width pane walking down to the fourth
		// answer pushes the first two off the top of the list, and what is left on
		// screen is a run beginning at "3.". What keeps prose out was never the
		// leading 1: it is the chrome a run is kept on, and the indentation rule in
		// continues. Both are untouched.
		closeRun()
		shown, boxed := unbox(label(text))
		cur = &run{start: i, last: i, indent: indentOf(line), flush: boxed,
			opts: []Option{{Key: m[2], Label: shown}}, chrome: hasChrome,
			at: []int{i}, glued: []bool{glued}}
	}
	closeRun()
	if best == nil {
		return nil
	}
	// A two-column menu is read back in full before anything is asked of it: its
	// labels wrap, and its numbers sit inside the wrap.
	if pcol >= 0 {
		widen(rows, best)
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

// unbox takes the checkbox off a multi-answer option and says whether there was
// one. The state inside it is not read here: this package renders notifications,
// and "asks for an answer" is the same sentence whichever boxes are ticked.
func unbox(s string) (string, bool) {
	m := checkbox.FindString(s)
	if m == "" {
		return s, false
	}
	return s[len(m):], true
}

// nextKey is the number that would continue a run: one past the option it ends
// with. Read off the last option rather than counted from the length, because a
// run may start anywhere — a menu that has scrolled its own list shows one
// beginning at "3.".
func nextKey(opts []Option) string {
	n, err := strconv.Atoi(opts[len(opts)-1].Key)
	if err != nil {
		return ""
	}
	return strconv.Itoa(n + 1)
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
//
// flush is that rule's one exception, and it is measured rather than argued. A
// question that takes several answers draws its descriptions at the very column
// its numbers sit in — captured off a real pane at 51 columns, where the option
// lines and the three lines describing the one above them all start at column 2.
// Under the strict rule the run broke at the first option, so such a menu drew no
// buttons on the phone, left its tab neutral and raised no notification. The
// checkbox is what buys the exception: it is a widget rather than prose, and a
// paragraph back at the margin is still not a description.
func continues(between []string, indent int, flush bool) bool {
	for _, line := range between {
		// A rule across the menu ends the list rather than dividing it.
		//
		// AskUserQuestion draws one between its answers and the "chat about
		// this" way out, and that way out is outside the ring its arrows walk:
		// measured on the owner's phone 2026-08-10, four downs on a five-option
		// menu brought the pointer back to option 1. Reading the rule as chrome
		// made the page offer an option nothing can move to. The page decides
		// what to draw and this package decides what a notification says, but
		// both answer "what are the options" and they must not disagree.
		if rule.MatchString(line) {
			return false
		}
		// An empty box row is still chrome: a boxed prompt pads its options with
		// "│      │", and the options above and below one are a single list.
		if strings.TrimSpace(boxGlyphs.ReplaceAllString(line, "")) == "" {
			continue
		}
		if option.MatchString(line) {
			return false
		}
		if in := indentOf(line); in < indent || (in == indent && !flush) {
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
//
// A non-breaking space is a space here. It is what the agent's input box puts
// after its ❯, so a line wrapped in that box came out one column deeper than the
// line above it — which is exactly the shape of an option with a description
// under it, and the message being typed read as a menu.
func indentOf(line string) int {
	col := 0
	for _, r := range line {
		switch r {
		case ' ', '\t', '\u00a0', '\u202f', '│', '>', '❯', '›':
			col++
		default:
			return col
		}
	}
	return col
}
