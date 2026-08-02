package detect

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The fixtures are shared with web/js/detect.js: the browser draws answer
// buttons from one implementation and the notifier reads the same screen
// with the other, so they are held to the same verdicts.
type fixture struct {
	Cases []struct {
		Name   string   `json:"name"`
		Lines  []string `json:"lines"`
		Expect *struct {
			Prompt  string   `json:"prompt"`
			Options []Option `json:"options"`
		} `json:"expect"`
	} `json:"cases"`
}

func TestSharedFixtures(t *testing.T) {
	path := filepath.Join("..", "..", "test", "fixtures", "menus.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cases) == 0 {
		t.Fatal("no fixtures loaded")
	}
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			got := Question(c.Lines)
			if c.Expect == nil {
				if got != nil {
					t.Fatalf("expected no menu, got %+v", got)
				}
				return
			}
			if got == nil {
				t.Fatal("expected a menu, got none")
			}
			if got.Prompt != c.Expect.Prompt {
				t.Errorf("prompt = %q, want %q", got.Prompt, c.Expect.Prompt)
			}
			if len(got.Options) != len(c.Expect.Options) {
				t.Fatalf("options = %+v, want %+v", got.Options, c.Expect.Options)
			}
			for i, o := range got.Options {
				if o != c.Expect.Options[i] {
					t.Errorf("option %d = %+v, want %+v", i, o, c.Expect.Options[i])
				}
			}
		})
	}
}

func TestStripsAnsi(t *testing.T) {
	// capture-pane -e or a raw PTY capture carries escapes; the parser has
	// to see through them.
	lines := []string{
		"\x1b[1mApply this change?\x1b[0m",
		"\x1b[36m❯ 1. Yes\x1b[0m",
		"  2. No",
	}
	q := Question(lines)
	if q == nil {
		t.Fatal("expected a menu")
	}
	if q.Prompt != "Apply this change?" {
		t.Fatalf("prompt = %q", q.Prompt)
	}
	if q.Options[0].Label != "Yes" {
		t.Fatalf("label = %q", q.Options[0].Label)
	}
}
