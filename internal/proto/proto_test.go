package proto

import "testing"

func TestParseResize(t *testing.T) {
	c, err := Parse([]byte(`{"type":"resize","cols":80,"rows":24}`))
	if err != nil {
		t.Fatal(err)
	}
	if c.Type != "resize" || c.Cols != 80 || c.Rows != 24 {
		t.Fatalf("unexpected control: %+v", c)
	}
}

func TestParsePing(t *testing.T) {
	c, err := Parse([]byte(`{"type":"ping"}`))
	if err != nil || c.Type != "ping" {
		t.Fatalf("ping: %+v, %v", c, err)
	}
}

func TestParseVisible(t *testing.T) {
	// The client reports whether its tab is on screen, so notifications
	// stay quiet for a session the user is actually looking at.
	c, err := Parse([]byte(`{"type":"visible","visible":true}`))
	if err != nil || c.Type != "visible" || !c.Visible {
		t.Fatalf("visible: %+v, %v", c, err)
	}
	c, err = Parse([]byte(`{"type":"visible","visible":false}`))
	if err != nil || c.Visible {
		t.Fatalf("hidden: %+v, %v", c, err)
	}
}

func TestParseScrollTo(t *testing.T) {
	// The scrollbar was dragged: a place in the history, counted back from the
	// live end, which 0 is.
	c, err := Parse([]byte(`{"type":"scroll-to","back":420}`))
	if err != nil || c.Type != "scroll-to" || c.Back != 420 {
		t.Fatalf("scroll-to: %+v, %v", c, err)
	}
	if c, err := Parse([]byte(`{"type":"scroll-to","back":0}`)); err != nil || c.Back != 0 {
		t.Fatalf("the live end is a place too: %+v, %v", c, err)
	}
}

func TestParseCapture(t *testing.T) {
	// What the frozen copy asks for: how far behind the screen to reach.
	c, err := Parse([]byte(`{"type":"capture","lines":2000}`))
	if err != nil || c.Type != "capture" || c.Lines != 2000 {
		t.Fatalf("capture: %+v, %v", c, err)
	}
	// Clamped rather than refused, both ways. What answers this frame is text on
	// a phone with no console: a copy window holding the screen it was opened on
	// is a poorer answer than a long one, and no answer at all is the poorest.
	if c, err := Parse([]byte(`{"type":"capture","lines":-5}`)); err != nil || c.Lines != 0 {
		t.Fatalf("negative: %+v, %v", c, err)
	}
	if c, err := Parse([]byte(`{"type":"capture","lines":9999999}`)); err != nil || c.Lines != CaptureMax {
		t.Fatalf("above the cap: %+v, %v", c, err)
	}
}

func TestRejects(t *testing.T) {
	for _, bad := range []string{
		`{"type":"resize","cols":0,"rows":24}`,
		`{"type":"resize","cols":80,"rows":-1}`,
		`{"type":"exec","cmd":"rm"}`,
		`{"type":"scroll-to","back":-5}`,
		`not json`,
	} {
		if _, err := Parse([]byte(bad)); err == nil {
			t.Fatalf("expected error for %s", bad)
		}
	}
}
