package detect

import (
	"regexp"
	"strings"
)

// The counter an agent keeps on screen while a turn is running: how long it has
// been going, in brackets after whatever it calls what it is doing, and then
// whatever else it feels like saying.
//
//	✶ Doing… (1m 13s · ↓ 3.9k tokens)
//	✻ Pondering… (9m 2s · ↑ 31.0k tokens · thought for 17s)
//	✢ Crunching… (4m 23s · still thinking)
//	* Deciphering… (4m 59s · thinking)
//	✻ Scampering… (29s · thinking more)
//
// **The brackets open with the duration, and that is the whole of the rule.** It
// used to also demand the word "tokens", which is there while the agent is
// spending them and absent while it only thinks — so a turn four minutes into
// thinking read as a turn that had ended. That cost a "finished" notification
// sent mid-thought with the live counter as its body, and a tab going green for
// a few seconds at a time while work carried on. Both reported from the phone,
// and neither visible in a 40-second sample taken while tokens happened to be
// flowing.
//
// What separates it from the line left behind when the turn ends is the brackets:
// that one is the same words in the past tense with none.
//
//	✻ Cooked for 19s · 1 shell, 1 monitor still running
//
// The verbs change from release to release — Pondering, Crunching, Deciphering,
// Scampering, Cooked — so none of them is matched, and none should be.
var liveCounter = regexp.MustCompile(`\(\s*(?:\d+\s*h\s*)?(?:\d+\s*m\s*)?\d+\s*s\b[^)]*\)`)

// The other way an agent says a turn is running: the way out of it. Older
// releases put the counter behind "esc to interrupt" and newer ones drop it
// while a tool call is in flight, so this is the second reading rather than a
// fallback — either one means the same thing.
var liveInterrupt = regexp.MustCompile(`(?i)esc to interrupt`)

// And the third, from the owner's own observation: the counter's line always
// opens with one of a small set of stars, and those characters turn up in
// ordinary text about never.
//
//	✻ Pondering…    ✽ Doing…    ✶ Doing…    ✢ Crunching…    * Deciphering…
//
// The ellipsis is required with it, and it is what makes the pair safe: a turn in
// flight is named with one ("Crunching…"), and the line left behind when it ends
// is not ("✻ Cooked for 19s"). It catches a turn too young to have a duration yet,
// where the brackets are not on screen at all.
//
// `●` is deliberately absent from the set. That is the mark on the agent's own
// sentences — the thing a notification is *for* — and reading it as a spinner
// would make every session look permanently busy.
//
// **The set was observed rather than enumerated, and it was short by one frame.**
// Read out of Claude Code 2.1.234 itself, the spinner cycles
// `["·", "✢", "*", "✶", "✻", "✽"]` — `·` (U+00B7) is the frame this set did not
// have, so one poll in six could not see the counter at all. Harmless while the
// brackets carry a duration, because the rule above answers then. Not harmless on
// the shape a long think draws — `✻ Unravelling… (thinking with xhigh effort)`,
// captured off two live sessions on 2026-08-18 — which has no duration in it: with
// only this rule left to answer, two polls landing on `·` inside the four seconds
// the watcher waits report a turn as finished mid-thought. That is the same
// notification the "tokens" rule cost before it, in a new shape.
//
// The dot is the one frame that can also be prose — a bulleted line ending in an
// ellipsis has the same shape — where a star cannot. Measured before it was added:
// no line in 2000 rows of scrollback from four working panes begins with one. The
// cost if it ever happens is a tab that stays purple until the line scrolls out of
// range, against a notification saying the opposite of what is true.
var liveSpinner = regexp.MustCompile(`^[\s│]*[✻✽✶✢✳✱✧✺*·][^\p{L}]*\p{L}[^…]*…`)

// The fourth reading, and the only one that names words: a turn held up by the
// network. While the agent retries a request it draws this in the counter's
// place, and the counter itself is gone —
//
//	✻ API error · Retrying in 0s · attempt 1/10
//	✻ Connection refused — a firewall or proxy may be blocking it (Co… · Retrying in 11s · attempt 6/10
//
// — so every rule above answers "no turn" and the watcher announces a finish
// mid-request. Reported from the owner's screen as hanging on that message with
// the work carrying on and freeing itself a minute later; the minute is one
// attempt in flight, and `in 0s` is what the line says while it waits.
//
// **The two forms read differently, which is why this cost a release.** The long
// one is truncated by the pane, and the ellipsis truncation leaves made the
// spinner rule answer by accident — so on a phone the retry read as work and on a
// wide screen, where `API error` fits whole, as a finished turn. Same event, two
// answers, depending on the width of the window.
//
// Words are the exception here, and they are marked as one: `Retrying in` and
// `attempt N/M` were measured off 2.1.241 (2026-09-08, the API pointed at a
// closed port). Both halves are required together, because `attempt 3/10` alone
// occurs in the agent's own prose — and prose stays in the transcript, where it
// would keep a tab working until it scrolled away. The retry line cannot: it is
// drawn where the counter is and vanishes with it, which is what makes reading it
// as a live turn safe. Measured by interrupting a retry: the line is not in the
// pane afterwards at all.
var liveRetry = regexp.MustCompile(`(?i)retrying in\b[^·]*·\s*attempt\s+\d+\s*/\s*\d+`)

// Retrying reports the same thing Live does about this one shape, separately:
// the turn is held up by the API rather than working. Nothing decides by it — the
// tab and the notice treat a retry as the turn it is — it exists so the journal
// can say which of the two a session was in. Without that line, "the session
// hangs and frees itself a minute later" reads the same in the log as a turn that
// simply took a minute, and telling them apart is where the last hour went.
func Retrying(lines []string) bool {
	seen := 0
	for i := len(lines) - 1; i >= 0 && seen < liveLines; i-- {
		line := ansi.ReplaceAllString(lines[i], "")
		if strings.TrimSpace(line) == "" {
			continue
		}
		seen++
		if liveRetry.MatchString(line) {
			return true
		}
	}
	return false
}

// How far up from the bottom the live counter can sit.
//
// Generous on purpose: the counter is the last line of the transcript, but the
// agent draws its input box, its own status line and sometimes a task list
// under it, and how tall that is changes with the release and with what is
// running. On the pane this was written for — a phone, some 24 rows — this is
// the whole screen, which is the point: the bound only keeps a counter from an
// hour ago, scrolled far up a tall desktop pane, from claiming the present.
const liveLines = 20

// Live reports whether the agent in this pane is in the middle of a turn.
//
// It is what makes "the turn ended" an observation rather than a guess. The
// watcher used to decide that by silence — thirty seconds without the screen
// changing — which is thirty seconds of a tab painted as working after the
// answer was already on it, and thirty seconds before the phone was told. The
// counter says it directly: while it is on screen the agent is working, and the
// moment it goes the turn is over.
//
// A pane with no agent in it says nothing either way, and the silence rule is
// still what answers for those — a shell running a build has no counter to read.
func Live(lines []string) bool {
	seen := 0
	for i := len(lines) - 1; i >= 0 && seen < liveLines; i-- {
		line := ansi.ReplaceAllString(lines[i], "")
		if strings.TrimSpace(line) == "" {
			continue
		}
		seen++
		if liveCounter.MatchString(line) || liveInterrupt.MatchString(line) ||
			liveSpinner.MatchString(line) || liveRetry.MatchString(line) {
			return true
		}
	}
	return false
}

// The line an agent leaves in the transcript when a turn stops on an API
// failure rather than finishing:
//
//	✕ [API Error: exception TypeError: fetch failed sending request]
//	● API Error: 529 Overloaded. This is a server-side issue…
//	● Request timed out
//	● Repeated 529 Overloaded errors
//
// Measured off the Gemini CLI bundle (`parseAndFormatApiError` + `ErrorMessage`)
// and the Claude Code 2.1.319 binary (`isApiErrorMessage`). While Claude Code is
// still retrying, the line opens with `⎿` and carries `Retrying in …`, which
// `Live` already answers for; this matches only the terminal line after attempts
// have run out (or immediately in Gemini CLI, which does not retry).
var (
	apiErrLine = regexp.MustCompile(`^\s*(?:✕\s+\[API Error:|●\s+(?:API Error:|.*\s·\s*API Error:|Failed to authenticate\.\s*API Error:|Request timed out\b|Repeated 529 Overloaded errors\b))`)
	geminiInfo = regexp.MustCompile(`^\s*ℹ\s+(?:This request failed\.|Some internal tool attempts failed\b)`)
	topMarker  = regexp.MustCompile(`^(?:\s*[●✦✕ℹ⎿]|\s*❯(?:\x{00a0}|\s|$)| ?>(?:\s|$)|\s*[✓✗o⊷]\s+|\s*[$#%]\s+)`)
	turnDone   = regexp.MustCompile(`^\P{L}*\p{L}+\s+for\s+\d+[hms]`)
	scrollBar  = regexp.MustCompile(`(?:^|[ \t]+)[█▄▀][ \t]*$`)
)

const frameRunes = "─│┌┐└┘├┤┬┴┼╭╮╰╯━┃╔╗╚╝║═▁▔▏▕█▌▐ ⠀·•*"

// APIError reports whether the pane is stopped on an API error right now.
//
// Only the end of the transcript counts: an error stays on screen above the
// next prompt (`> дальше`) while the session moves on, and reading the whole
// pane would keep the tab red after work has resumed.
func APIError(lines []string) bool {
	if Live(lines) {
		return false
	}
	if i := InputBoxAt(lines); i >= 0 {
		lines = lines[:i]
	}
	failed := false
	for i := 0; i < len(lines); i++ {
		l := scrollBar.ReplaceAllString(ansi.ReplaceAllString(lines[i], ""), "")
		t := strings.TrimSpace(strings.Trim(strings.TrimSpace(l), frameRunes))
		if t == "" {
			continue
		}
		if turnDone.MatchString(strings.TrimSpace(l)) {
			continue
		}
		if geminiInfo.MatchString(l) {
			i = skipParagraph(lines, i)
			continue
		}
		if apiErrLine.MatchString(l) {
			i = skipParagraph(lines, i)
			failed = true
			continue
		}
		failed = false
	}
	return failed
}

func skipParagraph(lines []string, i int) int {
	for j := i + 1; j < len(lines); j++ {
		c := scrollBar.ReplaceAllString(ansi.ReplaceAllString(lines[j], ""), "")
		t := strings.TrimSpace(strings.Trim(strings.TrimSpace(c), frameRunes))
		if t == "" || topMarker.MatchString(c) || turnDone.MatchString(strings.TrimSpace(c)) {
			break
		}
		i = j
	}
	return i
}
