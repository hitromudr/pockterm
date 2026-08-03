// Package telegram sends notifications through the Telegram Bot API. It
// is a transport and nothing more: what to say is decided elsewhere.
package telegram

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
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

// Chat is somewhere the bot has been spoken to, which is the only way to
// learn a chat id: Telegram gives a bot no directory to look itself up in.
type Chat struct {
	ID    string
	Title string // what to show a human choosing between several
}

// ParseChats pulls the distinct chats out of a getUpdates response, most
// recent first. Unknown fields are ignored, so a Bot API that grows new update
// types does not break setup.
func ParseChats(body []byte) ([]Chat, error) {
	var resp struct {
		OK          bool   `json:"ok"`
		Description string `json:"description"`
		Result      []struct {
			Message struct {
				Chat struct {
					ID        int64  `json:"id"`
					Title     string `json:"title"`
					Username  string `json:"username"`
					FirstName string `json:"first_name"`
					Type      string `json:"type"`
				} `json:"chat"`
			} `json:"message"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("telegram: getUpdates: %w", err)
	}
	if !resp.OK {
		if resp.Description != "" {
			return nil, fmt.Errorf("telegram: getUpdates: %s", resp.Description)
		}
		return nil, errors.New("telegram: getUpdates refused the token")
	}
	seen := make(map[int64]bool)
	var chats []Chat
	for i := len(resp.Result) - 1; i >= 0; i-- {
		c := resp.Result[i].Message.Chat
		if c.ID == 0 || seen[c.ID] {
			continue
		}
		seen[c.ID] = true
		name := c.Title
		if name == "" {
			name = strings.TrimSpace(c.FirstName + " @" + c.Username)
		}
		if name == "" || name == "@" {
			name = c.Type
		}
		chats = append(chats, Chat{ID: strconv.FormatInt(c.ID, 10), Title: name})
	}
	return chats, nil
}

// Chats asks the Bot API who has written to this bot. Only what is still in
// Telegram's update queue is visible — messages older than a day, or already
// consumed by a running bot, are not there.
func (c *Client) Chats() ([]Chat, error) {
	api := c.API
	if api == "" {
		api = DefaultAPI
	}
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := hc.Get(fmt.Sprintf("%s/bot%s/getUpdates", strings.TrimRight(api, "/"), c.Token))
	if err != nil {
		// Same reason as in Send: the token rides in the URL, and a transport
		// error would otherwise carry it into whatever prints the error.
		var uerr *url.Error
		if errors.As(err, &uerr) {
			return nil, fmt.Errorf("telegram: getUpdates: %w", uerr.Err)
		}
		return nil, fmt.Errorf("telegram: getUpdates: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("telegram: getUpdates: %w", err)
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, errors.New("telegram: the bot token was not accepted")
	}
	return ParseChats(body)
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
