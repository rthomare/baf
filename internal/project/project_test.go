package project

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeSpec creates dir/.baf/config.toml with the given body.
func writeSpec(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, ".baf"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, SpecRelPath), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// evalRoot resolves symlinks so /tmp vs /private/tmp comparisons work
// on macOS without polluting every assertion with EvalSymlinks calls.
func evalRoot(t *testing.T, p string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatalf("eval symlinks %q: %v", p, err)
	}
	return resolved
}

func TestDiscover_NoSpec(t *testing.T) {
	dir := t.TempDir()
	got, err := Discover(dir, "")
	if err != nil {
		t.Fatalf("unexpected err %v", err)
	}
	if got != nil {
		t.Fatalf("want nil project, got %+v", got)
	}
}

func TestDiscover_FindsInCurrentDir(t *testing.T) {
	dir := t.TempDir()
	writeSpec(t, dir, `
[[command]]
name = "tests"
run  = "make test"
`)
	got, err := Discover(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || len(got.Sources) != 1 {
		t.Fatalf("want 1 source, got %+v", got)
	}
	src := got.Sources[0]
	if evalRoot(t, src.Root) != evalRoot(t, dir) {
		t.Fatalf("Root: want %q, got %q", dir, src.Root)
	}
	if src.Name != filepath.Base(evalRoot(t, dir)) && src.Name != filepath.Base(dir) {
		t.Fatalf("Name: want basename of %q, got %q", dir, src.Name)
	}
	if len(src.Commands) != 1 || src.Commands[0].Name != "tests" || src.Commands[0].Run != "make test" {
		t.Fatalf("Commands: %+v", src.Commands)
	}
	if src.Commands[0].ID == "" {
		t.Fatalf("Command.ID should be populated")
	}
}

func TestDiscover_WalksUp(t *testing.T) {
	root := t.TempDir()
	writeSpec(t, root, `
[[command]]
name = "fmt"
run  = "go fmt ./..."
`)
	deep := filepath.Join(root, "a", "b")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := Discover(deep, "")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || len(got.Sources) != 1 {
		t.Fatalf("want 1 source, got %+v", got)
	}
	if evalRoot(t, got.Sources[0].Root) != evalRoot(t, root) {
		t.Fatalf("Root: want %q, got %q", root, got.Sources[0].Root)
	}
}

func TestDiscover_AdditiveAcrossAncestors(t *testing.T) {
	// outer/inner — both ship a spec. Closer (inner) should come first.
	outer := t.TempDir()
	inner := filepath.Join(outer, "inner")
	if err := os.MkdirAll(inner, 0o755); err != nil {
		t.Fatal(err)
	}
	writeSpec(t, outer, `
[[command]]
name = "outer-cmd"
run  = "echo outer"
`)
	writeSpec(t, inner, `
[[command]]
name = "inner-cmd"
run  = "echo inner"
`)

	got, err := Discover(inner, "")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || len(got.Sources) != 2 {
		t.Fatalf("want 2 sources, got %+v", got)
	}
	if got.Sources[0].Commands[0].Name != "inner-cmd" {
		t.Fatalf("closer source should be first; got %+v", got.Sources)
	}
	if got.Sources[1].Commands[0].Name != "outer-cmd" {
		t.Fatalf("ancestor source should be second; got %+v", got.Sources)
	}
}

func TestDiscover_GlobalAddedWhenHomeOutsideWalk(t *testing.T) {
	// cwdRoot and homeDir live under different temp parents so the walk
	// from cwd never reaches HOME — global must be appended explicitly.
	cwdRoot := t.TempDir()
	homeDir := t.TempDir()
	writeSpec(t, cwdRoot, `
[[command]]
name = "local"
run  = "echo l"
`)
	writeSpec(t, homeDir, `
[[command]]
name = "g"
run  = "echo g"
`)

	got, err := Discover(cwdRoot, homeDir)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || len(got.Sources) != 2 {
		t.Fatalf("want 2 sources, got %+v", got)
	}
	if got.Sources[0].Commands[0].Name != "local" {
		t.Fatalf("local should come first; got %+v", got.Sources)
	}
	if got.Sources[1].Name != globalSourceName {
		t.Fatalf("trailing source should be %q, got %q", globalSourceName, got.Sources[1].Name)
	}
}

func TestDiscover_GlobalDedupedWhenHomeOnWalk(t *testing.T) {
	// cwd lives under homeDir; the walk hits HOME's spec already, so
	// the explicit global pass must NOT add a duplicate.
	homeDir := t.TempDir()
	cwd := filepath.Join(homeDir, "proj")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	writeSpec(t, homeDir, `
[[command]]
name = "shared"
run  = "echo s"
`)

	got, err := Discover(cwd, homeDir)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || len(got.Sources) != 1 {
		t.Fatalf("want exactly 1 source (no global dup), got %+v", got)
	}
	if got.Sources[0].Name == globalSourceName {
		t.Fatalf("walk-discovered HOME should keep its basename, not get the %q label", globalSourceName)
	}
}

func TestDiscover_BrokenFileSkipped(t *testing.T) {
	// inner spec valid, outer spec malformed. Discover should still
	// return the inner source, with the parse error reported via err.
	outer := t.TempDir()
	inner := filepath.Join(outer, "inner")
	if err := os.MkdirAll(inner, 0o755); err != nil {
		t.Fatal(err)
	}
	writeSpec(t, outer, `this is = "not = valid toml`)
	writeSpec(t, inner, `
[[command]]
name = "ok"
run  = "echo ok"
`)

	got, err := Discover(inner, "")
	if err == nil {
		t.Fatal("want a joined parse error for the broken outer spec, got nil")
	}
	if !strings.Contains(err.Error(), "parse") {
		t.Fatalf("error should mention parse; got %v", err)
	}
	if got == nil || len(got.Sources) != 1 {
		t.Fatalf("inner source should still be returned, got %+v", got)
	}
	if got.Sources[0].Commands[0].Name != "ok" {
		t.Fatalf("inner source content lost; got %+v", got.Sources[0])
	}
}

func TestDiscover_OnlyMalformedReturnsNilProject(t *testing.T) {
	dir := t.TempDir()
	writeSpec(t, dir, `this is = "not = valid toml`)
	got, err := Discover(dir, "")
	if err == nil {
		t.Fatal("want a parse error, got nil")
	}
	if got != nil {
		t.Fatalf("want nil project when no sources survived, got %+v", got)
	}
}

func TestDiscover_MissingRequiredField(t *testing.T) {
	dir := t.TempDir()
	writeSpec(t, dir, `
[[command]]
run = "make test"
`)
	got, err := Discover(dir, "")
	if err == nil || !strings.Contains(err.Error(), "name") {
		t.Fatalf("missing name should error; got err=%v got=%+v", err, got)
	}
	if got != nil {
		t.Fatalf("want nil project when the only spec is invalid, got %+v", got)
	}
}

func TestShortID_StableAcrossRuns(t *testing.T) {
	a := shortID("/r", "tests", "make test")
	b := shortID("/r", "tests", "make test")
	if a != b {
		t.Fatalf("shortID should be deterministic; got %q vs %q", a, b)
	}
	if a == shortID("/r", "tests", "make TEST") {
		t.Fatalf("shortID should differ on run change")
	}
	if len(a) != 8 {
		t.Fatalf("shortID should be 8 hex chars; got %q", a)
	}
}

func TestShortID_DifferentRootsDisambiguate(t *testing.T) {
	if shortID("/a", "tests", "make test") == shortID("/b", "tests", "make test") {
		t.Fatal("same name+run from different roots must hash to different IDs")
	}
}

// Sanity: errors.Join with all nil yields nil — protects the contract
// that "no parse errors → err is nil" even though we always call Join.
func TestDiscover_NoErrorWhenAllParseClean(t *testing.T) {
	dir := t.TempDir()
	writeSpec(t, dir, `
[[command]]
name = "ok"
run  = "echo ok"
`)
	_, err := Discover(dir, "")
	if !errors.Is(err, nil) {
		t.Fatalf("clean parse should produce nil err, got %v", err)
	}
}
