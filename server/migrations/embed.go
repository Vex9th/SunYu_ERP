package migrations

import "embed"

// FS contains the unmodified migration history of the Python release.
//
//go:embed *.sql
var FS embed.FS
