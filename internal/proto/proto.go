// Package proto defines the client→server control frames (WS text messages).
package proto

import (
	"encoding/json"
	"fmt"
)

type Control struct {
	Type    string `json:"type"`
	Cols    int    `json:"cols,omitempty"`
	Rows    int    `json:"rows,omitempty"`
	Visible bool   `json:"visible,omitempty"`
	// Where the scrollbar was dragged to: lines back from the live end, 0 being
	// the end itself. Absolute rather than a delta — the page's picture of the
	// pane is up to a poll old, and a delta applied to a position that has moved
	// since lands somewhere nobody asked for.
	Back int `json:"back,omitempty"`
	// How many lines of history the frozen copy asks for. The page has none of
	// its own — tmux repaints the pane instead of letting lines scroll off it —
	// so selecting text further back than the screen means asking the host.
	Lines int `json:"lines,omitempty"`
}

// CaptureMax bounds what a page may ask to have captured. It is a cap on how
// much text one frame carries and how tall a <pre> the phone lays out, not on
// what tmux keeps; a page asking for more gets this much.
const CaptureMax = 5000

// Parse validates a control frame. Known types: "resize" (positive
// cols/rows), "ping", "visible" (the tab went to the background or came back)
// "leave-mode" (something was typed into a pane tmux is holding in copy-mode,
// where keystrokes are discarded), "scroll-to" (the scrollbar was dragged;
// a negative position is refused, since 0 is already the live end) and "capture"
// (the frozen copy selection mode shows, which reaches further back than the
// screen). Anything else is rejected: the data path for keystrokes is binary
// frames, text frames carry control only.
func Parse(data []byte) (Control, error) {
	var c Control
	if err := json.Unmarshal(data, &c); err != nil {
		return Control{}, err
	}
	switch c.Type {
	case "resize":
		if c.Cols <= 0 || c.Rows <= 0 {
			return Control{}, fmt.Errorf("resize needs positive cols/rows, got %dx%d", c.Cols, c.Rows)
		}
	case "scroll-to":
		if c.Back < 0 {
			return Control{}, fmt.Errorf("scroll-to needs a position at or past the live end, got %d", c.Back)
		}
	case "capture":
		// A count rather than a range: the page freezes what is behind the screen
		// it is on, and how far back is its own business up to the cap. Nothing is
		// refused here — a nonsense number is clamped rather than answered with an
		// error, because the answer to this frame is text on a phone.
		if c.Lines < 0 {
			c.Lines = 0
		}
		if c.Lines > CaptureMax {
			c.Lines = CaptureMax
		}
	case "ping", "visible", "leave-mode":
	default:
		return Control{}, fmt.Errorf("unknown control type %q", c.Type)
	}
	return c, nil
}
