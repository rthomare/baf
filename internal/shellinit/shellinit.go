// Package shellinit prepares the user's shell with OSC 133 hooks so the
// mobile client can split the byte stream into discrete command blocks.
//
// The user's real rc files are not touched. We create a tempdir, write a
// shim rc into it, and point the spawned shell at that shim by either
// ZDOTDIR (zsh) or --rcfile (bash). The shim sources the user's own rc
// then registers precmd/preexec hooks that emit:
//
//   OSC 133;A  → prompt about to render (start of a new block)
//   OSC 133;C  → user hit Enter; command is about to run
//   OSC 133;D;<exit> → command finished with the given exit status
//
// These markers are silently consumed by any terminal that understands
// OSC; they're invisible to the user's local terminal. Shells we don't
// recognize get a normal login launch and the mobile UI falls back to
// raw mode (xterm.js) seamlessly.
package shellinit

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Launch describes how to spawn the user's shell with injection in place.
type Launch struct {
	Name    string   // shell binary
	Args    []string // args to that binary
	Env     []string // additional env vars (merged onto os.Environ)
	Cleanup func()   // remove the tempdir; safe to call multiple times
	// Injected is true when OSC 133 hooks were successfully prepared for
	// the detected shell. False means the mobile UI should default to
	// raw mode (no block boundaries are coming).
	Injected bool
}

// Prepare builds a Launch for the given shell. shell may be an absolute
// path or a basename. If the shell is unrecognized, Prepare returns a
// plain login launch with Injected=false.
func Prepare(shell string) (Launch, error) {
	if shell == "" {
		shell = "/bin/bash"
	}
	base := filepath.Base(shell)
	switch base {
	case "zsh", "-zsh":
		return prepareZsh(shell)
	case "bash", "-bash":
		return prepareBash(shell)
	default:
		// Unknown shell: just give the user a login shell, no injection.
		return Launch{
			Name:    shell,
			Args:    []string{"-l"},
			Cleanup: func() {},
		}, nil
	}
}

// zshShim is the .zshrc we drop into ZDOTDIR. It sources the user's
// original rc and then layers OSC 133 hooks on top via add-zsh-hook.
const zshShim = `# baf shell integration (zsh)
# Sources the user's own rc, then layers OSC 133 markers around each
# prompt so the baf mobile UI can split output into command blocks.

if [ -n "${BAF_ORIG_ZDOTDIR-}" ] && [ "$BAF_ORIG_ZDOTDIR" != "$ZDOTDIR" ]; then
    [ -f "$BAF_ORIG_ZDOTDIR/.zshrc" ] && source "$BAF_ORIG_ZDOTDIR/.zshrc"
fi

__baf_precmd() {
    local exit_code=$?
    printf '\033]133;D;%s\007' "$exit_code"
    printf '\033]133;A\007'
}
__baf_preexec() {
    printf '\033]133;C\007'
}

autoload -Uz add-zsh-hook 2>/dev/null
if typeset -f add-zsh-hook >/dev/null 2>&1; then
    add-zsh-hook precmd  __baf_precmd
    add-zsh-hook preexec __baf_preexec
fi

# Initial marker so the first prompt has a block to anchor to.
printf '\033]133;A\007'
`

// bashShim is the rcfile we pass to bash via --rcfile. PS0 prints before
// each command — that's our preexec equivalent. PROMPT_COMMAND prints D
// then A around each prompt.
const bashShim = `# baf shell integration (bash)
# Sources the user's own rc, then layers OSC 133 markers around each
# prompt so the baf mobile UI can split output into command blocks.

[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"

__baf_precmd() {
    local exit_code=$?
    printf '\033]133;D;%s\007' "$exit_code"
    printf '\033]133;A\007'
}

case "${PROMPT_COMMAND-}" in
    *__baf_precmd*) ;;
    *) PROMPT_COMMAND="__baf_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;
esac

# PS0 is emitted by bash immediately before running the user's command —
# the natural place to print our 'output starts here' marker.
PS0='\[\033]133;C\007\]'"${PS0-}"

# Initial marker.
printf '\033]133;A\007'
`

func prepareZsh(shell string) (Launch, error) {
	dir, err := os.MkdirTemp("", "baf-zsh-")
	if err != nil {
		return Launch{}, err
	}
	if err := os.WriteFile(filepath.Join(dir, ".zshrc"), []byte(zshShim), 0o600); err != nil {
		_ = os.RemoveAll(dir)
		return Launch{}, err
	}
	origZDOTDIR := os.Getenv("ZDOTDIR")
	if origZDOTDIR == "" {
		origZDOTDIR = os.Getenv("HOME")
	}
	return Launch{
		Name: shell,
		Args: []string{"-i"},
		Env: []string{
			"ZDOTDIR=" + dir,
			"BAF_ORIG_ZDOTDIR=" + origZDOTDIR,
		},
		Cleanup:  cleanupOnce(dir),
		Injected: true,
	}, nil
}

func prepareBash(shell string) (Launch, error) {
	dir, err := os.MkdirTemp("", "baf-bash-")
	if err != nil {
		return Launch{}, err
	}
	rcPath := filepath.Join(dir, "rcfile")
	if err := os.WriteFile(rcPath, []byte(bashShim), 0o600); err != nil {
		_ = os.RemoveAll(dir)
		return Launch{}, err
	}
	return Launch{
		Name:     shell,
		Args:     []string{"--rcfile", rcPath, "-i"},
		Cleanup:  cleanupOnce(dir),
		Injected: true,
	}, nil
}

func cleanupOnce(dir string) func() {
	var done bool
	return func() {
		if done {
			return
		}
		done = true
		_ = os.RemoveAll(dir)
	}
}

// Description returns a short human-readable summary used in the banner
// for the curious user (e.g. "zsh + osc 133").
func (l Launch) Description() string {
	if l.Injected {
		return fmt.Sprintf("%s + osc 133", filepath.Base(l.Name))
	}
	return fmt.Sprintf("%s (no block markers; mobile falls back to raw)", filepath.Base(l.Name))
}

// EnvLines is a tiny helper so callers can println(Env) tidily. Unused
// today but handy for debug output.
func (l Launch) EnvLines() string { return strings.Join(l.Env, "\n") }
