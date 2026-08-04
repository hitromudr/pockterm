package detect

import "testing"

// The three states of a real pane, captured off this machine's own sessions on
// 2026-08-04 rather than written from memory: the shapes are a TUI's and change
// with its releases, so the evidence is the test.
func TestLive(t *testing.T) {
	// A turn in flight. The tail is the agent's input box and status line, which
	// is what puts the counter six lines up instead of at the bottom.
	working := []string{
		"● Понял: состыковка — соотнесение карт через общий узел.",
		"  Сначала генерации.",
		"✶ Doing… (1m 13s · ↓ 3.9k tokens)",
		"────────────────────────────────",
		"❯ ",
		"────────────────────────────────",
		"  ctx 62% | dms@ai:~/work/self (master) $ | Opus 5 (1M context)",
		"  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
	}
	// The same session a moment later. The counter is gone and the line it left
	// behind is the same words in the past tense — which is exactly the pair the
	// shape has to tell apart, and the reason none of the verbs is matched.
	done := []string{
		"● Жду прогон.",
		"✻ Cooked for 19s · 1 shell, 1 monitor still running",
		"────────────────────────────────",
		"❯ ",
		"────────────────────────────────",
		"  ctx 61% | dms@ai:~/work/exante (main) $ | Opus 5 (1M context)",
		"  ⏵⏵ bypass permissions on · 1 shell, 1 monitor · ← for agents",
	}
	cases := []struct {
		name  string
		lines []string
		want  bool
	}{
		{"a turn in flight", working, true},
		{"the turn is over", done, false},
		{"an older release counts behind the way out", []string{
			"✻ Wrangling… (esc to interrupt · 12s · ↑ 1.4k tokens)",
		}, true},
		{"a tool call in flight with no counter yet", []string{
			"● Bash(make check)",
			"  ⎿  Running… (esc to interrupt)",
		}, true},
		{"a plain shell says nothing either way", []string{
			"$ make check",
			"ok  	github.com/hitromudr/pockterm/internal/detect	0.004s",
			"$ ",
		}, false},
		{"the version in a prompt is not a counter", []string{
			"  ctx 14% | dms@ai:~/work/pockterm (main) $ | Opus 5 (1M context)",
		}, false},
		{"a counter scrolled far up a tall pane is not the present", append(
			[]string{"✶ Doing… (1m 13s · ↓ 3.9k tokens)"},
			filler(liveLines+1)...,
		), false},
		// Three more off the owner's own screen, sent in while this was being
		// written. They are here verbatim because the shapes are the whole rule:
		// the counter is bracketed and the line left behind is not.
		{"a finished turn with something still running", []string{
			"✻ Crunched for 4m 3s · 1 monitor still running",
		}, false},
		{"a turn with a tip drawn under the counter", []string{
			"* Doing… (43m 21s · ↓ 43.5k tokens)",
			"  ⎿  Tip: Use /clear to start fresh when switching topics and free up context",
		}, true},
		// The counter is ten non-blank lines up here: a task list under it, then
		// the input box and two status lines. This is what the bound is generous
		// for — the tail below the counter is as tall as the agent feels like.
		{"a turn above a task list and the input box", []string{
			"✢ Typing sessions by their button… (56m 24s · ↓ 129.5k tokens · thinking)",
			"  ⎿  ✔ Fix detect: multi-line menu options break the run",
			"     ✔ Read the agent's live counter to end a turn without the 30s wait",
			"     ◼ Type a session by the button that started it",
			"     ◼ Popup help over a tab's glyph",
			"",
			"────────────────────────────────",
			"❯ ",
			"────────────────────────────────",
			"  ctx 30% | dms@ai:~/work/pockterm (main)*22?4 $ | Opus 5 (1M context)",
			"  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
		}, true},
		// The pair that broke it: a turn that is thinking rather than spending, so
		// the brackets carry a duration and no tokens at all. Both arrived from the
		// phone — one as the body of a "finished" notice raised mid-thought.
		{"thinking, with no tokens in the brackets", []string{
			"✢ Crunching… (4m 23s · still thinking)",
		}, true},
		{"thinking, said the short way", []string{
			"* Deciphering… (4m 59s · thinking)",
		}, true},
		{"a young turn with nothing to report yet", []string{
			"✻ Scampering… (29s · thinking more)",
		}, true},
		// A turn too young to have a duration: the star and the ellipsis are all
		// there is, and they are enough.
		{"named but not yet counting", []string{"✻ Pondering…"}, true},
		{"a star with no ellipsis is the line the turn left behind", []string{
			"✻ Cooked for 19s",
		}, false},
		// The mark on the agent's own sentences is not a spinner. Reading it as one
		// would make every session with anything on screen look busy for good.
		{"the agent's own words are not a counter", []string{
			"● Готово: правки в трёх файлах…",
			"● Жду прогон.",
		}, false},
		{"nothing on screen", nil, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Live(c.lines); got != c.want {
				t.Fatalf("Live = %v, want %v", got, c.want)
			}
		})
	}
}

// filler is output below the counter — lines with something on them, since
// blank ones do not count against the bound.
func filler(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = "  reading internal/detect/live.go"
	}
	return out
}

// The bound counts lines with something on them: an agent leaves plenty of
// blank ones between its output and its input box, and a counter pushed out of
// range by those would be a turn reported as finished while it runs.
func TestLiveSkipsBlanks(t *testing.T) {
	lines := []string{"✶ Doing… (1m 13s · ↓ 3.9k tokens)"}
	for i := 0; i < liveLines*3; i++ {
		lines = append(lines, "   ")
	}
	if !Live(lines) {
		t.Fatal("blank lines counted against the bound")
	}
}
