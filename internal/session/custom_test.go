package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidCustomRefusesWhatReachesAShell(t *testing.T) {
	// The command becomes CMD= on a make command line and make hands it to the
	// shell inside the recipe, single-quoted. Everything that could end that
	// quoting or start an expansion has to be absent.
	bad := []string{
		"qwen; rm -rf /",
		"qwen && curl example.com",
		"qwen | tee /tmp/x",
		"qwen `id`",
		"qwen $HOME",
		"qwen 'x'",
		`qwen "x"`,
		"qwen\nrm -rf /",
		"$(id)",
		"-c evil",
		"",
		"   ",
		strings.Repeat("q", maxCmd+1),
	}
	for _, cmd := range bad {
		if _, err := ValidCustom(Custom{Label: "x", Cmd: cmd}); err == nil {
			t.Errorf("accepted %q", cmd)
		}
	}
}

func TestValidCustomAcceptsRealCommands(t *testing.T) {
	good := []string{
		"qwen",
		"opencode --yolo",
		"claude --dangerously-skip-permissions",
		"/usr/local/bin/agent-run qwen",
		"python3 -i",
		"env FOO=bar qwen",
		"ollama run qwen2.5-coder:7b",
	}
	for _, cmd := range good {
		if _, err := ValidCustom(Custom{Label: "Qwen", Cmd: cmd}); err != nil {
			t.Errorf("refused %q: %v", cmd, err)
		}
	}
}

func TestValidCustomLabel(t *testing.T) {
	// A label is shown in a menu on a phone, so it is bounded; what it is made of
	// is the owner's business, control characters aside.
	if _, err := ValidCustom(Custom{Label: "", Cmd: "qwen"}); err == nil {
		t.Fatal("a button with no label was accepted")
	}
	if _, err := ValidCustom(Custom{Label: strings.Repeat("л", maxLabel+1), Cmd: "qwen"}); err == nil {
		t.Fatal("an unreadably long label was accepted")
	}
	if _, err := ValidCustom(Custom{Label: "Ку\x07эн", Cmd: "qwen"}); err == nil {
		t.Fatal("a control character in a label was accepted")
	}
	c, err := ValidCustom(Custom{Label: "  Квен  ", Cmd: " qwen "})
	if err != nil {
		t.Fatal(err)
	}
	if c.Label != "Квен" || c.Cmd != "qwen" {
		t.Fatalf("not trimmed: %+v", c)
	}
}

func TestButtonsSetHandsOutIdsAndKeepsThem(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "buttons.json")
	b := LoadButtons(path)
	// A fresh store is the four defaults: a phone with no buttons at all cannot
	// start a session, which is the one thing this package exists for.
	if got := b.List(); len(got) != len(DefaultButtons()) || got[0].ID != "shell" {
		t.Fatalf("a fresh store is not the defaults: %+v", got)
	}

	saved, err := b.Set([]Custom{{Label: "Qwen", Cmd: "qwen"}, {Label: "Open", Cmd: "opencode"}})
	if err != nil {
		t.Fatal(err)
	}
	if saved[0].ID == "" || saved[1].ID == "" || saved[0].ID == saved[1].ID {
		t.Fatalf("ids: %+v", saved)
	}
	first := saved[0].ID

	// A rename keeps the id: the button that was tapped is the same button.
	saved, err = b.Set([]Custom{{ID: first, Label: "Квен", Cmd: "qwen"}, {Label: "Third", Cmd: "python3"}})
	if err != nil {
		t.Fatal(err)
	}
	if saved[0].ID != first {
		t.Fatalf("the id changed under a rename: %+v", saved)
	}
	if saved[1].ID == first {
		t.Fatalf("a new button took a live id: %+v", saved)
	}

	// And it survives a restart, which is why it is on disk at all.
	again := LoadButtons(path)
	got := again.List()
	if len(got) != 2 || got[0].Label != "Квен" || got[0].ID != first {
		t.Fatalf("after a reload: %+v", got)
	}
	c, ok := again.Find(first)
	if !ok || c.Cmd != "qwen" {
		t.Fatalf("Find(%q) = %+v, %v", first, c, ok)
	}
	if _, ok := again.Find("nope"); ok {
		t.Fatal("found a button that was never added")
	}
}

func TestButtonsSetRefusesTheWholeListOnOneBadEntry(t *testing.T) {
	// Half a list saved is worse than none: the page shows what the host has, and
	// a partial save would silently drop the entry the owner was editing.
	b := LoadButtons("")
	if _, err := b.Set([]Custom{{Label: "ok", Cmd: "qwen"}, {Label: "bad", Cmd: "rm -rf / ; :"}}); err == nil {
		t.Fatal("a list with a refused command was accepted")
	}
	if got := b.List(); len(got) != len(DefaultButtons()) {
		t.Fatalf("the refused list replaced what was there: %+v", got)
	}
}

func TestLoadButtonsSurvivesARottenFile(t *testing.T) {
	// The file is hand-editable and what it says ends up on a command line. A
	// broken or dangerous entry costs the button, never the terminal.
	dir := t.TempDir()
	path := filepath.Join(dir, "buttons.json")
	if err := os.WriteFile(path, []byte(`[{"id":"b1","label":"ok","cmd":"qwen"},`+
		`{"id":"b2","label":"evil","cmd":"qwen; rm -rf /"},`+
		`{"label":"no id","cmd":"qwen"}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	// The bare array is the old format, so the defaults are put in front of what
	// it holds — see parseButtons.
	got := LoadButtons(path).List()
	if len(got) != len(DefaultButtons())+1 || got[len(got)-1].ID != "b1" {
		t.Fatalf("kept the wrong entries: %+v", got)
	}

	if err := os.WriteFile(path, []byte("not json at all"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Unreadable is not an answer about the buttons, so the defaults stand.
	if got := LoadButtons(path).List(); len(got) != len(DefaultButtons()) {
		t.Fatalf("garbage was read as buttons: %+v", got)
	}
}

func TestCustomPresetNames(t *testing.T) {
	c := Custom{ID: "b3", Label: "Qwen", Cmd: "qwen"}
	if got := c.PresetName(); got != "custom:b3" {
		t.Fatalf("preset name = %q", got)
	}
	if got := CustomID("custom:b3"); got != "b3" {
		t.Fatalf("CustomID = %q", got)
	}
	// A built-in preset is not a custom one, and must not be mistaken for one.
	for _, p := range []string{"shell", "claude", "yolo", "continue", "custom", ""} {
		if got := CustomID(p); got != "" {
			t.Fatalf("CustomID(%q) = %q", p, got)
		}
	}
}

func TestBuiltinsAreEntriesInTheSameList(t *testing.T) {
	// The four are editable because they are entries, not a map somewhere else.
	// What makes one a default rather than a custom is its id being a make target.
	for _, c := range DefaultButtons() {
		if !c.Builtin() {
			t.Fatalf("%q is a default that is not a known target", c.ID)
		}
		if c.Cmd != "" {
			t.Fatalf("%q ships with a command: %q", c.ID, c.Cmd)
		}
		// A default is asked for by its own name; only the owner's own buttons
		// travel behind the prefix.
		if c.PresetName() != c.ID {
			t.Fatalf("PresetName(%q) = %q", c.ID, c.PresetName())
		}
	}
	own := Custom{ID: "b1", Label: "Qwen", Cmd: "qwen"}
	if own.Builtin() || own.PresetName() != "custom:b1" {
		t.Fatalf("a custom button is not itself: %+v %q", own, own.PresetName())
	}
}

func TestOnlyABuiltinMayHaveNoCommand(t *testing.T) {
	// A button with nothing to run is a button that does nothing — except a
	// default, whose id is the target.
	if _, err := ValidCustom(Custom{ID: "claude", Label: "Claude"}); err != nil {
		t.Fatalf("a default without a command was refused: %v", err)
	}
	if _, err := ValidCustom(Custom{ID: "b1", Label: "Qwen"}); err == nil {
		t.Fatal("a custom button with no command was accepted")
	}
	if _, err := ValidCustom(Custom{Label: "New"}); err == nil {
		t.Fatal("a new button with no command was accepted")
	}
}

func TestResolveIsWhatRunsAndTheListDecides(t *testing.T) {
	b := LoadButtons("")

	// A default runs its own target and carries no command.
	target, cmd, err := b.Resolve("claude")
	if err != nil || target != "claude" || cmd != "" {
		t.Fatalf("Resolve(claude) = %q, %q, %v", target, cmd, err)
	}

	// Give it a command and it goes through the custom target instead, keeping
	// its id — so the tabs it has already opened keep their mark.
	if _, err := b.Set([]Custom{{ID: "claude", Label: "Claude", Cmd: "claude --model opus"}}); err != nil {
		t.Fatal(err)
	}
	target, cmd, err = b.Resolve("claude")
	if err != nil || target != CustomTarget || cmd != "claude --model opus" {
		t.Fatalf("an edited default = %q, %q, %v", target, cmd, err)
	}
	if Kind("claude") != "claude" {
		t.Fatalf("an edited default lost its kind: %q", Kind("claude"))
	}

	// A button that is not in the list cannot be started, however well known its
	// name: otherwise removing one would only have hidden it.
	if _, _, err := b.Resolve("yolo"); err == nil {
		t.Fatal("a removed default was started anyway")
	}
	if _, _, err := b.Resolve("custom:b9"); err == nil {
		t.Fatal("a button that never existed was started")
	}
}

func TestResetPutsTheDefaultsBackAndKeepsTheOwnersOwn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "buttons.json")
	b := LoadButtons(path)
	saved, err := b.Set([]Custom{{ID: "claude", Label: "Клод", Cmd: "claude --model opus"}, {Label: "Qwen", Cmd: "qwen"}})
	if err != nil {
		t.Fatal(err)
	}
	mine := saved[1].ID

	restored, err := b.Reset()
	if err != nil {
		t.Fatal(err)
	}
	if len(restored) != len(DefaultButtons())+1 {
		t.Fatalf("reset = %+v", restored)
	}
	for i, want := range DefaultButtons() {
		if restored[i] != want {
			t.Fatalf("default %d = %+v, want %+v", i, restored[i], want)
		}
	}
	// The four are a default; `qwen` typed on a phone is not, so a reset does not
	// take it away.
	if restored[len(restored)-1].ID != mine {
		t.Fatalf("the owner's own button was lost: %+v", restored)
	}
	if got := LoadButtons(path).List(); len(got) != len(restored) || got[1].Label != "Claude" {
		t.Fatalf("the reset was not written down: %+v", got)
	}
}

func TestRemovingEveryButtonIsAnAnswer(t *testing.T) {
	// An empty stored list means the owner removed them all, which has to survive
	// a restart — the shape of the file is what tells that from a store written
	// before the defaults were in it (parseButtons).
	path := filepath.Join(t.TempDir(), "buttons.json")
	b := LoadButtons(path)
	if _, err := b.Set(nil); err != nil {
		t.Fatal(err)
	}
	if got := LoadButtons(path).List(); len(got) != 0 {
		t.Fatalf("the defaults came back on their own: %+v", got)
	}
}
