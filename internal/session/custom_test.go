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
	if len(b.List()) != 0 {
		t.Fatal("a fresh store is not empty")
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
	if len(b.List()) != 0 {
		t.Fatalf("the refused list was stored anyway: %+v", b.List())
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
	got := LoadButtons(path).List()
	if len(got) != 1 || got[0].ID != "b1" {
		t.Fatalf("kept the wrong entries: %+v", got)
	}

	if err := os.WriteFile(path, []byte("not json at all"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := LoadButtons(path).List(); len(got) != 0 {
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
