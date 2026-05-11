// Package webfs embeds the built web/ assets into the binary.
package webfs

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var assets embed.FS

// FS returns the web/dist directory rooted at "/" so http.FileServer can
// serve it directly. If the dist directory is empty (dev mode without a
// frontend build), the returned FS will still serve index.html as long as
// the placeholder file exists.
func FS() fs.FS {
	sub, err := fs.Sub(assets, "dist")
	if err != nil {
		// Should be impossible — dist is embedded.
		panic(err)
	}
	return sub
}
