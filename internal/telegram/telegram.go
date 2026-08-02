// Package telegram sends notifications through the Telegram Bot API. It
// is a transport and nothing more: what to say is decided elsewhere.
package telegram

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultAPI is Telegram's Bot API root.
const DefaultAPI = "https://api.telegram.org"

type Client struct {
	Token string       // bot token from @BotFather
	Chat  string       // chat id to deliver to
	API   string       // API root; empty means DefaultAPI
	HTTP  *http.Client // nil means a client with a short timeout
}

// Send posts one message. Notifications are not retried: a stale "asks for
// an answer" is worse than a missed one, so the caller just logs failures.
func (c *Client) Send(text string) error {
	api := c.API
	if api == "" {
		api = DefaultAPI
	}
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 10 * time.Second}
	}
	form := url.Values{
		"chat_id":                  {c.Chat},
		"text":                     {text},
		"disable_web_page_preview": {"true"},
	}
	resp, err := hc.Post(
		fmt.Sprintf("%s/bot%s/sendMessage", strings.TrimRight(api, "/"), c.Token),
		"application/x-www-form-urlencoded",
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		// The token is part of the Bot API path, and Go puts the request URL
		// into transport errors. Logged as-is, one failed request writes the
		// bot's credentials into the journal — so unwrap to the cause.
		var uerr *url.Error
		if errors.As(err, &uerr) {
			return fmt.Errorf("telegram: sendMessage: %w", uerr.Err)
		}
		return fmt.Errorf("telegram: sendMessage: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("telegram: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	return nil
}
