package push

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Keys is this server's identity to a push service: one P-256 key pair, kept
// for the life of the installation.
//
// It has to be kept. The public half is baked into every subscription the
// browser creates — a new key pair means every device has to subscribe again,
// and until it does, its push service refuses our messages as coming from
// somebody else. That is why this is a file and not a value generated at
// startup: CI installs a new binary several times a working day.
type Keys struct {
	private *ecdsa.PrivateKey
	// Public is the uncompressed point, base64url. This is what the page passes
	// to pushManager.subscribe as applicationServerKey.
	Public string
}

type keyFile struct {
	Private string `json:"private"` // base64url, big-endian scalar
	Public  string `json:"public"`  // base64url, uncompressed point — derived, kept for reading by eye
}

// NewKeys generates a pair.
func NewKeys() (*Keys, error) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("push: %w", err)
	}
	return fromPrivate(k), nil
}

func fromPrivate(k *ecdsa.PrivateKey) *Keys {
	return &Keys{private: k, Public: b64.EncodeToString(publicBytes(k))}
}

func publicBytes(k *ecdsa.PrivateKey) []byte {
	// The uncompressed form is what both the subscription and the JWT header
	// carry. elliptic.Marshal is deprecated in favour of ecdh, and this is the
	// one place the two packages meet: the signing key is ecdsa, the wire format
	// is the ecdh one, and they agree on the bytes.
	out := make([]byte, 1+2*32)
	out[0] = 4
	k.X.FillBytes(out[1:33])
	k.Y.FillBytes(out[33:])
	return out
}

// LoadKeys reads the pair at path, generating and writing one if there is
// nothing there yet.
//
// The file is 0600 and it holds a private key. Losing it is not a disaster —
// every device resubscribes on its next visit, which the page does on load —
// but leaking it lets somebody else send notifications that this server's
// subscriptions accept, so it is treated like the Telegram token: on disk, out
// of git, never in a log line.
func LoadKeys(path string) (*Keys, error) {
	if path == "" {
		return nil, errors.New("push: no path for the VAPID keys")
	}
	b, err := os.ReadFile(path)
	switch {
	case err == nil:
		var f keyFile
		if err := json.Unmarshal(b, &f); err != nil {
			return nil, fmt.Errorf("push: %s: %w", path, err)
		}
		raw, err := b64.DecodeString(f.Private)
		if err != nil {
			return nil, fmt.Errorf("push: %s: the private key is not base64url: %w", path, err)
		}
		if len(raw) != 32 {
			return nil, fmt.Errorf("push: %s: a P-256 private key is 32 bytes, got %d", path, len(raw))
		}
		k := new(ecdsa.PrivateKey)
		k.Curve = elliptic.P256()
		k.D = new(big.Int).SetBytes(raw)
		k.X, k.Y = k.Curve.ScalarBaseMult(raw)
		return fromPrivate(k), nil
	case errors.Is(err, os.ErrNotExist):
		keys, err := NewKeys()
		if err != nil {
			return nil, err
		}
		return keys, keys.save(path)
	default:
		return nil, fmt.Errorf("push: %s: %w", path, err)
	}
}

func (k *Keys) save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("push: %w", err)
	}
	raw := make([]byte, 32)
	k.private.D.FillBytes(raw)
	b, err := json.MarshalIndent(keyFile{Private: b64.EncodeToString(raw), Public: k.Public}, "", "  ")
	if err != nil {
		return fmt.Errorf("push: %w", err)
	}
	// Written whole and moved into place: a half-written key file read at the
	// next restart would look like a corrupt one and cost every subscription.
	tmp := path + ".new"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return fmt.Errorf("push: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("push: %w", err)
	}
	return nil
}

// vapidLife is how long a signed request is good for. The RFC caps it at 24
// hours; twelve leaves room for a clock that is off without being a token worth
// stealing.
const vapidLife = 12 * time.Hour

// Authorization builds the `vapid` header for one endpoint.
//
// The audience is the push service's origin and nothing more — path included
// would be a token that only works for one subscription, which is not what the
// services check, and several of them refuse it.
func (k *Keys) Authorization(endpoint, subject string, now time.Time) (string, error) {
	if k == nil || k.private == nil {
		return "", errors.New("push: no VAPID keys")
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", fmt.Errorf("push: endpoint: %w", err)
	}
	if u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("push: endpoint %q has no origin", endpoint)
	}
	if subject == "" {
		// A contact is required by the RFC and enforced by some services. The
		// default names the program rather than a person: this server has no
		// address of its own, and inventing one would be worse than saying what
		// is sending.
		subject = "https://github.com/hitromudr/pockterm"
	}
	claims := map[string]any{
		"aud": u.Scheme + "://" + u.Host,
		"exp": now.Add(vapidLife).Unix(),
		"sub": subject,
	}
	// The header is the same three fields every time, and writing it out avoids
	// depending on how a map is marshalled.
	head := b64.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`))
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("push: %w", err)
	}
	signing := head + "." + b64.EncodeToString(payload)
	sum := sha256.Sum256([]byte(signing))
	r, s, err := ecdsa.Sign(rand.Reader, k.private, sum[:])
	if err != nil {
		return "", fmt.Errorf("push: %w", err)
	}
	// JWS wants the two numbers padded to the curve size and concatenated, not
	// the ASN.1 sequence ecdsa.SignASN1 produces. A service reading the ASN.1
	// form answers 401, which looks exactly like a wrong key.
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return "vapid t=" + signing + "." + b64.EncodeToString(sig) + ", k=" + k.Public, nil
}

// Signed is the JWT out of an Authorization header, for the tests and for
// anything that has to look at what was sent.
func Signed(header string) (token, key string, err error) {
	if !strings.HasPrefix(header, "vapid ") {
		return "", "", fmt.Errorf("push: not a vapid header: %q", header)
	}
	for _, part := range strings.Split(strings.TrimPrefix(header, "vapid "), ",") {
		part = strings.TrimSpace(part)
		switch {
		case strings.HasPrefix(part, "t="):
			token = strings.TrimPrefix(part, "t=")
		case strings.HasPrefix(part, "k="):
			key = strings.TrimPrefix(part, "k=")
		}
	}
	if token == "" || key == "" {
		return "", "", fmt.Errorf("push: incomplete vapid header: %q", header)
	}
	return token, key, nil
}
