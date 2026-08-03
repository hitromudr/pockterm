package telegram

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSend(t *testing.T) {
	var gotPath, gotChat, gotText string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		gotPath = r.URL.Path
		gotChat = r.PostForm.Get("chat_id")
		gotText = r.PostForm.Get("text")
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := &Client{Token: "42:abc", Chat: "777", API: srv.URL}
	if err := c.Send("hello"); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/bot42:abc/sendMessage" {
		t.Errorf("path = %q", gotPath)
	}
	if gotChat != "777" || gotText != "hello" {
		t.Errorf("chat = %q, text = %q", gotChat, gotText)
	}
}

func TestSendReportsAPIError(t *testing.T) {
	// A wrong token or chat id fails silently unless the status is checked;
	// the caller logs it, so it has to come back as an error.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"ok":false,"description":"Unauthorized"}`))
	}))
	defer srv.Close()

	c := &Client{Token: "bad", Chat: "777", API: srv.URL}
	if err := c.Send("hello"); err == nil {
		t.Fatal("expected an error for a non-200 reply")
	}
}

func TestParseChatsNewestFirstAndDeduplicated(t *testing.T) {
	body := []byte(`{"ok":true,"result":[
		{"update_id":1,"message":{"chat":{"id":777,"type":"private","first_name":"Dee","username":"dee"}}},
		{"update_id":2,"message":{"chat":{"id":-100500,"type":"group","title":"terminal alerts"}}},
		{"update_id":3,"message":{"chat":{"id":777,"type":"private","first_name":"Dee","username":"dee"}}}
	]}`)
	chats, err := ParseChats(body)
	if err != nil {
		t.Fatal(err)
	}
	// Newest first: whoever just wrote to the bot is who the setup means.
	if len(chats) != 2 {
		t.Fatalf("chats = %+v, want two distinct ones", chats)
	}
	if chats[0].ID != "777" || !strings.Contains(chats[0].Title, "Dee") {
		t.Errorf("first chat = %+v", chats[0])
	}
	if chats[1].ID != "-100500" || chats[1].Title != "terminal alerts" {
		t.Errorf("second chat = %+v", chats[1])
	}
}

func TestParseChatsOnAnEmptyQueue(t *testing.T) {
	// Nobody has written to the bot yet; that is not an error, it is the state
	// setup has to explain to the user.
	chats, err := ParseChats([]byte(`{"ok":true,"result":[]}`))
	if err != nil || len(chats) != 0 {
		t.Fatalf("chats = %+v, err = %v", chats, err)
	}
}

func TestParseChatsReportsARefusal(t *testing.T) {
	_, err := ParseChats([]byte(`{"ok":false,"description":"Unauthorized"}`))
	if err == nil || !strings.Contains(err.Error(), "Unauthorized") {
		t.Fatalf("err = %v, want the API's own description", err)
	}
}

func TestChatsAsksTheAPI(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Write([]byte(`{"ok":true,"result":[{"message":{"chat":{"id":42,"type":"private","first_name":"Dee"}}}]}`))
	}))
	defer srv.Close()

	c := &Client{Token: "42:abc", API: srv.URL}
	chats, err := c.Chats()
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/bot42:abc/getUpdates" {
		t.Errorf("path = %q", gotPath)
	}
	if len(chats) != 1 || chats[0].ID != "42" {
		t.Fatalf("chats = %+v", chats)
	}
}

func TestChatsErrorDoesNotLeakTheToken(t *testing.T) {
	c := &Client{Token: "42:supersecret", API: "http://127.0.0.1:1"}
	_, err := c.Chats()
	if err == nil {
		t.Fatal("expected an error against a dead port")
	}
	if strings.Contains(err.Error(), "supersecret") {
		t.Fatalf("the token is in the error: %v", err)
	}
}

func TestSendErrorDoesNotLeakTheToken(t *testing.T) {
	// Go puts the request URL into transport errors, and for the Bot API the
	// token is part of the path. Logged verbatim, one failed request writes
	// the bot's credentials into the journal.
	c := &Client{Token: "42:supersecret", Chat: "777", API: "http://127.0.0.1:1"}
	err := c.Send("hello")
	if err == nil {
		t.Fatal("expected an error against a dead port")
	}
	if strings.Contains(err.Error(), "supersecret") {
		t.Fatalf("the token is in the error: %v", err)
	}
}
