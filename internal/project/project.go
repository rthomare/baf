// Package project discovers and parses every .baf/config.toml in scope
// for the current baf invocation. Discovery is additive: each spec file
// along the walk from cwd up to / contributes its own Source, and
// $HOME/.baf/config.toml is included as a "global" Source if it isn't
// already on the walk path. The closer-to-cwd a source is, the earlier
// it appears in Project.Sources; the global source comes last when it
// is added separately. The client renders one section per source, so
// nothing is merged or shadowed across files — different ancestors can
// each contribute a `tests` command and both stay visible, scoped by
// their source name.
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

// Project is the result of a successful (or partially successful)
// discovery. A non-nil Project with zero Sources can happen if every
// candidate spec file failed to parse — callers should still treat
// that as "no project," but the joined parse error explains why.
type Project struct {
	Sources []Source `json:"sources"`
}

// Source is one .baf/config.toml plus the directory that contained the
// .baf/ folder. The client uses Name as the section header and Root
// purely for diagnostic hover/debug.
type Source struct {
	Root     string    `json:"root"`
	Name     string    `json:"name"`
	Commands []Command `json:"commands"`
}

// Command is one [[command]] table from a config.toml plus a stable ID
// derived from the source root + name + run. The root is folded in so
// two ancestors that define the same command (same name AND run) still
// get distinct IDs, and React can key on them safely.
type Command struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Run         string `json:"run"`
	Description string `json:"description,omitempty"`
}

type rawConfig struct {
	Command []rawCommand `toml:"command"`
}

type rawCommand struct {
	Name        string `toml:"name"`
	Run         string `toml:"run"`
	Description string `toml:"description"`
}

// SpecRelPath is the path of the spec file relative to a discovered
// .baf/ directory.
const SpecRelPath = ".baf/config.toml"

// globalSourceName is the label given to $HOME/.baf/config.toml when
// HOME isn't already on the cwd→/ walk. Lower-case to match the rest
// of the mobile UI's typography.
const globalSourceName = "global"

// Discover returns every .baf/config.toml that applies to startDir,
// ordered closest-to-cwd first. If homeDir is non-empty and its own
// .baf/config.toml exists but wasn't already collected by the walk,
// it is appended as a "global" source. Parse failures for individual
// spec files don't abort discovery — they're joined into the returned
// error so callers can log them while still using the sources that
// did parse. (*Project, nil) with empty Sources is impossible: if no
// spec exists anywhere, (nil, nil) is returned.
func Discover(startDir, homeDir string) (*Project, error) {
	dir, err := filepath.Abs(startDir)
	if err != nil {
		return nil, fmt.Errorf("resolve %q: %w", startDir, err)
	}

	var sources []Source
	seen := map[string]bool{}
	var errs []error

	// Walk cwd → /. Closer ancestors are collected first.
	for {
		specPath := filepath.Join(dir, SpecRelPath)
		st, statErr := os.Stat(specPath)
		switch {
		case statErr == nil && !st.IsDir():
			if !seen[specPath] {
				seen[specPath] = true
				if src, err := loadFrom(dir, specPath); err != nil {
					errs = append(errs, err)
				} else {
					sources = append(sources, *src)
				}
			}
		case statErr != nil && !errors.Is(statErr, fs.ErrNotExist):
			errs = append(errs, fmt.Errorf("stat %q: %w", specPath, statErr))
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}

	// Global: $HOME/.baf/config.toml, but only if it wasn't already
	// included by the walk above (e.g. cwd lives under HOME).
	if homeDir != "" {
		homeAbs, err := filepath.Abs(homeDir)
		if err == nil {
			specPath := filepath.Join(homeAbs, SpecRelPath)
			if !seen[specPath] {
				if st, statErr := os.Stat(specPath); statErr == nil && !st.IsDir() {
					if src, err := loadFrom(homeAbs, specPath); err != nil {
						errs = append(errs, err)
					} else {
						src.Name = globalSourceName
						sources = append(sources, *src)
					}
				} else if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
					errs = append(errs, fmt.Errorf("stat %q: %w", specPath, statErr))
				}
			}
		}
	}

	joined := errors.Join(errs...)
	if len(sources) == 0 {
		return nil, joined
	}
	return &Project{Sources: sources}, joined
}

func loadFrom(root, specPath string) (*Source, error) {
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
			ID:          shortID(root, rc.Name, rc.Run),
			Name:        rc.Name,
			Run:         rc.Run,
			Description: rc.Description,
		})
	}
	return &Source{
		Root:     root,
		Name:     filepath.Base(root),
		Commands: cmds,
	}, nil
}

// shortID hashes root + name + run with nul separators so two ancestors
// that happen to share the same command shape still get distinct IDs.
func shortID(root, name, run string) string {
	h := sha256.New()
	h.Write([]byte(root))
	h.Write([]byte{0})
	h.Write([]byte(name))
	h.Write([]byte{0})
	h.Write([]byte(run))
	return hex.EncodeToString(h.Sum(nil))[:8]
}
