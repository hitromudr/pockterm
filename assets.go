// Package pockterm embeds the PWA static files into the binary.
package pockterm

import "embed"

//go:embed all:web
var Web embed.FS
