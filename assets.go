// Package pockterm embeds the PWA static files into the binary.
package pockterm

import (
	"embed"
	"mime"
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
