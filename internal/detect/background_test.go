package detect

import "testing"

func TestReadBackgroundFromTheFooter(t *testing.T) {
	// The footer of Claude Code as it stands on the owner's phone: the status
	// line under the input box, sometimes with a limit warning below it.
	lines := []string{
		"● Ждать очередь прогонов на dms2.",
		"",
		"───────────────────────────────",
		"❯ ",
		"───────────────────────────────",
		"  ctx 45% | dms@ai:~/work/exante (main) $ | Opu…",
		"  bypass permissions on · 1 shell, 1 monitor ·",
	}
	got := ReadBackground(lines)
	if got.Shells != 1 || got.Monitors != 1 {
		t.Fatalf("got %+v, want 1 shell and 1 monitor", got)
	}
	if got.Total() != 2 {
		t.Fatalf("total = %d, want 2", got.Total())
	}
}

func TestReadBackgroundPlural(t *testing.T) {
	lines := []string{"  bypass permissions on · 2 shells, 13 monitors ·"}
	got := ReadBackground(lines)
	if got.Shells != 2 || got.Monitors != 13 {
		t.Fatalf("got %+v, want 2 shells and 13 monitors", got)
	}
}

func TestReadBackgroundIgnoresAFinishedTurn(t *testing.T) {
	// "still running" is what the agent printed when a turn ended. It was true
	// then; the footer is what is true now, and here it claims nothing.
	lines := []string{
		"✳ Cogitated for 2m 23s · 1 shell, 1 monitor still running",
		"",
		"  ctx 45% | dms@ai:~/work/exante (main) $ | Opu…",
		"  bypass permissions on",
	}
	if got := ReadBackground(lines); got.Total() != 0 {
		t.Fatalf("got %+v, want nothing claimed", got)
	}
}

func TestReadBackgroundIgnoresScrolledOutput(t *testing.T) {
	// The same words in output that has scrolled well above the footer are
	// history, not a state — the footer is only ever the last few lines.
	lines := []string{
		"  the run took 3 shells, 2 monitors and a lot of patience",
		"a", "b", "c", "d",
		"  ctx 12% | dms@ai:~/work (main) $",
	}
	if got := ReadBackground(lines); got.Total() != 0 {
		t.Fatalf("got %+v, want nothing claimed", got)
	}
}

func TestReadBackgroundQuietFooter(t *testing.T) {
	lines := []string{"❯ ", "  ctx 4% | dms@ai:~/work/pockterm (main) $ | Opu…", "  ⏸ manual mode on · ← for agents"}
	if got := ReadBackground(lines); got.Total() != 0 {
		t.Fatalf("got %+v, want nothing claimed", got)
	}
}

func TestReadBackgroundSeesThroughAnsi(t *testing.T) {
	lines := []string{"\x1b[2m  bypass permissions on · \x1b[0m1 shell\x1b[2m, 1 monitor ·\x1b[0m"}
	got := ReadBackground(lines)
	if got.Shells != 1 || got.Monitors != 1 {
		t.Fatalf("got %+v, want 1 shell and 1 monitor", got)
	}
}

func TestReadBackgroundEmptyPane(t *testing.T) {
	if got := ReadBackground(nil); got.Total() != 0 {
		t.Fatalf("got %+v, want nothing claimed", got)
	}
}

// The block as the agent draws it, captured off a real pane at 51 columns with
// three subagents on it. The circle is U+25EF, and the `● main` above them is
// what tells the block from a stray glyph in output.
func TestReadAgentsCountsTheAgentsList(t *testing.T) {
	pane := []string{
		"● Bash(ls -la)",
		"  ⎿  done",
		"  ctx 54% | dms@ai:~/work/pockterm (main) $ | Op…",
		"  ⏵⏵ bypass permissions on · 2 shells · ← for ag…",
		"  ● main",
		"  ◯ general-purpose  Count fi… 11s · ↓ 49.3k tokens",
		"  ◯ general-purpose  Probe ag…  7s · ↓ 48.9k tokens",
		"  ◯ general-purpose  Probe ag…  9s · ↓ 49.2k tokens",
	}
	if got := ReadAgents(pane); got != 3 {
		t.Errorf("ReadAgents = %d, want 3", got)
	}
	// The same pane with the block gone says nothing.
	if got := ReadAgents(pane[:4]); got != 0 {
		t.Errorf("ReadAgents without the block = %d, want 0", got)
	}
}

func TestReadAgentsNeedsTheBlocksOwnHead(t *testing.T) {
	// A circle in output is not an agent. Without `● main` above them there is
	// no list, and a pane full of prose must not grow heads on its tab.
	loose := []string{
		"● Разобрал варианты:",
		"  ◯ первый",
		"  ◯ второй",
	}
	if got := ReadAgents(loose); got != 0 {
		t.Errorf("ReadAgents = %d on a list in prose, want 0", got)
	}
	if got := ReadAgents(nil); got != 0 {
		t.Errorf("ReadAgents(nil) = %d, want 0", got)
	}
}

func TestReadBackgroundStepsOverTheAgentsBlock(t *testing.T) {
	// The block is footer too, and it is as tall as the session has subagents.
	// Counted against the window, three of them pushed the line that says what is
	// running out of range — the plates went away while the shell was still there.
	pane := []string{
		"● Bash(make check)",
		"  ctx 54% | dms@ai:~/work/pockterm (main) $ | Op…",
		"  ⏵⏵ bypass permissions on · 1 shell, 2 monitors ·",
		"  ● main",
		"  ◯ general-purpose  Один   11s",
		"  ◯ general-purpose  Второй  7s",
		"  ◯ general-purpose  Третий  9s",
	}
	got := ReadBackground(pane)
	if got.Shells != 1 || got.Monitors != 2 {
		t.Errorf("ReadBackground = %+v, want 1 shell and 2 monitors", got)
	}
}

func TestReadBackgroundReadsAClippedWord(t *testing.T) {
	// The status line is clipped at the pane's width rather than wrapped, and a
	// phone gives a shared window 48 columns — so the line that says both kinds
	// arrives with the last word cut in half, and the monitor's plate went
	// missing on every session that had one beside a shell. Captured off the
	// owner's pane at 48 columns, 08.09.2026.
	lines := []string{
		"  ctx 66% | dms@ai:~/work/exante (main)*1?2 $…",
		"  ⏵⏵ bypass permissions on · 1 shell, 1 monito",
	}
	got := ReadBackground(lines)
	if got.Shells != 1 || got.Monitors != 1 {
		t.Fatalf("got %+v, want 1 shell and 1 monitor", got)
	}
}

func TestReadBackgroundReadsAClippedWordWithTheEllipsis(t *testing.T) {
	lines := []string{"  ⏵⏵ bypass permissions on · 2 shel…"}
	if got := ReadBackground(lines); got.Shells != 2 || got.Monitors != 0 {
		t.Fatalf("got %+v, want 2 shells", got)
	}
}

func TestReadBackgroundRefusesAStump(t *testing.T) {
	// Two letters name nothing: "mo" is as much a month as a monitor, and a
	// plate drawn on a guess claims something the session never said. The count
	// is still the agent's own, so it is carried as one without a kind — and
	// once, not twice, though the bare-tail pattern covers the same letters.
	lines := []string{"  ⏵⏵ bypass permissions on · 1 shell, 1 mo…"}
	got := ReadBackground(lines)
	if got.Shells != 1 || got.Monitors != 0 || got.Other != 1 {
		t.Fatalf("got %+v, want the shell and one unnamed", got)
	}
}

func TestReadBackgroundReadsACountTheWidthAte(t *testing.T) {
	// The whole word gone, not half of it. Captured off the owner's pane at 48
	// columns, 13.09.2026: the session had three shells and three monitors, the
	// agent's own line printed "3 shells, 3" and stopped, and the tab drew the
	// shells alone — reported as three monitors being invisible in any
	// orientation of the phone.
	lines := []string{
		"  ctx 77% | dms@ai:~/work/anabasis (main)↑2 $…",
		"  ⏵⏵ bypass permissions on · 3 shells, 3",
		"        ✔ Update installed · Restart to update",
	}
	got := ReadBackground(lines)
	if got.Shells != 3 || got.Monitors != 0 || got.Other != 3 {
		t.Fatalf("got %+v, want 3 shells and 3 unnamed", got)
	}
	if got.Total() != 6 {
		t.Fatalf("total = %d, want 6", got.Total())
	}
}

func TestReadBackgroundNamesWhatFits(t *testing.T) {
	// The same session in the other orientation, where the line fits whole: both
	// kinds are named, and nothing is left over to count without a name.
	lines := []string{
		"  ctx 76% | dms@ai:~/work/anabasis (main)↑2 $ | Opus 5 (1M context)",
		"    ⏵⏵ bypass permissions on · 3 shells, 3 monitors · ← for agents",
		"          ✔ Update installed · Restart to update",
	}
	got := ReadBackground(lines)
	if got.Shells != 3 || got.Monitors != 3 || got.Other != 0 {
		t.Fatalf("got %+v, want 3 shells and 3 monitors named", got)
	}
}

func TestReadBackgroundCountsNothingUnnamedOnItsOwn(t *testing.T) {
	// A bare number at the end of a line is only the footer's list cut short if
	// that line is the footer's list: a line that names neither kind is output,
	// and the search goes on up instead of answering from it.
	lines := []string{
		"● Read 1 file, 3",
		"  ⏵⏵ bypass permissions on",
	}
	if got := ReadBackground(lines); got.Total() != 0 {
		t.Fatalf("got %+v, want nothing claimed", got)
	}
}

func TestReadBackgroundReadsAClippedWordOnlyAtTheEnd(t *testing.T) {
	// The width can only cut the end of a line. A word that looks like the start
	// of one with the line continuing past it is prose.
	lines := []string{"  ⏵⏵ bypass permissions on · 1 mon of the thing · 1 shell ·"}
	got := ReadBackground(lines)
	if got.Shells != 1 || got.Monitors != 0 || got.Other != 0 {
		t.Fatalf("got %+v, want the shell alone", got)
	}
}

func TestReadBackgroundIgnoresACountOfSomethingElse(t *testing.T) {
	// A count in the footer is not a count of these two. The line matches the
	// shape and names neither kind, so the search goes on up rather than
	// answering nothing from it.
	lines := []string{
		"  ⏵⏵ bypass permissions on · 1 shell, 2 monitors ·",
		"● Read 1 file (ctrl+o to expand)",
	}
	got := ReadBackground(lines)
	if got.Shells != 1 || got.Monitors != 2 {
		t.Fatalf("got %+v, want 1 shell and 2 monitors", got)
	}
}
