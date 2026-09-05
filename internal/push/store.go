package push

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Store holds the subscriptions this server can reach, on disk.
//
// On disk because a subscription outlives the process by months and CI replaces
// this binary several times a working day: a list in memory would mean the phone
// is reachable only until the next push to main. The page does resubscribe on
// load, but a page that is not opened for a week is exactly the case push exists
// for.
//
// Keyed by endpoint, which is what the browser hands over and what identifies a
// subscription to its push service. The device tag rides along for the journal
// and for replacing a stale subscription from the same install.
type Store struct {
	mu   sync.Mutex
	path string
	subs []Subscription
}

// MaxSubscriptions bounds the file. Four devices answer this host today; twenty
// leaves room for reinstalls, each of which is a new subscription, while keeping
// a runaway page from filling the disk with them.
const MaxSubscriptions = 20

// OpenStore reads what is there, or starts empty. A file that cannot be parsed
// is an error rather than an empty list: silently starting over would take every
// device's subscription with it, and the fix — look at the file — is only
// possible if somebody is told.
func OpenStore(path string) (*Store, error) {
	s := &Store{path: path}
	if path == "" {
		return s, nil
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("push: %s: %w", path, err)
	}
	var file struct {
		Subscriptions []Subscription `json:"subscriptions"`
	}
	if err := json.Unmarshal(b, &file); err != nil {
		return nil, fmt.Errorf("push: %s: %w", path, err)
	}
	s.subs = file.Subscriptions
	return s, nil
}

// List copies the subscriptions out, so a send that takes seconds does not hold
// the lock the page's subscribe call needs.
func (s *Store) List() []Subscription {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Subscription, len(s.subs))
	copy(out, s.subs)
	return out
}

// Count is what the journal and the page's own settings line report.
func (s *Store) Count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.subs)
}

// Has reports whether this exact endpoint is already known, which is how the
// page tells "subscribed here" from "subscribed on some other device".
func (s *Store) Has(endpoint string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sub := range s.subs {
		if sub.Endpoint == endpoint {
			return true
		}
	}
	return false
}

// Add stores a subscription, replacing what the same endpoint or the same device
// had before.
//
// By device as well as by endpoint, and that is not tidiness: a browser hands
// out a new endpoint whenever it feels like it — a reinstall, a cleared site
// setting, an expired subscription it renewed on its own — and the old one keeps
// accepting messages the device no longer draws for a while. Left to accumulate,
// one phone becomes five subscriptions, four of them silent.
func (s *Store) Add(sub Subscription) error {
	if sub.Endpoint == "" {
		return errors.New("push: a subscription with no endpoint")
	}
	if sub.Keys.P256dh == "" || sub.Keys.Auth == "" {
		return errors.New("push: a subscription with no keys")
	}
	if sub.Added.IsZero() {
		sub.Added = time.Now()
	}
	s.mu.Lock()
	kept := s.subs[:0:0]
	for _, old := range s.subs {
		if old.Endpoint == sub.Endpoint {
			continue
		}
		if sub.Device != "" && old.Device == sub.Device {
			continue
		}
		kept = append(kept, old)
	}
	kept = append(kept, sub)
	// Oldest first out, so a device that has been quiet for months is the one
	// that loses its place rather than the one just added.
	if len(kept) > MaxSubscriptions {
		kept = kept[len(kept)-MaxSubscriptions:]
	}
	s.subs = kept
	s.mu.Unlock()
	return s.save()
}

// Remove forgets one subscription: the page unsubscribing, or a push service
// answering 404/410 for it.
func (s *Store) Remove(endpoint string) error {
	s.mu.Lock()
	kept := s.subs[:0:0]
	for _, old := range s.subs {
		if old.Endpoint != endpoint {
			kept = append(kept, old)
		}
	}
	changed := len(kept) != len(s.subs)
	s.subs = kept
	s.mu.Unlock()
	if !changed {
		return nil
	}
	return s.save()
}

func (s *Store) save() error {
	if s.path == "" {
		return nil
	}
	s.mu.Lock()
	b, err := json.MarshalIndent(struct {
		Subscriptions []Subscription `json:"subscriptions"`
	}{s.subs}, "", "  ")
	s.mu.Unlock()
	if err != nil {
		return fmt.Errorf("push: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("push: %w", err)
	}
	// 0600: the keys in here let anyone who has them notify these devices.
	tmp := s.path + ".new"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return fmt.Errorf("push: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("push: %w", err)
	}
	return nil
}
