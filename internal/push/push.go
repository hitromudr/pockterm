// Package push delivers a notification to a device whose page is not running.
//
// It exists because the socket cannot. Android suspends a backgrounded PWA:
// the page stops answering, the server's ping goes unanswered for a minute,
// the socket is closed — and everything written into it in the meantime was
// counted as delivered and was not. Measured on the owner's phone on
// 2026-09-05: `done yarr` sent "to 1 page(s)" at 13:22:33, no acknowledgement
// from the page at all, `socket gone` at 13:23:25. The same event with the PWA
// on screen was acknowledged in the same second and stood in the shade.
//
// A push is the other direction: the push service holds it, wakes the service
// worker, and the worker draws the notice with no page involved. That is the
// only way to reach a phone whose app is not running.
//
// Two RFCs and no library. The encryption is RFC 8291 over RFC 8188, the
// authorization is RFC 8292, and both are small enough to keep in sight —
// every step below is checked against the worked example in RFC 8291 §5 and
// its intermediate values in Appendix A, so a mistake shows up as a failing
// test rather than as a phone that stays quiet.
package push

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Subscription is what the browser handed the page, verbatim.
//
// The endpoint names the push service and the subscription both; the keys are
// the device's own, and the payload is encrypted to them. Nothing here is a
// secret of ours — losing the file means somebody else can notify this phone,
// not that they can read what was sent.
type Subscription struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"` // the device's public key, uncompressed P-256
		Auth   string `json:"auth"`   // 16 bytes of authentication secret
	} `json:"keys"`
	// Device is this install's own short tag, the same one the journal carries.
	// It is how a subscription is replaced rather than duplicated when the same
	// phone subscribes again, and how a notice can skip the device that is
	// already showing the session.
	Device string `json:"device,omitempty"`
	// Added is when the browser handed it over. Kept for the journal: a
	// subscription that stopped working is easier to reason about with a date.
	Added time.Time `json:"added,omitempty"`
}

// recordSize is the one record we ever write. A notification body is clipped to
// 200 runes long before it gets here, so the 4096 the receiver must accept is
// never in question.
const recordSize = 4096

// maxPayload is what fits in one record: the record size less the AEAD tag and
// the padding delimiter.
const maxPayload = recordSize - 16 - 1

var b64 = base64.RawURLEncoding

// A push service that says the subscription is gone says it with one of these,
// and the answer is to forget it rather than to retry. Anything else is treated
// as this end's problem: the message is dropped and the journal says why.
var errGone = errors.New("push: the subscription is gone")

// Gone reports whether the error means the device will never take another
// notice on this subscription.
func Gone(err error) bool { return errors.Is(err, errGone) }

// Client sends to one push service after another — there is no connection to
// keep, only requests.
type Client struct {
	// Keys signs the requests. Without them a push service refuses outright:
	// VAPID is what ties a subscription to the server that created it.
	Keys *Keys
	// Subject travels in the JWT so a push service has somebody to contact about
	// a misbehaving sender. `mailto:` or an https URL; anything else is refused
	// by some services and ignored by others.
	Subject string
	HTTP    *http.Client
	// TTL is how long the service holds a message for a device that is offline.
	// Zero means deliver now or drop, which is wrong for a phone in a pocket:
	// see DefaultTTL.
	TTL time.Duration
	// Now is injected by the tests; nil means time.Now.
	Now func() time.Time
}

// DefaultTTL keeps a notice for four hours. A finish the owner reads two hours
// later is still worth having — that is the whole case for notifying at all —
// while a day-old one is noise, and the push service is not a mailbox.
const DefaultTTL = 4 * time.Hour

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	// Short, and not the default zero: the sender is a watcher goroutine, and a
	// push service that hangs must not hold up the next session's notice.
	return &http.Client{Timeout: 20 * time.Second}
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// Send encrypts one notification for one subscription and hands it over.
//
// The payload is whatever the caller wants the service worker to draw; this
// package neither reads it nor decides anything about it — the watcher does
// that, in the one place both channels already agree on.
func (c *Client) Send(sub Subscription, payload []byte) error {
	if c.Keys == nil {
		return errors.New("push: no VAPID keys")
	}
	if len(payload) > maxPayload {
		return fmt.Errorf("push: payload of %d bytes does not fit one record", len(payload))
	}
	body, err := Encrypt(sub, payload, nil, nil)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, sub.Endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("push: %w", err)
	}
	auth, err := c.Keys.Authorization(sub.Endpoint, c.Subject, c.now())
	if err != nil {
		return err
	}
	ttl := c.TTL
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	req.Header.Set("Authorization", auth)
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("TTL", strconv.Itoa(int(ttl.Seconds())))
	// Not urgent enough to wake a device that is saving power, and not so low
	// that it waits for the screen to come on: a finished run is worth a buzz
	// when it happens.
	req.Header.Set("Urgency", "normal")
	resp, err := c.http().Do(req)
	if err != nil {
		return fmt.Errorf("push: %w", err)
	}
	defer resp.Body.Close()
	// Read enough of the answer to put a reason in the journal, and no more: a
	// push service that decided to explain itself at length is not a reason to
	// hold memory.
	said, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return nil
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
		return fmt.Errorf("%w: %s said %d", errGone, sub.Endpoint, resp.StatusCode)
	default:
		return fmt.Errorf("push: %s answered %d: %s", sub.Endpoint, resp.StatusCode, trim(said))
	}
}

func trim(b []byte) string {
	s := string(b)
	if len(s) > 200 {
		s = s[:200] + "…"
	}
	return s
}

// Encrypt builds the body of a push request: RFC 8291 message encryption in the
// RFC 8188 aes128gcm content coding.
//
// `ephemeral` and `salt` are the randomness, and they are arguments so the test
// can put the RFC's own values in and compare the result byte for byte. Passing
// nil for either is what production does.
func Encrypt(sub Subscription, payload []byte, ephemeral *ecdh.PrivateKey, salt []byte) ([]byte, error) {
	uaPublicRaw, err := b64.DecodeString(sub.Keys.P256dh)
	if err != nil {
		return nil, fmt.Errorf("push: the device key is not base64url: %w", err)
	}
	authSecret, err := b64.DecodeString(sub.Keys.Auth)
	if err != nil {
		return nil, fmt.Errorf("push: the auth secret is not base64url: %w", err)
	}
	curve := ecdh.P256()
	uaPublic, err := curve.NewPublicKey(uaPublicRaw)
	if err != nil {
		return nil, fmt.Errorf("push: the device key is not a P-256 point: %w", err)
	}
	if ephemeral == nil {
		if ephemeral, err = curve.GenerateKey(rand.Reader); err != nil {
			return nil, fmt.Errorf("push: %w", err)
		}
	}
	if salt == nil {
		salt = make([]byte, 16)
		if _, err := rand.Read(salt); err != nil {
			return nil, fmt.Errorf("push: %w", err)
		}
	}
	if len(salt) != 16 {
		return nil, fmt.Errorf("push: a salt is 16 bytes, got %d", len(salt))
	}
	shared, err := ephemeral.ECDH(uaPublic)
	if err != nil {
		return nil, fmt.Errorf("push: %w", err)
	}
	asPublic := ephemeral.PublicKey().Bytes()

	// The two derivations are not one: the first mixes the ECDH secret with the
	// subscription's own auth secret and *both* public keys, which is what binds
	// the message to this device and this sender; only then does the random salt
	// come in. Getting the order wrong yields a body a phone silently discards.
	keyInfo := append([]byte("WebPush: info\x00"), uaPublicRaw...)
	keyInfo = append(keyInfo, asPublic...)
	ikm := hkdf(authSecret, shared, keyInfo, 32)
	cek := hkdf(salt, ikm, []byte("Content-Encoding: aes128gcm\x00"), 16)
	nonce := hkdf(salt, ikm, []byte("Content-Encoding: nonce\x00"), 12)

	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, fmt.Errorf("push: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("push: %w", err)
	}
	// One record, so the padding delimiter is the last-record 0x02 rather than
	// 0x01. A receiver reading 0x01 waits for a record that never comes.
	record := gcm.Seal(nil, nonce, append(append([]byte{}, payload...), 0x02), nil)

	body := make([]byte, 0, 16+4+1+len(asPublic)+len(record))
	body = append(body, salt...)
	body = binary.BigEndian.AppendUint32(body, recordSize)
	body = append(body, byte(len(asPublic)))
	body = append(body, asPublic...)
	body = append(body, record...)
	return body, nil
}

// hkdf is RFC 5869 for the three short outputs this needs, which all fit in one
// HMAC block. Written out rather than imported: golang.org/x/crypto is a
// dependency this program does not otherwise have, and the whole of it is these
// six lines.
func hkdf(salt, ikm, info []byte, length int) []byte {
	if length > sha256.Size {
		panic("push: hkdf here is for one block")
	}
	prk := hmac.New(sha256.New, salt)
	prk.Write(ikm)
	out := hmac.New(sha256.New, prk.Sum(nil))
	out.Write(info)
	out.Write([]byte{1})
	return out.Sum(nil)[:length]
}

// Payload is what the service worker is handed. The names are the worker's, and
// the worker does nothing but draw them — every decision was made by the
// watcher, in the same call that wrote the Telegram message and the socket
// frame.
type Payload struct {
	Title   string `json:"title"`
	Body    string `json:"body"`
	Tag     string `json:"tag"`
	Session string `json:"session"`
}

// JSON is the payload as bytes, clipped so it fits one record.
//
// Clipping the body rather than refusing the notice: a finish the owner reads
// with the last sentence cut is worth having, and a notice dropped for length is
// not. The title is never clipped — it names the session, and half a session
// name is worse than none.
//
// The loop counts runes and measures bytes, which is the whole reason it is a
// loop. Cutting `len(body) - limit` *bytes* off a Cyrillic body removes twice
// that many characters at best and, when the count exceeds the number of runes
// there are, removes nothing at all — the first version of this spun until the
// test timed out at ten minutes. Each turn drops at least one rune, so it ends.
func (p Payload) JSON() ([]byte, error) {
	body := []rune(p.Body)
	for {
		b, err := json.Marshal(p)
		if err != nil {
			return nil, fmt.Errorf("push: %w", err)
		}
		if len(b) <= maxPayload {
			return b, nil
		}
		if len(body) == 0 {
			// The title alone does not fit, which means the session name is
			// pathological rather than the body being long.
			return nil, fmt.Errorf("push: a payload of %d bytes does not fit", len(b))
		}
		// A rune is at most four bytes, so this is the fewest that can help.
		drop := (len(b)-maxPayload)/4 + 1
		if drop > len(body) {
			drop = len(body)
		}
		body = body[:len(body)-drop]
		p.Body = string(body)
		if len(body) > 0 {
			p.Body += "…"
		}
	}
}
