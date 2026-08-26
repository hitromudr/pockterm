// Package pockterm embeds the PWA static files into the binary.
package pockterm

import (
	"embed"
	"mime"
	"regexp"
)

//go:embed all:web
var Web embed.FS

// The pane's font is served from web/fonts, and Go's own table has no entry for
// .woff2: on a host without /etc/mime.types the file went out as
// application/octet-stream. Browsers accept a face regardless of the type, so
// this is not what makes the font work — it is what keeps the answer the same on
// every host, rather than depending on a file the program does not install.
func init() {
	if err := mime.AddExtensionType(".woff2", "font/woff2"); err != nil {
		// Nothing to do about it and nothing broken by it: the type is a
		// courtesy, the font is served either way.
		_ = err
	}
}

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
