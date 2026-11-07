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

func TestAButtonMayNameAMakeTarget(t *testing.T) {
	// A Makefile has targets the four do not cover — the author's own has
	// `cont-yolo`. Reaching one from a phone meant typing `make cont-yolo` as a
	// command, which runs make inside the session the button just created: a second
	// session appears beside it and the first one dies.
	c, err := ValidCustom(Custom{ID: "b2", Label: "Cont yolo", Cmd: "make cont-yolo"})
	if err != nil {
		t.Fatal(err)
	}
	if c.Target != "cont-yolo" || c.Cmd != "" {
		t.Fatalf("`make cont-yolo` = %+v", c)
	}

	b := LoadButtons("")
	if _, err := b.Set([]Custom{{ID: "b2", Label: "Cont yolo", Target: "cont-yolo"}}); err != nil {
		t.Fatal(err)
	}
	target, cmd, err := b.Resolve("custom:b2")
	if err != nil || target != "cont-yolo" || cmd != "" {
		t.Fatalf("Resolve = %q, %q, %v", target, cmd, err)
	}
}

func TestOnlyAMakeTargetLooksLikeOne(t *testing.T) {
	// Everything else stays a command, because that is what it is: the shape has to
	// be exactly `make <one target>`, or `make -C /elsewhere all` would pass as a
	// target and reach a command line as one.
	for _, cmd := range []string{"make", "make -C /elsewhere all", "make two targets", "makefile", "make Cap"} {
		c, err := ValidCustom(Custom{ID: "b1", Label: "x", Cmd: cmd})
		if err != nil {
			continue // refused as a command, which is also an answer
		}
		if c.Target != "" {
			t.Errorf("%q was read as the target %q", cmd, c.Target)
		}
	}
}

func TestATargetIsNotACommandAndNotBoth(t *testing.T) {
	if _, err := ValidCustom(Custom{ID: "b1", Label: "x", Cmd: "qwen", Target: "yolo"}); err == nil {
		t.Fatal("a button carrying both was accepted")
	}
	if _, err := ValidCustom(Custom{ID: "b1", Label: "x", Target: "rm -rf /"}); err == nil {
		t.Fatal("a target with a space in it was accepted")
	}
	if _, err := ValidCustom(Custom{ID: "b1", Label: "x", Target: "$(shell id)"}); err == nil {
		t.Fatal("a target that could reach a shell was accepted")
	}
}

func TestAMarkIsOneGlyph(t *testing.T) {
	// Picked from a grid rather than typed into the label, which is what it was:
	// three custom buttons all drew the same star until somebody knew that trick.
	for _, mark := range []string{"❄", "☀", "🐍", "🇺🇦", ""} {
		if _, err := ValidCustom(Custom{ID: "b1", Label: "x", Cmd: "qwen", Mark: mark}); err != nil {
			t.Errorf("mark %q was refused: %v", mark, err)
		}
	}
	// Trimmed at the edges like every other field; refused when the trouble is
	// inside it.
	for _, bad := range []string{"a b", "❄\n❄", "way too many glyphs here"} {
		if _, err := ValidCustom(Custom{ID: "b1", Label: "x", Cmd: "qwen", Mark: bad}); err == nil {
			t.Errorf("mark %q was accepted", bad)
		}
	}
	// It survives the trip to disk and back, or a picked glyph would last until the
	// next restart — which CI does several times a working day.
	path := filepath.Join(t.TempDir(), "buttons.json")
	b := LoadButtons(path)
	if _, err := b.Set([]Custom{{ID: "b1", Label: "Codex", Cmd: "codex", Mark: "☀"}}); err != nil {
		t.Fatal(err)
	}
	got := LoadButtons(path).List()
	if got[len(got)-1].Mark != "☀" {
		t.Fatalf("the mark was not kept: %+v", got)
	}
}

func TestMatchStartKind(t *testing.T) {
	buttons := []Custom{
		{ID: "yolo", Label: "Claude (yolo)", Mark: "❄️"},
		{ID: "b1", Label: "Codex (yolo)", Cmd: "/home/dms/.local/bin/codex -a never", Mark: "❇️"},
		{ID: "b3", Label: "Codex-cont (yolo)", Cmd: "/home/dms/.local/bin/codex resume --last -a never", Mark: "❇️"},
		{ID: "b7", Label: "Gemini 4 (yolo)", Cmd: "/home/dms/.local/bin/gemini --yolo -m gemini-4-argon", Mark: "✴️"},
		{ID: "b8", Label: "Gemini 4 Cont (yolo)", Cmd: "/home/dms/.local/bin/gemini --yolo -r latest -m gemini-4-argon", Mark: "✴️"},
	}

	// Leaked MAKEFLAGS on ser8 (2026-11-05): Vita-g was started with gemini-safe
	// but inherited KIND=custom:b1 (Codex) from MAKEFLAGS in the parent shell.
	vitaStart := `"t0=$(date +%s); env -u PREFIX -u DIR -u KIND -u CMD -u MAKEFLAGS -u MAKELEVEL AGENT_COMMAND=gemini-safe agent-run --yolo; st=$?"`
	if got := MatchStartKind(buttons, "custom:b1", vitaStart); got != "custom:b7" {
		t.Errorf("leaked Codex kind on Gemini session: got %q, want custom:b7", got)
	}
	// Bare `custom` from a manual `make custom CMD='gemini-safe --yolo -i …'`
	// (pockterm-g, yarr-g) resolves to the host's Gemini button.
	if got := MatchStartKind(buttons, "custom", vitaStart); got != "custom:b7" {
		t.Errorf("bare custom on Gemini session: got %q, want custom:b7", got)
	}
	// Unstamped Gemini session (anabasis-g).
	anaStart := `"env AGENT_COMMAND=/home/dms/.local/bin/gemini /usr/local/bin/agent-run --yolo -m gemini-4-argon"`
	if got := MatchStartKind(buttons, "", anaStart); got != "custom:b7" {
		t.Errorf("unstamped Gemini session: got %q, want custom:b7", got)
	}
	// A session genuinely started with Gemini Cont (custom:b8) keeps custom:b8.
	contStart := `"/home/dms/.local/bin/gemini --yolo -r latest -m gemini-4-argon"`
	if got := MatchStartKind(buttons, "custom:b8", contStart); got != "custom:b8" {
		t.Errorf("Gemini Cont session lost its button: got %q, want custom:b8", got)
	}
	// Mentioning "gemini" or "codex" inside a prompt argument of a Claude relay
	// never turns a Claude session into Gemini.
	relayClaude := `"/usr/local/bin/agent-run --dangerously-skip-permissions --session-id abc 'Read gemini and codex notes'"`
	if got := MatchStartKind(buttons, "yolo", relayClaude); got != "yolo" {
		t.Errorf("Claude session with prompt mentioning gemini: got %q, want yolo", got)
	}
	// A non-agent command keeps whatever kind it had.
	if got := MatchStartKind(buttons, "custom:b1", "sleep 30"); got != "custom:b1" {
		t.Errorf("non-agent command changed kind: got %q, want custom:b1", got)
	}
}

func TestMatchStartKindTellsGeminiModesApart(t *testing.T) {
	// Gemini in two modes (2026-11-06): gemini-sub-safe (subscription, its own
	// exit) and gemini-key-safe (API key). Each session belongs to its own
	// button, not to whichever Gemini button comes first.
	buttons := []Custom{
		{ID: "b7", Label: "Gemini Key (yolo)", Cmd: "gemini-key-safe --yolo -m gemini-4-argon"},
		{ID: "b8", Label: "Gemini Key Cont (yolo)", Cmd: "gemini-key-safe --yolo -r latest -m gemini-4-argon"},
		{ID: "b9", Label: "Gemini Sub (yolo)", Cmd: "gemini-sub-safe --yolo -m gemini-4-argon"},
		{ID: "b10", Label: "Gemini Sub Cont (yolo)", Cmd: "gemini-sub-safe --yolo -r latest -m gemini-4-argon"},
	}
	cases := []struct{ start, want string }{
		{`"env -u KIND AGENT_COMMAND=gemini-sub-safe agent-run --yolo -m gemini-4-argon"`, "custom:b9"},
		{`"env -u KIND AGENT_COMMAND=gemini-sub-safe agent-run --yolo -r latest -m gemini-4-argon"`, "custom:b10"},
		{`"env -u KIND AGENT_COMMAND=gemini-key-safe agent-run --yolo -m gemini-4-argon"`, "custom:b7"},
		{`"env -u KIND AGENT_COMMAND=gemini-key-safe agent-run --yolo -r latest -m gemini-4-argon"`, "custom:b8"},
	}
	for _, c := range cases {
		if got := MatchStartKind(buttons, "custom", c.start); got != c.want {
			t.Errorf("%s: got %q, want %q", c.start, got, c.want)
		}
	}
	// A key-mode session stamped with a subscription button is re-labelled.
	if got := MatchStartKind(buttons, "custom:b9", cases[2].start); got != "custom:b7" {
		t.Errorf("key session under a subscription button: got %q, want custom:b7", got)
	}
	// A mode-stamped session relayed by the bare agent binary keeps its mode button,
	// and an unstamped bare-binary session falls back to the host's mode button.
	bareGemini := `"env AGENT_COMMAND=/home/dms/.local/bin/gemini /usr/local/bin/agent-run --yolo -m gemini-4-argon"`
	if got := MatchStartKind(buttons, "custom:b9", bareGemini); got != "custom:b9" {
		t.Errorf("relayed subscription session lost its mode button: got %q, want custom:b9", got)
	}
	if got := MatchStartKind(buttons[:2], "", bareGemini); got != "custom:b7" {
		t.Errorf("unstamped bare gemini session did not fall back to mode button: got %q, want custom:b7", got)
	}
	// Claude in two contours (2026-11-07): claude-ge-safe (G) vs default (W).
	claudeBtns := []Custom{
		{ID: "yolo", Label: "Claude W (yolo)", Mark: "❄️"},
		{ID: "b2", Label: "Claude W Cont (yolo)", Target: "cont-yolo", Mark: "❄️"},
		{ID: "b9", Label: "Claude G (yolo)", Cmd: "claude-ge-safe --dangerously-skip-permissions", Mark: "❄️"},
		{ID: "b10", Label: "Claude G Cont (yolo)", Cmd: "claude-ge-safe -c --dangerously-skip-permissions", Mark: "❄️"},
	}
	geStart := `"env -u KIND AGENT_COMMAND=claude-ge-safe agent-run '--dangerously-skip-permissions'"`
	geCont := `"env -u KIND AGENT_COMMAND=claude-ge-safe agent-run '-c' '--dangerously-skip-permissions'"`
	if got := MatchStartKind(claudeBtns, "custom", geStart); got != "custom:b9" {
		t.Errorf("claude-ge start: got %q, want custom:b9", got)
	}
	if got := MatchStartKind(claudeBtns, "yolo", geCont); got != "custom:b10" {
		t.Errorf("claude-ge cont under yolo stamp: got %q, want custom:b10", got)
	}
	// Plain gemini-safe is still Gemini, and not one of the modes.
	if got := normAgent("/usr/local/bin/gemini-safe"); got != "gemini" {
		t.Errorf("gemini-safe: got %q", got)
	}
	if got := normAgent("geminix-safe"); got != "" {
		t.Errorf("an unknown agent family was accepted: %q", got)
	}
}
