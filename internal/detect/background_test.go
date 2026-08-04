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
