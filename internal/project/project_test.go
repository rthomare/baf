package project

import (
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

func TestDiscover_NoSpec(t *testing.T) {
	dir := t.TempDir()
	got, err := Discover(dir)
	if err != nil {
		t.Fatalf("Discover(no spec): unexpected err %v", err)
	}
	if got != nil {
		t.Fatalf("Discover(no spec): want nil project, got %+v", got)
	}
}

func TestDiscover_FindsInCurrentDir(t *testing.T) {
	dir := t.TempDir()
	writeSpec(t, dir, `
[[command]]
name = "tests"
run  = "make test"
`)
	got, err := Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("Discover: want a project, got nil")
	}
	// On macOS /tmp is a symlink to /private/tmp; compare via EvalSymlinks
	// so the test runs the same way on every host.
	wantRoot, _ := filepath.EvalSymlinks(dir)
	gotRoot, _ := filepath.EvalSymlinks(got.Root)
	if wantRoot != gotRoot {
		t.Fatalf("Root: want %q, got %q", wantRoot, gotRoot)
	}
	if len(got.Commands) != 1 || got.Commands[0].Name != "tests" || got.Commands[0].Run != "make test" {
		t.Fatalf("Commands: %+v", got.Commands)
	}
	if got.Commands[0].ID == "" {
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
	// Two levels down.
	deep := filepath.Join(root, "a", "b")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := Discover(deep)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("Discover from descendant: want a project, got nil")
	}
	wantRoot, _ := filepath.EvalSymlinks(root)
	gotRoot, _ := filepath.EvalSymlinks(got.Root)
	if wantRoot != gotRoot {
		t.Fatalf("Root: want %q (the spec-owning ancestor), got %q", wantRoot, gotRoot)
	}
}

func TestDiscover_MalformedFailsLoud(t *testing.T) {
	dir := t.TempDir()
	writeSpec(t, dir, `this is = "not = valid toml`)
	_, err := Discover(dir)
	if err == nil {
		t.Fatal("Discover(malformed): want an error, got nil")
	}
	if !strings.Contains(err.Error(), "parse") {
		t.Fatalf("error should mention parse; got %v", err)
	}
}

func TestDiscover_MissingRequiredField(t *testing.T) {
	dir := t.TempDir()
	writeSpec(t, dir, `
[[command]]
run = "make test"
`)
	_, err := Discover(dir)
	if err == nil || !strings.Contains(err.Error(), "name") {
		t.Fatalf("missing name should error; got %v", err)
	}
}

func TestShortID_StableAcrossRuns(t *testing.T) {
	a := shortID("tests", "make test")
	b := shortID("tests", "make test")
	if a != b {
		t.Fatalf("shortID should be deterministic; got %q vs %q", a, b)
	}
	if a == shortID("tests", "make TEST") {
		t.Fatalf("shortID should differ on run change")
	}
	if len(a) != 8 {
		t.Fatalf("shortID should be 8 hex chars; got %q", a)
	}
}
