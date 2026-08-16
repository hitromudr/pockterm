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
}

// Parse validates a control frame. Known types: "resize" (positive
// cols/rows), "ping", "visible" (the tab went to the background or came back)
// "leave-mode" (something was typed into a pane tmux is holding in copy-mode,
// where keystrokes are discarded) and "scroll-to" (the scrollbar was dragged;
// a negative position is refused, since 0 is already the live end). Anything
// else is rejected: the data path for keystrokes is binary frames, text frames
// carry control only.
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
	case "ping", "visible", "leave-mode":
	default:
		return Control{}, fmt.Errorf("unknown control type %q", c.Type)
	}
	return c, nil
}
