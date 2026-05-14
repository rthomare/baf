// Package project discovers and parses an optional .baf/config.toml
// living in baf's working directory or any of its ancestors. The parsed
// config exposes the set of "project commands" surfaced in the mobile
// settings sheet — they are not run server-side; the client sends them
// back through the existing PTY input path.
package project

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
)

// Project is the result of a successful discovery + parse.
type Project struct {
	// Root is the directory that contained the .baf/ folder (the
	// project root from baf's perspective, not necessarily the user's).
	Root string `json:"root"`
	// Name is the basename of Root.
	Name string `json:"name"`
	// Commands are the user-defined entries from config.toml. Always
	// non-nil; may be empty.
	Commands []Command `json:"commands"`
}

// Command is one [[command]] table from config.toml plus a stable ID
// derived from its content (so the client can use it as a React key
// without worrying about reorders).
type Command struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Run         string `json:"run"`
	Description string `json:"description,omitempty"`
}

// rawConfig is the on-disk shape. Kept separate from Project so the
// public type doesn't leak parse details and we can evolve the file
// schema later (e.g. [voice], [keybindings]) without changing Project.
type rawConfig struct {
	Command []rawCommand `toml:"command"`
}

type rawCommand struct {
	Name        string `toml:"name"`
	Run         string `toml:"run"`
	Description string `toml:"description"`
}

// SpecRelPath is the path of the spec file, relative to a discovered
// .baf/ directory.
const SpecRelPath = ".baf/config.toml"

// Discover walks upward from startDir looking for SpecRelPath. The
// first directory whose .baf/config.toml exists and parses cleanly is
// returned. If nothing is found, (nil, nil) is returned — the absence
// of a config is not an error. A parse error is returned only for the
// closest spec file that exists; we don't keep walking past a broken
// one because that would silently bypass the user's intent.
func Discover(startDir string) (*Project, error) {
	dir, err := filepath.Abs(startDir)
	if err != nil {
		return nil, fmt.Errorf("resolve %q: %w", startDir, err)
	}
	for {
		specPath := filepath.Join(dir, SpecRelPath)
		if _, err := os.Stat(specPath); err == nil {
			return loadFrom(dir, specPath)
		} else if !errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf("stat %q: %w", specPath, err)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return nil, nil
		}
		dir = parent
	}
}

func loadFrom(root, specPath string) (*Project, error) {
	var raw rawConfig
	if _, err := toml.DecodeFile(specPath, &raw); err != nil {
		return nil, fmt.Errorf("parse %s: %w", specPath, err)
	}
	cmds := make([]Command, 0, len(raw.Command))
	for i, rc := range raw.Command {
		if rc.Name == "" {
			return nil, fmt.Errorf("%s: [[command]] #%d missing required field `name`", specPath, i+1)
		}
		if rc.Run == "" {
			return nil, fmt.Errorf("%s: [[command]] %q missing required field `run`", specPath, rc.Name)
		}
		cmds = append(cmds, Command{
			ID:          shortID(rc.Name, rc.Run),
			Name:        rc.Name,
			Run:         rc.Run,
			Description: rc.Description,
		})
	}
	return &Project{
		Root:     root,
		Name:     filepath.Base(root),
		Commands: cmds,
	}, nil
}

// shortID returns the first 8 hex chars of sha256(name + "\x00" + run).
// The nul byte avoids collisions between e.g. ("ab", "c") and ("a", "bc").
func shortID(name, run string) string {
	h := sha256.New()
	h.Write([]byte(name))
	h.Write([]byte{0})
	h.Write([]byte(run))
	return hex.EncodeToString(h.Sum(nil))[:8]
}
