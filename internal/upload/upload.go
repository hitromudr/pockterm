// Package upload stores what the browser pasted, dropped or picked as files
// on disk.
//
// Only keystrokes travel to the pty, so a file cannot be "pasted into the
// terminal" at all. What can travel is a path: the browser hands the bytes
// over here, and the terminal receives the name of the file they landed in.
package upload

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
)

// MaxBytes caps a single upload. A phone screenshot is a few hundred kilobytes,
// a camera frame a few megabytes, a scanned document about six; what pushed this
// to 100 MB is film — a phone writes several megabytes a second, so the 20 MB
// this was before held a clip of a few seconds.
//
// **The proxy in front bounds the body too, and its number has to move with
// this one.** It is set just above (`client_max_body_size` in the
// `pockterm_vhost` role, devops), so that what is too large is refused in this
// program's own words rather than by a status code with a page of HTML behind
// it — raise this alone and everything between the two bounds comes back as a
// 413 nothing here ever sent. The proxy goes first when both are raised, this
// program first when both are lowered: either way the app's number is the lower
// of the two at every moment in between.
const MaxBytes = 100 << 20

// MaxTotal caps the whole store, and it is the bound that matters now that one
// upload may be 100 MB. `Keep` alone answers "how long", which was enough while
// a file was a screenshot: a day of them is a few tens of megabytes. A day of
// films is not, and the disk under this directory also carries git and
// passwords — so the store has a size of its own, and the oldest files leave
// when it is exceeded.
//
// It is a multiple of MaxBytes rather than a share of the disk on purpose: what
// is being bounded is this program's appetite, not the machine's capacity, and a
// bound read off free space would grow silently on a bigger disk.
const MaxTotal = 1 << 30

// Keep is how long a saved file stays on disk. Nobody comes back to clean
// up, and the file is only needed while the agent reads it.
const Keep = 24 * time.Hour

// maxName caps what is kept of the browser's own name for the file. The name
// is a label — what makes the path unique is the random part CreateTemp
// picks — and this path is typed into a pane 51 columns wide.
const maxName = 48

// byType maps a sniffed content type to the extension an image gets. What is
// not in it is not an image, which is a different question from whether it is
// accepted: see Save.
var byType = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

type Store struct {
	Dir string
	Now func() time.Time // nil means time.Now
	// Total caps the directory; zero means MaxTotal. A field because a test
	// that had to write a gigabyte to reach the real one would not be run.
	Total int64
}

func (s Store) total() int64 {
	if s.Total <= 0 {
		return MaxTotal
	}
	return s.Total
}

func (s Store) now() time.Time {
	if s.Now == nil {
		return time.Now()
	}
	return s.Now()
}

// Save writes r into the store and returns the path of the new file. `name`
// is what the browser called it and may be empty.
//
// The content type the browser declares is its word for it; what is sniffed
// here is the bytes, because this path ends in a file an agent will open.
// Between the bytes and the name:
//
//   - an image is known by its bytes and keeps the extension they earn,
//     named or not — a screenshot comes off the clipboard as a blob with no
//     name at all, and a name claiming otherwise does not change what is in
//     the file;
//   - anything else is a document, and a document is taken only when the
//     browser names it. There is nothing to sniff that would help: a
//     Makefile, a patch and a note are one content type between them, and
//     the extension is what tells an agent which of them it is holding.
func (s Store) Save(r io.Reader, name string) (string, error) {
	head := make([]byte, 512)
	n, err := io.ReadFull(r, head)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return "", err
	}
	head = head[:n]
	if len(head) == 0 {
		return "", fmt.Errorf("empty upload")
	}
	kind := strings.TrimSpace(strings.Split(http.DetectContentType(head), ";")[0])
	safe := safeName(name)
	imageExt, isImage := byType[kind]

	// What goes after the random part, so that the extension stays last.
	var tail string
	switch {
	case isImage:
		if stem := stemOf(safe); stem != "" {
			tail = "-" + stem
		}
		tail += imageExt
	case safe != "":
		tail = "-" + safe
	default:
		return "", fmt.Errorf("not an image and nothing named it (looks like %s)", kind)
	}

	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return "", err
	}
	// CreateTemp both picks a free name and creates the file 0600 — what is
	// in it may be a screenshot of anything, or a document of anything.
	f, err := os.CreateTemp(s.Dir, "paste-"+s.now().Format("20060102-150405")+"-*"+tail)
	if err != nil {
		return "", err
	}
	defer f.Close()

	// One byte over the cap is enough to know it is over: read that byte,
	// then throw the whole thing away.
	body := io.MultiReader(bytes.NewReader(head), io.LimitReader(r, MaxBytes+1-int64(len(head))))
	written, err := io.Copy(f, body)
	if err != nil {
		os.Remove(f.Name())
		return "", err
	}
	if written > MaxBytes {
		os.Remove(f.Name())
		// Megabytes rather than bytes: this is shown in a toast on a phone, and
		// a film is the file that meets this bound routinely — a phone shoots
		// several megabytes a second, so the number is read far more often than
		// it used to be.
		return "", fmt.Errorf("larger than %d MB", MaxBytes>>20)
	}

	s.prune(f.Name())
	return f.Name(), nil
}

// safeName reduces the browser's own name for the file to something that can
// be a name on this disk and a word on a terminal line.
//
// It filters rather than refuses: the value arrives from a page, becomes a
// path and is then typed into a pane, so a separator, a space, a quote or a
// glyph a shell would read is replaced — refusing would cost the upload
// itself, and the name is only a label on it. Letters keep their alphabet:
// the owner's documents are named in one this program has no business
// rewriting, and what makes a path hazardous there is punctuation.
//
// An empty answer means the browser said nothing usable, which is what an
// image off the clipboard looks like.
func safeName(name string) string {
	name = name[strings.LastIndexAny(name, `/\`)+1:]
	var out []rune
	dash := false
	for _, r := range name {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '.':
			out, dash = append(out, r), false
		case !dash && len(out) > 0:
			// A dash stands in for everything else, including a dash: one for
			// a run of them, and none at the front, a name beginning with one
			// reading as an option wherever it is pasted.
			out, dash = append(out, '-'), true
		}
	}
	// A leading dot would make it a hidden file, and `..` is gone with it.
	out = []rune(strings.Trim(string(out), "-._"))
	if len(out) <= maxName {
		return string(out)
	}
	// Cut out of the middle, not off the end: the extension is the half an
	// agent reads.
	ext := []rune(extOf(string(out)))
	if keep := maxName - len(ext); keep > 0 {
		return strings.TrimRight(string(out[:keep]), "-._") + string(ext)
	}
	return string(out[:maxName])
}

// extOf answers the trailing extension, "" when there is nothing that looks
// like one. Bounded and letters-only, because what follows the last dot of
// `notes.2026-08-19` is not an extension.
func extOf(name string) string {
	i := strings.LastIndex(name, ".")
	if i <= 0 || len(name)-i > 12 {
		return ""
	}
	for _, r := range name[i+1:] {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			return ""
		}
	}
	return name[i:]
}

// stemOf is the name without the extension extOf found in it.
func stemOf(name string) string {
	return strings.TrimSuffix(name, extOf(name))
}

// prune drops what is older than Keep, then what does not fit in MaxTotal.
// Doing it on the way in keeps the store free of timers: uploads are the only
// thing that grows this directory, so they are also the only moment it needs
// sweeping.
//
// Two bounds because they answer different questions and a film breaks the
// first one's arithmetic: a day of screenshots was tens of megabytes, a day of
// films is gigabytes. Age goes first — a file nobody came back for in 24 hours
// is gone whatever the total is — and only then does size take the oldest of
// what is left.
//
// **The file just saved is never taken**, and it is named rather than deduced
// from the times: its path is about to be handed to the page, and an agent opens
// it a second later. "The newest by mtime" is not the same file — a store whose
// timestamps were set by anything but this program's own writes has a newer one
// — and a single upload the size of the whole cap would then delete itself.
func (s Store) prune(keep string) {
	entries, err := os.ReadDir(s.Dir)
	if err != nil {
		return
	}
	type item struct {
		name string
		mod  time.Time
		size int64
	}
	cutoff := s.now().Add(-Keep)
	base := filepath.Base(keep)
	var kept []item
	var total int64
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		total += info.Size()
		if e.Name() == base {
			continue // counted, never a candidate
		}
		if !info.ModTime().After(cutoff) {
			os.Remove(filepath.Join(s.Dir, e.Name()))
			total -= info.Size()
			continue
		}
		kept = append(kept, item{e.Name(), info.ModTime(), info.Size()})
	}
	limit := s.total()
	if total <= limit {
		return
	}
	sort.Slice(kept, func(i, j int) bool { return kept[i].mod.Before(kept[j].mod) })
	for i := 0; i < len(kept) && total > limit; i++ {
		if os.Remove(filepath.Join(s.Dir, kept[i].name)) == nil {
			total -= kept[i].size
		}
	}
}
