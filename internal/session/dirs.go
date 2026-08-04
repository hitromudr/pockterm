package session

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// The projects root is the directory the session Makefile lives in — the same
// POCKTERM_SESSION_DIR that already decides where a preset runs. One directory
// with two meanings would be a second setting to keep in step, and the answer
// would be the same value in every deployment this was written for.

// dirNameOK is what may be asked for as a folder: one path segment, no
// separator, no leading dot. It is a gate rather than advice — the value ends
// up on a command line as make's DIR=, and ".." two segments deep would be a
// session started anywhere on the box.
var dirNameOK = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// Folders lists the directories a session can be started in: the immediate
// children of root, by name, sorted.
//
// One level deep on purpose. The phone shows this as a list to tap, and a tree
// is a different control; nested projects are reached by renaming a session or
// by cd, which is what a terminal is for.
//
// Hidden directories are left out — `.git`, `.venv`, `.claude` are not projects,
// and a list where the useful entries are outnumbered is not a list anyone taps
// twice.
func Folders(root string) ([]string, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, fmt.Errorf("cannot read the projects root: %w", err)
	}
	var out []string
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") || !dirNameOK.MatchString(name) {
			continue
		}
		// A symlinked project counts: the owner put it there, and IsDir on the
		// entry says nothing about what it points at.
		if e.IsDir() {
			out = append(out, name)
			continue
		}
		if e.Type()&os.ModeSymlink != 0 {
			if st, err := os.Stat(filepath.Join(root, name)); err == nil && st.IsDir() {
				out = append(out, name)
			}
		}
	}
	sort.Strings(out)
	return out, nil
}

// ResolveDir turns a folder asked for by the page into an absolute path under
// root. An empty name, or ".", is the root itself — starting a session there is
// what the plain + did before folders existed, and it stays reachable.
//
// What it refuses is anything that is not one plain name: a separator, "..", a
// leading dot, an absolute path. The page only ever sends a name it got from
// Folders, so a refusal means either a stale list or something that did not come
// from the page at all.
func ResolveDir(root, name string) (string, error) {
	if name == "" || name == "." {
		return root, nil
	}
	if !dirNameOK.MatchString(name) {
		return "", fmt.Errorf("a folder is one plain name under the projects root, not %q", name)
	}
	path := filepath.Join(root, name)
	st, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("no folder %q in the projects root", name)
	}
	if !st.IsDir() {
		return "", fmt.Errorf("%q is not a folder", name)
	}
	return path, nil
}

// nameUnsafe is every character tmux or this page would rather not see in a
// session name: tmux addresses windows and panes with ":" and ".", and the rest
// is limited to what stays readable in a tab on a phone.
var nameUnsafe = regexp.MustCompile(`[^A-Za-z0-9_-]+`)

// Prefix is the session name a folder asks for, before the Makefile makes it
// unique. The folder is the identity worth reading in a tab — claude-1,
// claude-2, claude-3 says which command started them and nothing about where.
//
// Root gets the root's own basename, so the plain case reads as a folder too
// rather than as a special case.
func Prefix(root, name string) string {
	if name == "" || name == "." {
		name = filepath.Base(filepath.Clean(root))
	}
	name = nameUnsafe.ReplaceAllString(name, "-")
	name = strings.Trim(name, "-_")
	if len(name) > 24 {
		name = strings.Trim(name[:24], "-_")
	}
	// Nothing readable survived (a folder named "..." or in a script the page
	// never sends). The Makefile's own default is a better answer than a
	// session called "-".
	if name == "" {
		return ""
	}
	return name
}
