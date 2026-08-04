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
var liveSpinner = regexp.MustCompile(`^[\s│]*[✻✽✶✢✳✱✧✺*][^\p{L}]*\p{L}[^…]*…`)

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
		if liveCounter.MatchString(line) || liveInterrupt.MatchString(line) || liveSpinner.MatchString(line) {
			return true
		}
	}
	return false
}
