package push

import (
	"crypto/ecdh"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The worked example from RFC 8291 §5, with the intermediate values from its
// Appendix A. Every number below is copied from the RFC and nothing here is
// derived from this implementation — which is the point: a round trip against
// ourselves would pass with the key derivation in the wrong order, and the
// phone would silently discard every message.
const (
	rfcPlaintext  = "When I grow up, I want to be a watermelon"
	rfcUAPublic   = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
	rfcUAPrivate  = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"
	rfcAuthSecret = "BTBZMqHH6r4Tts7J_aSIgg"
	rfcASPrivate  = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"
	rfcASPublic   = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
	rfcSalt       = "DGv6ra1nlYgDCS1FRnbzlw"
	rfcBody       = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
)

func rfcSubscription() Subscription {
	var sub Subscription
	sub.Endpoint = "https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV"
	sub.Keys.P256dh = rfcUAPublic
	sub.Keys.Auth = rfcAuthSecret
	return sub
}

func TestEncryptMatchesTheRFCExample(t *testing.T) {
	// The one test that says this package talks to real push services. It fixes
	// both sources of randomness — the sender's key pair and the salt — because
	// those are the only things that differ between this and a live send.
	raw, err := b64.DecodeString(rfcASPrivate)
	if err != nil {
		t.Fatal(err)
	}
	ephemeral, err := ecdh.P256().NewPrivateKey(raw)
	if err != nil {
		t.Fatal(err)
	}
	salt, err := b64.DecodeString(rfcSalt)
	if err != nil {
		t.Fatal(err)
	}
	body, err := Encrypt(rfcSubscription(), []byte(rfcPlaintext), ephemeral, salt)
	if err != nil {
		t.Fatal(err)
	}
	if got := b64.EncodeToString(body); got != rfcBody {
		t.Fatalf("body does not match RFC 8291 §5\n got %s\nwant %s", got, rfcBody)
	}
}

func TestEncryptedBodyIsShapedLikeARecord(t *testing.T) {
	// RFC 8188's header, read back off our own output: 16 bytes of salt, the
	// record size, the length of the key, then the key itself. A receiver reads
	// these before it can derive anything, so a wrong length here is a message
	// discarded without a word.
	body, err := Encrypt(rfcSubscription(), []byte("hi"), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(body) < 16+4+1+65 {
		t.Fatalf("body of %d bytes is shorter than the header", len(body))
	}
	if rs := uint32(body[16])<<24 | uint32(body[17])<<16 | uint32(body[18])<<8 | uint32(body[19]); rs != recordSize {
		t.Fatalf("record size = %d, want %d", rs, recordSize)
	}
	if body[20] != 65 {
		t.Fatalf("key length = %d, want 65", body[20])
	}
	if body[21] != 4 {
		t.Fatalf("the key does not start with the uncompressed-point marker: %d", body[21])
	}
}

func TestTwoSendsOfTheSameTextDiffer(t *testing.T) {
	// The salt and the sender's key are fresh every time. Identical bodies would
	// mean one of the two was not.
	a, err := Encrypt(rfcSubscription(), []byte("same"), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Encrypt(rfcSubscription(), []byte("same"), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(a) == string(b) {
		t.Fatal("two encryptions of one text came out identical")
	}
}

func TestAKeyThatIsNotAPointIsRefused(t *testing.T) {
	// What a truncated or corrupted stored subscription looks like. Refused
	// here, where the error names the subscription, rather than as a 400 from a
	// push service hours later.
	sub := rfcSubscription()
	sub.Keys.P256dh = b64.EncodeToString([]byte("not a point"))
	if _, err := Encrypt(sub, []byte("x"), nil, nil); err == nil {
		t.Fatal("a key that is not a P-256 point was accepted")
	}
}

// --- what goes on the wire -------------------------------------------------

func TestSendCarriesTheHeadersAPushServiceRequires(t *testing.T) {
	var got *http.Request
	var body []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		body = readAll(r)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	keys, err := NewKeys()
	if err != nil {
		t.Fatal(err)
	}
	sub := rfcSubscription()
	sub.Endpoint = srv.URL + "/push/abc"
	c := &Client{Keys: keys, Subject: "mailto:nobody@example.com", HTTP: srv.Client()}
	if err := c.Send(sub, []byte(`{"title":"x"}`)); err != nil {
		t.Fatal(err)
	}
	if got.Header.Get("Content-Encoding") != "aes128gcm" {
		t.Fatalf("Content-Encoding = %q", got.Header.Get("Content-Encoding"))
	}
	if got.Header.Get("TTL") == "" {
		t.Fatal("no TTL: a service with no TTL drops the message for a phone that is offline")
	}
	token, key, err := Signed(got.Header.Get("Authorization"))
	if err != nil {
		t.Fatal(err)
	}
	if key != keys.Public {
		t.Fatalf("the header carries %q, the subscription was made for %q", key, keys.Public)
	}
	if len(strings.Split(token, ".")) != 3 {
		t.Fatalf("the token is not a JWT: %q", token)
	}
	if len(body) == 0 {
		t.Fatal("the body never arrived")
	}
}

func TestAGoneSubscriptionIsSaidSoRatherThanRetried(t *testing.T) {
	// 404 and 410 are the two answers that mean the device will never take
	// another message on this endpoint. Anything else is this end's problem and
	// the subscription stays.
	for _, code := range []int{http.StatusNotFound, http.StatusGone} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(code)
		}))
		keys, err := NewKeys()
		if err != nil {
			t.Fatal(err)
		}
		sub := rfcSubscription()
		sub.Endpoint = srv.URL + "/push/abc"
		err = (&Client{Keys: keys, HTTP: srv.Client()}).Send(sub, []byte("{}"))
		if !Gone(err) {
			t.Fatalf("%d: err = %v, want a gone subscription", code, err)
		}
		srv.Close()
	}
}

func TestARefusalThatIsNotGoneKeepsTheSubscription(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte("slow down"))
	}))
	defer srv.Close()
	keys, err := NewKeys()
	if err != nil {
		t.Fatal(err)
	}
	sub := rfcSubscription()
	sub.Endpoint = srv.URL + "/push/abc"
	err = (&Client{Keys: keys, HTTP: srv.Client()}).Send(sub, []byte("{}"))
	if err == nil {
		t.Fatal("a refusal was reported as a delivery")
	}
	if Gone(err) {
		t.Fatal("a rate limit must not cost the subscription")
	}
	if !strings.Contains(err.Error(), "slow down") {
		t.Fatalf("the journal would not say why: %v", err)
	}
}

// --- the VAPID header ------------------------------------------------------

func TestTheAudienceIsTheOriginAndNotThePath(t *testing.T) {
	// Several push services refuse a token whose audience carries the path, and
	// the refusal is a 401 — indistinguishable from a wrong key.
	keys, err := NewKeys()
	if err != nil {
		t.Fatal(err)
	}
	header, err := keys.Authorization("https://fcm.googleapis.com/fcm/send/abc123", "mailto:x@example.com", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := Signed(header)
	if err != nil {
		t.Fatal(err)
	}
	claims := claimsOf(t, token)
	if claims["aud"] != "https://fcm.googleapis.com" {
		t.Fatalf("aud = %v", claims["aud"])
	}
	if claims["sub"] != "mailto:x@example.com" {
		t.Fatalf("sub = %v", claims["sub"])
	}
}

func TestTheTokenExpiresWithinADay(t *testing.T) {
	// The RFC caps it at 24 hours and services enforce it; a token that outlived
	// the cap would be refused by everything, everywhere, at once.
	keys, err := NewKeys()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_700_000_000, 0)
	header, err := keys.Authorization("https://push.example.net/x", "", now)
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := Signed(header)
	if err != nil {
		t.Fatal(err)
	}
	exp, ok := claimsOf(t, token)["exp"].(float64)
	if !ok {
		t.Fatal("no exp in the token")
	}
	if d := time.Unix(int64(exp), 0).Sub(now); d <= 0 || d > 24*time.Hour {
		t.Fatalf("the token is good for %s", d)
	}
}

func TestTheSignatureIsSixtyFourBytes(t *testing.T) {
	// JWS wants r||s padded to the curve size, not the ASN.1 sequence Go signs
	// with by default. The wrong one is a 401 that looks like a wrong key.
	keys, err := NewKeys()
	if err != nil {
		t.Fatal(err)
	}
	header, err := keys.Authorization("https://push.example.net/x", "", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := Signed(header)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(token, ".")
	sig, err := b64.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	if len(sig) != 64 {
		t.Fatalf("signature of %d bytes, want 64", len(sig))
	}
}

func TestKeysSurviveARestart(t *testing.T) {
	// The public half is baked into every subscription a browser made. A new
	// pair at startup means every device is silently unreachable until it
	// subscribes again — and CI restarts this binary several times a day.
	dir := t.TempDir()
	path := filepath.Join(dir, "vapid.json")
	first, err := LoadKeys(path)
	if err != nil {
		t.Fatal(err)
	}
	again, err := LoadKeys(path)
	if err != nil {
		t.Fatal(err)
	}
	if first.Public != again.Public {
		t.Fatalf("the key changed across a restart: %s then %s", first.Public, again.Public)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("the private key is %v, want 0600", info.Mode().Perm())
	}
	// And it signs with what it read back, not with a fresh key that happens to
	// have the same file beside it.
	header, err := again.Authorization("https://push.example.net/x", "", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, key, err := Signed(header); err != nil || key != first.Public {
		t.Fatalf("signed with %q, want %q (%v)", key, first.Public, err)
	}
}

func TestABrokenKeyFileIsAnErrorRatherThanAFreshKey(t *testing.T) {
	// Starting over silently would cost every subscription there is, and nothing
	// would say why the phone went quiet.
	path := filepath.Join(t.TempDir(), "vapid.json")
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadKeys(path); err == nil {
		t.Fatal("a broken key file was replaced without a word")
	}
}

// --- the subscriptions on disk ---------------------------------------------

func TestSubscriptionsSurviveARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "push.json")
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Add(subFor("https://push.example.net/a", "phone")); err != nil {
		t.Fatal(err)
	}
	again, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := again.List(); len(got) != 1 || got[0].Endpoint != "https://push.example.net/a" {
		t.Fatalf("after a restart: %+v", got)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("subscriptions are %v, want 0600", info.Mode().Perm())
	}
}

func TestOneDeviceIsOneSubscription(t *testing.T) {
	// A browser hands out a new endpoint on its own schedule — a reinstall, a
	// renewed subscription, a cleared site setting — and the old one keeps
	// accepting messages the device no longer draws. Left alone, one phone
	// becomes five subscriptions, four of them silent.
	store, err := OpenStore(filepath.Join(t.TempDir(), "push.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Add(subFor("https://push.example.net/old", "phone")); err != nil {
		t.Fatal(err)
	}
	if err := store.Add(subFor("https://push.example.net/new", "phone")); err != nil {
		t.Fatal(err)
	}
	if err := store.Add(subFor("https://push.example.net/laptop", "laptop")); err != nil {
		t.Fatal(err)
	}
	got := store.List()
	if len(got) != 2 {
		t.Fatalf("want the phone once and the laptop once, got %d: %+v", len(got), got)
	}
	if store.Has("https://push.example.net/old") {
		t.Fatal("the phone's previous endpoint is still there")
	}
}

func TestTheSameEndpointTwiceIsStillOne(t *testing.T) {
	// The page subscribes on every load, and the browser hands back the same
	// subscription it already had.
	store, err := OpenStore(filepath.Join(t.TempDir(), "push.json"))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := store.Add(subFor("https://push.example.net/a", "")); err != nil {
			t.Fatal(err)
		}
	}
	if n := store.Count(); n != 1 {
		t.Fatalf("count = %d, want 1", n)
	}
}

func TestAGoneSubscriptionIsForgotten(t *testing.T) {
	path := filepath.Join(t.TempDir(), "push.json")
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Add(subFor("https://push.example.net/a", "phone")); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove("https://push.example.net/a"); err != nil {
		t.Fatal(err)
	}
	again, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if again.Count() != 0 {
		t.Fatalf("still there after being removed: %+v", again.List())
	}
}

func TestTheListIsBounded(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "push.json"))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < MaxSubscriptions+5; i++ {
		if err := store.Add(subFor("https://push.example.net/"+string(rune('a'+i)), "")); err != nil {
			t.Fatal(err)
		}
	}
	if n := store.Count(); n != MaxSubscriptions {
		t.Fatalf("count = %d, want %d", n, MaxSubscriptions)
	}
	// The newest is kept, the oldest dropped: a device that just subscribed is
	// the one somebody is holding.
	if !store.Has("https://push.example.net/" + string(rune('a'+MaxSubscriptions+4))) {
		t.Fatal("the newest subscription was the one dropped")
	}
}

func TestASubscriptionWithNoKeysIsRefused(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "push.json"))
	if err != nil {
		t.Fatal(err)
	}
	var bare Subscription
	bare.Endpoint = "https://push.example.net/a"
	if err := store.Add(bare); err == nil {
		t.Fatal("a subscription with no keys was stored, and every send to it would fail")
	}
}

func TestABrokenStoreIsAnErrorRatherThanAnEmptyList(t *testing.T) {
	path := filepath.Join(t.TempDir(), "push.json")
	if err := os.WriteFile(path, []byte("{oops"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenStore(path); err == nil {
		t.Fatal("a broken file started over silently, taking every subscription with it")
	}
}

// --- the payload -----------------------------------------------------------

func TestALongBodyIsClippedRatherThanRefused(t *testing.T) {
	// A finish whose last sentence is cut is worth having; one dropped for
	// length is not. The title is never cut — half a session name is worse than
	// none.
	p := Payload{Title: "✅ pockterm закончил", Body: strings.Repeat("длинный ответ ", 1000), Tag: "pockterm-done:pockterm", Session: "pockterm"}
	b, err := p.JSON()
	if err != nil {
		t.Fatal(err)
	}
	if len(b) > maxPayload {
		t.Fatalf("payload of %d bytes, cap is %d", len(b), maxPayload)
	}
	var back Payload
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if back.Title != p.Title {
		t.Fatalf("the title was cut: %q", back.Title)
	}
	if back.Session != "pockterm" || back.Tag != "pockterm-done:pockterm" {
		t.Fatalf("the tap would land on the wrong session: %+v", back)
	}
}

func TestAnOrdinaryPayloadIsUntouched(t *testing.T) {
	p := Payload{Title: "✅ natal закончил", Body: "тесты прошли", Tag: "pockterm-done:natal", Session: "natal"}
	b, err := p.JSON()
	if err != nil {
		t.Fatal(err)
	}
	var back Payload
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if back != p {
		t.Fatalf("payload changed: %+v", back)
	}
}

func TestSendRefusesWhatCannotFit(t *testing.T) {
	keys, err := NewKeys()
	if err != nil {
		t.Fatal(err)
	}
	err = (&Client{Keys: keys}).Send(rfcSubscription(), make([]byte, maxPayload+1))
	if err == nil {
		t.Fatal("an oversized payload was sent, and the push service would have refused it")
	}
	if Gone(err) {
		t.Fatal("our own mistake must not cost the subscription")
	}
}

func TestSendWithoutKeysSaysSo(t *testing.T) {
	err := (&Client{}).Send(rfcSubscription(), []byte("{}"))
	if err == nil || !strings.Contains(err.Error(), "VAPID") {
		t.Fatalf("err = %v, want something about the missing keys", err)
	}
}

// --- helpers ---------------------------------------------------------------

func subFor(endpoint, device string) Subscription {
	sub := rfcSubscription()
	sub.Endpoint = endpoint
	sub.Device = device
	return sub
}

func claimsOf(t *testing.T, token string) map[string]any {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("not a JWT: %q", token)
	}
	raw, err := b64.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatal(err)
	}
	return claims
}

func readAll(r *http.Request) []byte {
	b := make([]byte, 4096)
	n, err := r.Body.Read(b)
	if err != nil && !errors.Is(err, os.ErrClosed) && n == 0 {
		return nil
	}
	return b[:n]
}
