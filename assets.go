// Package pockterm embeds the PWA static files into the binary.
package pockterm

import (
	"embed"
	"regexp"
)

//go:embed all:web
var Web embed.FS

// The page stamps its own version into app.js, and the service worker caches
// under it. Read here rather than kept as a second constant: the binary and
// the assets it serves are one artifact, and a version that had to be bumped
// in two places would sooner or later name a page that is not the one being
// served.
var pageVersion = regexp.MustCompile(`APP_VERSION\s*=\s*'([^']+)'`)

// PageVersion returns the version of the page this binary carries, or "" if
// the assets do not say.
//
// It exists for the socket's config frame: after CI installs a build the unit
// restarts, every page reconnects, and a page still running the previous
// assets is the one thing that cannot tell on its own — its own code is what
// is out of date. So the server names what it serves and the page compares.
func PageVersion() string {
	b, err := Web.ReadFile("web/js/app.js")
	if err != nil {
		return ""
	}
	m := pageVersion.FindSubmatch(b)
	if m == nil {
		return ""
	}
	return string(m[1])
}
