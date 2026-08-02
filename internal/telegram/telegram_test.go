package telegram

import (
	"net/http"
	"net/http/httptest"
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
