package session

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode"
)

// Custom is a button the owner added: a label to tap and a command to run.
//
// The four built-in presets are make targets, and that was the whole rule for a
// long time — the Makefile decides how a session is launched and stays the only
// place that knows. A custom button does not break that rule, it parameterises
// it: the command travels as `CMD=` to one target (`custom`), which wraps it in
// the same sandbox launcher as every other target. Nothing here runs anything.
//
// Why they are not just more targets: adding an agent would then mean editing a
// Makefile that is an ansible template on the host this serves — a laptop, a
// deploy and a working day between wanting `qwen` on the phone and having it.
type Custom struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Cmd   string `json:"cmd"`
	// Target is a make target of its own, for a button that names one instead of
	// carrying a command. Written as `make <target>` in the same field the command
	// goes in — which is what the drawer already shows for the four defaults, so
	// there is one vocabulary rather than a second input nobody would find.
	//
	// It exists because a Makefile has targets the four do not cover: the author's
	// own has `cont-yolo`, and reaching it from a phone meant typing `make
	// cont-yolo` as a *command*, which runs make inside the session the button
	// just made — it creates a second session beside it and leaves the first to
	// die. A target is also a narrower thing to allow than a command: a name, and
	// nothing that can reach a shell.
	Target string `json:"target,omitempty"`
	// The glyph this button and every tab it opens are drawn with, picked from the
	// grid in the drawer. Empty leaves it to the page: its own vocabulary for the
	// four, a mark the label leads with, or the shared star.
	//
	// Chosen rather than typed, because the way to have one was to put an emoji at
	// the front of the label: three custom buttons all drew the same star until
	// somebody knew that trick, and it cost a character of a name that has 24.
	Mark string `json:"mark,omitempty"`
}

// CustomTarget is the make target a custom button runs. It takes the command in
// `CMD=`; a Makefile without it fails with make's own message, which travels
// back to the drawer as text.
const CustomTarget = "custom"

// customPrefix marks a preset name as a custom button's id.
const customPrefix = "custom:"

// CustomID reads the button id out of a preset name, or "" for a built-in one.
func CustomID(preset string) string {
	if !strings.HasPrefix(preset, customPrefix) {
		return ""
	}
	return strings.TrimPrefix(preset, customPrefix)
}

// PresetName is what the page sends to start this button's session: a built-in
// is asked for by its own name, everything else by its id behind the prefix.
func (c Custom) PresetName() string {
	if _, ok := Presets[c.ID]; ok {
		return c.ID
	}
	return customPrefix + c.ID
}

// Builtin reports whether this entry is one of the four the page starts with —
// which is to say whether its id names a make target of its own.
func (c Custom) Builtin() bool {
	_, ok := Presets[c.ID]
	return ok
}

// DefaultButtons is the list a host starts with, and what a reset restores.
//
// The labels live here rather than in the page because the four are now entries
// in the same list as the owner's own: they can be renamed, and a rename has to
// be stored somewhere. What stays in the page is the glyph — that is its own
// vocabulary, shared by the menu, the strip and the drawer (web/js/kinds.js).
//
// A default carries no command: its id *is* a make target, and the Makefile
// decides what that target does. Give one a command and it starts going through
// the `custom` target instead, keeping its id — so the sessions it has already
// opened keep their mark.
func DefaultButtons() []Custom {
	return []Custom{
		{ID: "shell", Label: "Shell"},
		{ID: "claude", Label: "Claude"},
		{ID: "yolo", Label: "Claude (yolo)"},
		{ID: "continue", Label: "Continue"},
	}
}

// Limits on what a button may carry. Both are about a phone: a label longer
// than this is unreadable in the menu it sits in, and a command longer than
// this is not something anyone types on a touch keyboard.
const (
	maxLabel = 24
	maxCmd   = 120
)

// What a command may be made of.
//
// This is a gate, not advice: the value becomes `CMD=` on a make command line
// and make hands it to the shell inside the recipe, single-quoted. Everything
// that could end that quoting or start an expansion is absent from the list —
// no quotes, no backtick, no `$`, no `;` `&` `|` `<` `>` `(` `)` `{` `}` and no
// newline. What is left is a command, its flags and a path, which is what these
// buttons are for: `qwen`, `opencode --yolo`, `python3 -i`.
// It may start with a path (`/usr/local/bin/agent-run`, `./script`) but not with
// a dash: a command line beginning with a flag is a mistake, and refusing it here
// costs nothing.
var cmdOK = regexp.MustCompile(`^[A-Za-z0-9/.][A-Za-z0-9 _\-./=:,@+]*$`)

// A make target: what the Makefile's own targets look like, and nothing else. The
// value reaches a make command line, so this is the same kind of gate as cmdOK —
// a narrower one, since a target has no arguments and no path.
var targetOK = regexp.MustCompile(`^[a-z][a-z0-9-]{0,23}$`)

// asMake reads `make <target>` and answers the target, or "" for anything else.
// One space, one word: `make -C /elsewhere all` is not a target, and neither is
// `make` on its own.
func asMake(v string) string {
	rest, ok := strings.CutPrefix(v, "make ")
	if !ok {
		return ""
	}
	rest = strings.TrimSpace(rest)
	if !targetOK.MatchString(rest) {
		return ""
	}
	return rest
}

// How much of a glyph a mark may be. One symbol is one code point; an emoji is
// often several — a variation selector, a skin tone, a ZWJ sequence — so this is a
// ceiling on a glyph rather than a count of characters.
const maxMark = 8

// ValidCustom checks one button and returns it with the label trimmed.
func ValidCustom(c Custom) (Custom, error) {
	c.Label = strings.TrimSpace(c.Label)
	c.Cmd = strings.TrimSpace(c.Cmd)
	c.Target = strings.TrimSpace(c.Target)
	c.Mark = strings.TrimSpace(c.Mark)
	if len([]rune(c.Mark)) > maxMark {
		return c, fmt.Errorf("a mark is one glyph")
	}
	for _, r := range c.Mark {
		// A control character would reach the page and the journal; a space would
		// draw a button with a hole where its mark is.
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return c, fmt.Errorf("a mark cannot contain spaces or control characters")
		}
	}
	// `make <target>` in the command field is a target and not a command. Read
	// here rather than in the page so a hand-edited file means the same thing, and
	// so the two cannot drift into different ideas of what was typed.
	if t := asMake(c.Cmd); t != "" {
		c.Target, c.Cmd = t, ""
	}
	if c.Target != "" {
		if c.Cmd != "" {
			return c, fmt.Errorf("a button runs a command or a make target, not both")
		}
		if !targetOK.MatchString(c.Target) {
			return c, fmt.Errorf("a make target is lower-case letters, digits and dashes")
		}
	}
	if c.Label == "" {
		return c, fmt.Errorf("a button needs a label")
	}
	if len([]rune(c.Label)) > maxLabel {
		return c, fmt.Errorf("a label is at most %d characters", maxLabel)
	}
	for _, r := range c.Label {
		// A control character in a label would reach the page and the journal;
		// everything else — Cyrillic, an emoji — is the owner's business.
		if unicode.IsControl(r) {
			return c, fmt.Errorf("a label cannot contain control characters")
		}
	}
	if c.Cmd == "" {
		// Two kinds of button have no command: a built-in, whose id is a make
		// target of its own, and one that names a target outright. Everything else
		// without one would be a button that starts nothing.
		if c.Builtin() || c.Target != "" {
			return c, nil
		}
		return c, fmt.Errorf("a button needs a command, or `make <target>`")
	}
	if len(c.Cmd) > maxCmd {
		return c, fmt.Errorf("a command is at most %d characters", maxCmd)
	}
	if !cmdOK.MatchString(c.Cmd) {
		return c, fmt.Errorf("a command may use letters, digits, spaces and - _ . / = : , @ + " +
			"— quotes, $ and ; & | are refused because it reaches a shell")
	}
	return c, nil
}

// Buttons is the stored list of custom buttons.
//
// Remembered on disk for the same reason the notification mode is: CI installs
// this binary on every push to main, and a list held in memory would be gone
// several times a working day. It is also the host's answer rather than the
// page's — a second phone, or a reinstalled PWA, must find the same buttons.
type Buttons struct {
	mu   sync.Mutex
	list []Custom
	// path is where the list is kept; empty keeps it in memory, which is what a
	// host with nowhere to write gets. The buttons still work, they just do not
	// survive a restart.
	path string
}

// stored is the file's shape. An object rather than the bare array it used to
// be, and the difference carries a fact no array could: whether the four
// built-ins are absent because the owner removed them or because the file
// predates their being in the list at all. The first must survive a restart, the
// second has to be filled in — see LoadButtons.
type stored struct {
	Buttons []Custom `json:"buttons"`
}

// LoadButtons reads the stored list. A file that cannot be read or parsed leaves
// the defaults rather than refusing to start: the buttons are a convenience, and
// a broken file must not cost the terminal — but a phone with no buttons at all
// cannot start a session, which is the one thing this package exists for.
func LoadButtons(path string) *Buttons {
	b := &Buttons{path: path, list: DefaultButtons()}
	if path == "" {
		return b
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return b
	}
	list, ok := parseButtons(raw)
	if !ok {
		return b
	}
	// Held to the same gate as anything arriving from the page: the file is
	// hand-editable, and what it says ends up on a command line.
	clean := make([]Custom, 0, len(list))
	for _, c := range list {
		v, err := ValidCustom(c)
		if err != nil || v.ID == "" {
			continue
		}
		clean = append(clean, v)
	}
	// An empty list is an answer — every button removed — and it is kept as one.
	b.list = clean
	return b
}

// parseButtons reads either shape of the file.
//
// The bare array is what versions before the built-ins joined the list wrote,
// and it holds custom buttons only: a store from then says nothing about the
// four, so they are put back in front rather than treated as deleted. The object
// form says exactly what it means, empty list included.
func parseButtons(raw []byte) ([]Custom, bool) {
	var obj stored
	if err := json.Unmarshal(raw, &obj); err == nil {
		return obj.Buttons, true
	}
	var old []Custom
	if err := json.Unmarshal(raw, &old); err != nil {
		return nil, false
	}
	return append(DefaultButtons(), old...), true
}

// List returns the buttons in the order they are shown.
func (b *Buttons) List() []Custom {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]Custom, len(b.list))
	copy(out, b.list)
	return out
}

// Find looks a button up by id.
func (b *Buttons) Find(id string) (Custom, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, c := range b.list {
		if c.ID == id {
			return c, true
		}
	}
	return Custom{}, false
}

// Set replaces the whole list.
//
// The whole list rather than add/remove endpoints: the page holds it, so a
// replace cannot leave the two disagreeing about what exists — and there is
// nothing to reconcile when the same list is edited from two phones, the last
// save wins and says so by showing what the host now has.
//
// Ids are the host's to hand out. An entry that arrives without one is new and
// gets the next number; an entry that keeps its id keeps it, so a rename does
// not turn into a different button.
func (b *Buttons) Set(list []Custom) ([]Custom, error) {
	clean := make([]Custom, 0, len(list))
	seen := map[string]bool{}
	next := 0
	for _, c := range list {
		v, err := ValidCustom(c)
		if err != nil {
			return nil, err
		}
		if v.ID != "" {
			if seen[v.ID] {
				return nil, fmt.Errorf("two buttons cannot share an id")
			}
			seen[v.ID] = true
			if n, err := strconv.Atoi(strings.TrimPrefix(v.ID, "b")); err == nil && n > next {
				next = n
			}
		}
		clean = append(clean, v)
	}
	for i := range clean {
		if clean[i].ID == "" {
			next++
			clean[i].ID = "b" + strconv.Itoa(next)
		}
	}

	b.mu.Lock()
	b.list = clean
	path := b.path
	b.mu.Unlock()

	out := make([]Custom, len(clean))
	copy(out, clean)
	if path == "" {
		return out, nil
	}
	// Stored or not, the list is in force: a full disk is a reason to forget the
	// buttons after a restart, not a reason to refuse them now. The caller logs
	// the error and answers the page with what is set.
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return out, fmt.Errorf("custom buttons: %w", err)
	}
	raw, err := json.MarshalIndent(stored{Buttons: clean}, "", "  ")
	if err != nil {
		return out, fmt.Errorf("custom buttons: %w", err)
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0o600); err != nil {
		return out, fmt.Errorf("custom buttons: %w", err)
	}
	return out, nil
}

// Reset puts the four built-ins back and leaves the owner's own alone.
//
// Restoring everything would be one predictable state and one list of buttons
// lost with a mistap — the four are a default, and `qwen` typed on a phone is
// not. So this is about the defaults only: whichever of them were removed come
// back, whichever were renamed or given a command are stock again, and they lead
// the list in their own order.
func (b *Buttons) Reset() ([]Custom, error) {
	b.mu.Lock()
	keep := make([]Custom, 0, len(b.list))
	for _, c := range b.list {
		if !c.Builtin() {
			keep = append(keep, c)
		}
	}
	b.mu.Unlock()
	return b.Set(append(DefaultButtons(), keep...))
}

// Resolve turns a preset name into the make target to run and the command to
// hand it, and it is the only place that decides either.
//
// The list is the authority, not this package's map: a button the owner removed
// cannot be started, however well-known its name, or removing it would only have
// hidden it. And an entry with a command runs through the `custom` target even
// when its id is a built-in's — that is what editing a default's command means,
// and it keeps the id so the sessions it already opened keep their mark.
func (b *Buttons) Resolve(preset string) (target, cmd string, err error) {
	id := preset
	if custom := CustomID(preset); custom != "" {
		id = custom
	}
	c, ok := b.Find(id)
	if !ok {
		return "", "", fmt.Errorf("no such button")
	}
	if c.Target != "" {
		// A target of the owner's own choosing, in the owner's own Makefile. The
		// same trust as the four — those are targets too — and a narrower value
		// than a command.
		return c.Target, "", nil
	}
	if c.Cmd != "" {
		return CustomTarget, c.Cmd, nil
	}
	// No command: the id has to be a target of its own, which is exactly what
	// ValidCustom already required of an entry without one. Checked again here
	// because this value reaches a command line.
	t, err := Target(c.ID)
	if err != nil {
		return "", "", err
	}
	return t, "", nil
}
