// Package tmuxcmd builds tmux invocations and parses their output; it
// never runs them.
package tmuxcmd

import (
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"
)

// clientPrefix names the grouped sessions pockterm creates for its own
// clients. They are hidden from the session list and cannot be attached
// to by name, so users only ever see their own sessions.
//
// It says "client" out loud because the namespace has to be one a user's own
// session cannot wander into. `pockterm-` alone was not: sessions are named
// after the folder they were started in, ~/work/pockterm is a folder, and its
// second session is `pockterm-2` — hidden from the list and unattachable, with
// nothing anywhere saying why. Worse, that name can equal a client's: the ids
// count from 1 per process, so `pockterm-2` is one of the first two a page ever
// takes, and `new-session -A -s pockterm-2` would then have attached the phone
// to the user's own session instead of making a client for it.
const clientPrefix = "pockterm-client-"

// ClientName is the session name for a pockterm client with the given id.
func ClientName(id int64) string { return fmt.Sprintf("%s%d", clientPrefix, id) }

// IsClientSession reports whether name is one of pockterm's own client
// sessions rather than a user session.
func IsClientSession(name string) bool { return strings.HasPrefix(name, clientPrefix) }

// Session is one tmux session as reported by ListSessions.
type Session struct {
	Name     string `json:"name"`
	Windows  int    `json:"windows"`
	Created  int64  `json:"created"` // unix seconds
	Attached bool   `json:"attached"`
	// Group this session belongs to, empty when it is on its own. tmux names
	// a group after the session it was created from and never renames it, so
	// this is frequently a name no session carries any more — and a name that
	// must not be handed to another session. See NameConflict.
	Group string `json:"-"`
	// What the session is doing — "working", "done", or empty when nothing is
	// claimed. tmux knows nothing about this and never fills it: it is the
	// watcher's answer, put here by the server so the page reads one list
	// instead of joining two that can disagree.
	State string `json:"state,omitempty"`
	// What the agent still has running while it is quiet, read off its own
	// footer by the watcher. Same provenance as State, and tmux fills neither:
	// "gone quiet" and "gone quiet with a monitor still watching" are not the
	// same answer, and the second one is why a tab is worth looking at.
	Shells   int `json:"shells,omitempty"`
	Monitors int `json:"monitors,omitempty"`
	// Agents is how many subagents the session lists; drawn as one head each.
	Agents int `json:"agents,omitempty"`
	// Which button started this session — a preset's name, or "custom:<id>" for
	// one of the owner's own. tmux carries it as a session option the Makefile
	// stamps at creation (see KindOption), so it survives a rename and this
	// binary's restarts, and a session nobody stamped simply has none.
	//
	// The page needs it because the name cannot say it any more: sessions are
	// named after the folder they were started in, so "natal" and "natal-2" are
	// the same project by two different buttons.
	Kind string `json:"kind,omitempty"`
	// Where the session's current pane actually is. The name answers where it was
	// *opened*, which is a different fact and drifts: a session named after ~/work
	// spent an afternoon in ~/work/self, and nothing on the phone said so.
	Dir string `json:"dir,omitempty"`
	// Where the owner dragged this tab to, 1-based; 0 for a session nobody has
	// placed. Kept in tmux beside the kind (see OrderOption) rather than in a file
	// of this server's, for the same three reasons: CI restarts this binary several
	// times a working day, a second phone must see the same strip, and a session
	// that is closed takes its slot with it instead of leaving a hole in a list
	// somewhere.
	Order int `json:"-"`
}

// KindOption is the tmux session option the Makefile stamps the button on, and
// the only place this fact lives. A user option (the "@" prefix) because tmux
// keeps those per session, unread and untouched by anything else, and reports
// them in a format like any other field.
const KindOption = "@pockterm-kind"

// OrderOption is where a tab's place in the strip is kept: a user option on the
// session, like the kind. tmux sorts its own list by name, which is the one order
// nobody chose — the strip is read left to right dozens of times a day and the
// session you keep coming back to is not the one whose name sorts first.
const OrderOption = "@pockterm-order"

// listFormat keeps the field order ParseSessions expects.
//
// pane_start_command is the last field on purpose: it is the only one that can
// carry a tab, and a stray one there costs a field nobody parses rather than
// shifting every field after it.
const listFormat = "#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}" +
	"\t#{session_group}\t#{" + KindOption + "}\t#{pane_current_path}\t#{" + OrderOption + "}" +
	"\t#{pane_start_command}"

// ListSessions returns the argv listing sessions one per line in the
// tab-separated order ParseSessions parses.
func ListSessions() []string {
	return []string{"tmux", "list-sessions", "-F", listFormat}
}

// ParseSessions turns ListSessions output into Session values. Blank and
// malformed lines are skipped so a partial line never aborts the list.
func ParseSessions(out string) []Session {
	var sessions []Session
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		f := strings.Split(line, "\t")
		// The group field was added later; a line without it is still a
		// session, just one whose group is unknown.
		if len(f) < 4 || f[0] == "" {
			continue
		}
		windows, _ := strconv.Atoi(f[1])
		created, _ := strconv.ParseInt(f[2], 10, 64)
		group := ""
		if len(f) > 4 {
			group = f[4]
		}
		kind := ""
		if len(f) > 5 {
			kind = f[5]
		}
		dir := ""
		if len(f) > 6 {
			dir = f[6]
		}
		order := 0
		if len(f) > 7 {
			order, _ = strconv.Atoi(f[7])
		}
		// Nobody stamped this one — started before the Makefile knew how, or by
		// hand. The command the pane was created with still answers the coarse
		// half of the question, and only that half: see KindFromStart.
		if kind == "" && len(f) > 8 {
			kind = KindFromStart(f[8])
		}
		sessions = append(sessions, Session{
			Name:     f[0],
			Windows:  windows,
			Created:  created,
			Attached: f[3] == "1",
			Group:    group,
			Kind:     kind,
			Dir:      dir,
			Order:    order,
		})
	}
	return sessions
}

// Shells a session can have been started as. Names, not paths: tmux reports
// whatever was on the command line, and that is /bin/sh here, /usr/bin/zsh
// there, $SHELL wherever the Makefile passed it through.
var shells = map[string]bool{
	"sh": true, "bash": true, "zsh": true, "fish": true,
	"dash": true, "ksh": true, "csh": true, "tcsh": true,
}

// KindFromStart reads what it can out of the command a pane was created with:
// "shell", or nothing.
//
// Deliberately only that much. The command is the honest answer to a different
// question than the button — "agent-run --dangerously-skip-permissions" is what
// the yolo button runs, and knowing that it is *called* yolo means knowing the
// Makefile, which is the one thing this program refuses to know. So the stamped
// option is the answer about buttons, and this is the answer about shells: a
// session that was started as a plain shell, whoever started it and whenever.
//
// A pane created with no command at all runs the login shell, which is the same
// answer.
func KindFromStart(start string) string {
	start = strings.TrimSpace(strings.Trim(strings.TrimSpace(start), `"`))
	if start == "" {
		return "shell"
	}
	// One word and nothing after it. `bash -lc "npm run dev"` is a shell only in
	// the sense that everything is: what it was started to run is the argument,
	// and this has no business guessing at it.
	if strings.ContainsAny(start, " \t") {
		return ""
	}
	if shells[path.Base(start)] {
		return "shell"
	}
	return ""
}

// SetOrder is the argv that writes a tab's place onto the session.
//
// One session per call: tmux takes a single -t, and doing them one at a time
// means a strip that is half-renumbered rather than one that failed as a whole —
// the page sends the order it drew, so the next save fixes any gap.
//
// No "=" before the name, the same trap set-option sets for the kind: it reads
// its -t as a pane and answers "no such session: =claude" for the exact-match
// form, so the stamp silently never lands.
func SetOrder(name string, order int) []string {
	return []string{"tmux", "set-option", "-t", name, OrderOption, strconv.Itoa(order)}
}

// SortByOrder puts the sessions in the order the owner dragged them into, and
// leaves everything else where tmux had it.
//
// Placed sessions come first, by their number; the unplaced follow in tmux's own
// order, which is by name. That is what a session started after the last drag
// gets: the end of the strip rather than a place among tabs somebody arranged,
// and it stays there until the next drag numbers everything again.
func SortByOrder(sessions []Session) []Session {
	out := make([]Session, len(sessions))
	copy(out, sessions)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i].Order, out[j].Order
		if (a > 0) != (b > 0) {
			return a > 0
		}
		if a > 0 && a != b {
			return a < b
		}
		return false // stable: tmux's own order decides the rest
	})
	return out
}

// NameConflict reports why name cannot be given to a session, or nil.
//
// The trap it closes cost an afternoon on 2026-08-03. tmux names a session
// group after the session it was created from and keeps that name after the
// session is renamed, so a name freed by renaming still exists as a group.
// Worse, `new-session -t <name>` — how a client attaches — resolves a group
// before a session of the same name. Give a second session the freed name and
// its tab opens the first session's window, and attaching merges the two into
// one group for good: the merge cannot be undone, and moving a window out of
// it destroys the other session's windows.
//
// The session's own group is not a conflict: renaming a session to the name
// of the group it already belongs to changes nothing about what resolves
// where.
func NameConflict(name string, sessions []Session) error {
	for _, s := range sessions {
		if s.Name == name {
			return fmt.Errorf("a session named %q already exists", name)
		}
	}
	for _, s := range sessions {
		if s.Group == name && s.Name != name {
			return fmt.Errorf("%q is the name of the session group %q is in — "+
				"tmux would open that session instead of this one; pick another name", name, s.Name)
		}
	}
	return nil
}

// CapturePane returns the argv printing the visible text of session's
// current pane. This is how the notifier reads a screen nobody has open:
// plain text, no escapes, one line per terminal row.
func CapturePane(session string) []string {
	return []string{"tmux", "capture-pane", "-p", "-t", session}
}

// CaptureHistory returns the argv printing the pane's last lines of history
// together with the screen itself — what the page freezes when text is being
// selected on a phone.
//
// It exists because the page has no history of its own to freeze. tmux keeps the
// scrollback and repaints the pane rather than letting lines scroll off it, so
// the terminal in the browser sits at the top of an empty buffer however much
// output has gone past: measured on the stand, `viewportY` is 0 after eighty
// lines. The copy window was therefore exactly one screen tall and could not be
// scrolled at all, which is what was reported.
//
// The count is a cap on how tall a <pre> a phone is asked to lay out and select
// inside, not on what tmux remembers. Negative in tmux's own terms — `-S` counts
// back from the top of the visible pane — and the end is left at the default,
// which is the bottom of that pane.
func CaptureHistory(session string, lines int) []string {
	if lines < 0 {
		lines = 0
	}
	return []string{"tmux", "capture-pane", "-p", "-S", "-" + strconv.Itoa(lines), "-t", session}
}

// PaneMode returns the argv reporting three things about the current pane of
// session: whether it is in a tmux mode — copy-mode, which is what a touch
// swipe enters to scroll the history — how far back it is scrolled, and how
// many lines of history there are to be scrolled through.
//
// The first two, because the page needs a different question answered than tmux
// asks itself. While the pane shows history, the numbered lines on screen belong
// to the past and answering them would send digits to whatever is running now;
// but a pane sitting in copy-mode at the live end shows the present, and the way
// back to it is nowhere. The button offering that way back is the thing that was
// left on screen with nothing behind it.
//
// The third is what a scrollbar is drawn from: a position without a total says
// nothing about where in the output it is. tmux answers it whether or not the
// pane is in a mode, which is what lets the bar be on screen before anything has
// been scrolled.
//
// Comma-separated rather than by spaces, because the middle field is empty for a
// pane that is not in a mode — `strings.Fields` on "0  181" gives two fields and
// reads the history size as the scroll position.
func PaneMode(session string) []string {
	return []string{"tmux", "display-message", "-p", "-t", session,
		"#{pane_in_mode},#{scroll_position},#{history_size}"}
}

// ScrollHistory returns the argv moving the pane's copy-mode view by lines:
// positive is back into the history, negative is forward towards the live end.
//
// One command rather than a batch of wheel notches, which is how the swipe and
// the pager move: a scrollbar dragged the length of the screen asks for hundreds
// of lines at once, and hundreds of mouse reports are hundreds of key bindings
// for tmux to run. `-N` is the same count the wheel binding uses, applied once.
//
// `copy-mode -e` first, because `send-keys -X` needs a mode to send to and the
// bar is on screen before there is one. It is a no-op on a pane already in
// copy-mode — measured: a pane scrolled back 30 lines is still at 30 after it —
// so the two can always travel together. The `-e` is what makes a drag to the
// very bottom leave the mode, the same way a wheel scroll to the live end does.
//
// Both directions are bounded by tmux itself: past the top it clamps at the
// history size, past the bottom it leaves the mode. Neither needs guarding here.
func ScrollHistory(session string, lines int) []string {
	dir := "scroll-up"
	if lines < 0 {
		dir = "scroll-down"
		lines = -lines
	}
	return []string{
		"tmux", "copy-mode", "-e", "-t", session,
		";", "send-keys", "-t", session, "-X", "-N", strconv.Itoa(lines), dir,
	}
}

// CancelMode returns the argv that takes the pane out of whatever mode it is
// in, if it is in one.
//
// It exists because typing into a pane that tmux holds in copy-mode goes
// nowhere at all: the keys are the mode's own commands, a printable character
// is discarded, and the phone has no way to see any of it — a pane in copy-mode
// at the live end looks exactly like a live pane. Reported as the terminal not
// taking text and a pasted image never arriving, with the cure found by hand:
// scroll up and come back, which is what ends the mode.
//
// `send-keys -X cancel` rather than a literal `q`: the page's picture of the
// mode is up to a poll old, and a `q` sent to a pane that has already left it is
// a character typed into whatever is running. This one is refused by tmux with a
// message and types nothing.
func CancelMode(session string) []string {
	return []string{"tmux", "send-keys", "-X", "-t", session, "cancel"}
}

// ParsePaneMode reads PaneMode output: whether the pane is in a mode, how many
// lines back it is scrolled, and how many lines of history the pane has.
//
// Only a bare "1" in the first field means in-mode; empty output or an error
// message (dead server, session gone) does not. The position is empty for a
// pane that is not in a mode, and tmux prints it as 0 at the live end.
//
// The history size is read whatever the mode says, because it is true of the
// pane rather than of the mode — a bar can only be drawn before the first scroll
// if the total is known before it. An error message has no commas in it and
// yields nothing, which is the honest answer for a pane nobody could ask about.
func ParsePaneMode(out string) (inMode bool, scrollBack, history int) {
	fields := strings.Split(strings.TrimSpace(out), ",")
	number := func(i int) int {
		if i >= len(fields) {
			return 0
		}
		if n, err := strconv.Atoi(strings.TrimSpace(fields[i])); err == nil && n > 0 {
			return n
		}
		return 0
	}
	history = number(2)
	if len(fields) == 0 || strings.TrimSpace(fields[0]) != "1" {
		return false, 0, history
	}
	return true, number(1), history
}

// Attach returns the argv attaching a web client to its own grouped
// session sharing windows with target. A grouped session gets an
// independent window size, so a phone client does not shrink the
// laptop's view. The trailing set-option makes the grouped session
// self-destroy when its last client detaches; ";" is tmux's command
// separator (a plain argv element, no shell involved). -A makes
// reconnects attach instead of failing on an existing name.
//
// What the group costs is the name a pane answers to. tmux resolves `#S` for a
// command run inside a pane through the best session holding that window — the
// one with the latest activity — so while a phone is attached, a script inside
// the work session calls itself `pockterm-client-60`. Measured on the host
// 2026-08-18: `#S` for yarr's own pane answered the client's name while
// `#{session_group}` answered `yarr`. It is not about a client being attached,
// a detached grouped session wins the same way, and it is not stable either:
// ids count from 1 per process and CI restarts this binary several times a
// working day, so one name belongs to different work sessions on different
// days. Anything keyed by the pane's session name — a lease file, a lock, an
// owner id — has to read `#{session_group}`, with `#S` the fallback for a
// session outside a group. It cost an evening in the laptop-access lease, where
// `ro` released nothing because the hold had been taken under the other name.
//
// The group is kept anyway: `destroy-unattached` and `mouse` are set on it, and
// attaching to the session directly would put both on the owner's own session.
func Attach(target, webSession string) []string {
	return []string{
		"tmux", "new-session", "-A", "-s", webSession, "-t", target,
		";", "set-option", "destroy-unattached", "on",
		// mouse on lets the wheel/touch enter tmux copy-mode so scrollback
		// works in the browser. Scoped to this grouped session, so the
		// user's own direct tmux clients are unaffected.
		";", "set-option", "mouse", "on",
	}
}

// ModeKeys returns the argv asking which key table copy-mode uses. With
// `mode-keys vi` the bindings live in copy-mode-vi, and reading copy-mode
// there answers about a table nothing uses.
func ModeKeys() []string {
	return []string{"tmux", "show-options", "-gv", "mode-keys"}
}

// CopyModeTable names the table for a mode-keys value.
func CopyModeTable(modeKeys string) string {
	if strings.TrimSpace(modeKeys) == "vi" {
		return "copy-mode-vi"
	}
	return "copy-mode"
}

// WheelLines returns the argv asking tmux what its wheel binding in that
// table does. The page turns a swipe into wheel notches, so how far one notch
// scrolls is the difference between the screen following the finger and the
// screen running away from it — and it is a binding, not a constant.
func WheelLines(table string) []string {
	if table == "" {
		table = "copy-mode"
	}
	return []string{"tmux", "list-keys", "-T", table, "WheelUpPane"}
}

// StatusLines returns the argv asking tmux how tall its status line is.
//
// The page needs it because that line is not chrome to it: tmux draws it into
// the bottom row of the same grid the pane lives in, so the page's own shift —
// the transform that keeps the picture under a finger between whole lines —
// moved it along with everything else. Reported as the green strip rising two
// lines on an upward swipe.
//
// The global option, not the target session's: the page attaches through its own
// grouped session, which inherits the global one and not the neighbour's
// override.
func StatusLines() []string {
	return []string{"tmux", "show-options", "-gv", "status"}
}

// ParseStatusLines reads that option: off is none, on is one, and tmux also
// takes 2..5.
//
// Anything unreadable is none. Guessing high is the worse mistake: it would pin
// a row of real output while the rest of the screen follows the finger, which
// looks like the terminal tearing, where guessing low only brings back a strip
// that moves.
func ParseStatusLines(out string) int {
	switch v := strings.TrimSpace(out); v {
	case "off", "":
		return 0
	case "on":
		return 1
	default:
		if n, err := strconv.Atoi(v); err == nil && n >= 0 && n <= 5 {
			return n
		}
		return 0
	}
}

// ParseWheelLines reads the count out of that binding. tmux's own default is
//
//	bind-key -T copy-mode WheelUpPane select-pane \; send-keys -X -N 5 scroll-up
//
// and anything unparseable falls back to that 5 rather than to a guess of 1,
// which would make every swipe five times too short on a stock tmux.
func ParseWheelLines(out string) int {
	fields := strings.Fields(out)
	for i, f := range fields {
		if f != "-N" || i+1 >= len(fields) {
			continue
		}
		if n, err := strconv.Atoi(fields[i+1]); err == nil && n > 0 && n <= 100 {
			return n
		}
	}
	return 5
}
