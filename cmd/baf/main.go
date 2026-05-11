// Command baf mirrors the local terminal to a mobile device on the LAN.
//
//   $ baf
//   Open on your phone:
//     https://192.168.1.42:8443/?t=<token>
//   [QR code]
//   $ _              ← shell prompt, business as usual; everything is mirrored
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"

	"golang.org/x/term"

	"github.com/rohanthomare/baf/internal/pty"
	"github.com/rohanthomare/baf/internal/qr"
	"github.com/rohanthomare/baf/internal/server"
	"github.com/rohanthomare/baf/internal/shellinit"
	"github.com/rohanthomare/baf/internal/tlsgen"
	"github.com/rohanthomare/baf/internal/webfs"
)

const defaultPort = 8443

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "baf:", err)
		os.Exit(1)
	}
}

func run() error {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return errors.New("baf must be run from an interactive terminal")
	}

	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/bash"
	}

	// Match the local terminal size for the PTY.
	cols, rows, err := term.GetSize(int(os.Stdin.Fd()))
	if err != nil {
		cols, rows = 80, 24
	}

	// Install a `baf-quit` shim and inject its directory at the front of
	// the spawned shell's PATH so users can type `baf-quit` to exit. We
	// also export BAF_PID as a fallback in case the user's rc clobbers
	// PATH.
	quitDir, err := installQuitShim(os.Getpid())
	if err != nil {
		return fmt.Errorf("install baf-quit: %w", err)
	}
	defer os.RemoveAll(quitDir)

	// Prepare OSC 133 shell integration. For zsh/bash this points the
	// shell at a temp rc that sources the user's own rc then layers
	// precmd/preexec markers around each prompt. For other shells the
	// mobile UI silently falls back to raw mode.
	launch, err := shellinit.Prepare(shell)
	if err != nil {
		return fmt.Errorf("shell integration: %w", err)
	}
	defer launch.Cleanup()

	extraEnv := []string{
		fmt.Sprintf("BAF_PID=%d", os.Getpid()),
		"PATH=" + quitDir + string(os.PathListSeparator) + os.Getenv("PATH"),
	}
	extraEnv = append(extraEnv, launch.Env...)
	sess, err := pty.Start(launch.Name, launch.Args, uint16(cols), uint16(rows), extraEnv)
	if err != nil {
		return fmt.Errorf("start pty: %w", err)
	}
	defer sess.Close()

	// Put the local stdin into raw mode so the inner shell sees keystrokes
	// directly (no canonical mode, no local echo).
	oldState, err := term.MakeRaw(int(os.Stdin.Fd()))
	if err != nil {
		return fmt.Errorf("raw stdin: %w", err)
	}
	defer term.Restore(int(os.Stdin.Fd()), oldState)

	// Local mirror: PTY ↔ local TTY.
	sess.AttachLocal(os.Stdin, os.Stdout)

	// SIGWINCH → resize PTY to match local terminal.
	winch := make(chan os.Signal, 1)
	signal.Notify(winch, syscall.SIGWINCH)
	go func() {
		for range winch {
			if c, r, err := term.GetSize(int(os.Stdin.Fd())); err == nil {
				_ = sess.Resize(uint16(c), uint16(r))
			}
		}
	}()
	// Kick once so any race on first sizing is settled.
	winch <- syscall.SIGWINCH

	// SIGTERM/SIGHUP → graceful exit (used by `baf-quit` and by clean
	// process shutdown). Closing the PTY sends SIGHUP to the inner shell,
	// which makes sess.Wait return and the main select unblock. We don't
	// listen for SIGINT here: in raw mode, Ctrl-C is a plain ^C byte to
	// the inner shell, not a signal to baf itself.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		<-quit
		_ = sess.Close()
	}()

	// Configure the network side.
	lanIP := server.LANIP()
	port, err := pickPort(lanIP, defaultPort)
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	cert, err := tlsgen.LoadOrCreate(filepath.Join(home, ".baf"), lanIP)
	if err != nil {
		return fmt.Errorf("tls: %w", err)
	}
	token, err := server.NewToken()
	if err != nil {
		return err
	}
	url := server.URL(lanIP, port, token)

	srv, err := server.New(server.Config{
		BindAddr: fmt.Sprintf("%s:%d", lanIP.String(), port),
		TLSCert:  cert,
		Token:    token,
		UIFS:     webfs.FS(),
		Session:  sess,
	})
	if err != nil {
		return err
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Print the QR + URL to the local terminal *before* raw mode would
	// have eaten the newlines. We're already in raw mode, so write CRLF
	// terminators explicitly.
	printBanner(os.Stdout, url)

	srvErr := make(chan error, 1)
	go func() { srvErr <- srv.Run(ctx) }()

	// Wait for the shell to exit (normal end of session) or server error.
	waitErr := make(chan error, 1)
	go func() { waitErr <- sess.Wait() }()

	select {
	case err := <-srvErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case err := <-waitErr:
		// Shell exited → tear down server.
		cancel()
		var exitErr *exec.ExitError
		if err != nil && !errors.As(err, &exitErr) {
			return err
		}
	}
	return nil
}

// pickPort tries `pref` first and falls back to an OS-assigned port if
// pref is busy.
func pickPort(ip net.IP, pref int) (int, error) {
	if l, err := net.Listen("tcp", fmt.Sprintf("%s:%d", ip.String(), pref)); err == nil {
		_ = l.Close()
		return pref, nil
	}
	l, err := net.Listen("tcp", fmt.Sprintf("%s:0", ip.String()))
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// printBanner writes the connection info above the prompt. We're already
// in raw mode by the time this is called, so use CRLF.
func printBanner(w io.Writer, url string) {
	const dim = "\x1b[2m"
	const reset = "\x1b[0m"
	const bold = "\x1b[1m"
	fmt.Fprintf(w, "%s┌─ back and forth ─┐%s\r\n", dim, reset)
	fmt.Fprintf(w, "%s│%s open on your phone\r\n", dim, reset)
	fmt.Fprintf(w, "%s│%s %s%s%s\r\n", dim, reset, bold, url, reset)
	fmt.Fprintf(w, "%s│%s (single-use link — token consumed on first scan)\r\n", dim, reset)
	fmt.Fprintf(w, "%s│%s quit: %sbaf-quit%s, %sexit%s, or Ctrl-D\r\n", dim, reset, bold, reset, bold, reset)
	fmt.Fprintf(w, "%s└──────────────────┘%s\r\n", dim, reset)
	qr.Print(crlfWriter{w}, url)
	fmt.Fprint(w, "\r\n")
}

// installQuitShim writes a tempdir-local `baf-quit` script that signals
// the baf parent process. The returned directory is prepended to the
// spawned shell's PATH; callers must remove it on exit.
func installQuitShim(pid int) (string, error) {
	dir, err := os.MkdirTemp("", "baf-")
	if err != nil {
		return "", err
	}
	script := fmt.Sprintf("#!/bin/sh\n# Signals the baf session that spawned this shell.\nexec kill -TERM %d\n", pid)
	if err := os.WriteFile(filepath.Join(dir, "baf-quit"), []byte(script), 0o755); err != nil {
		_ = os.RemoveAll(dir)
		return "", err
	}
	return dir, nil
}

// crlfWriter rewrites bare LF to CRLF so output looks right inside the
// raw-mode terminal — qrterminal emits plain LFs.
type crlfWriter struct{ w io.Writer }

func (c crlfWriter) Write(p []byte) (int, error) {
	out := make([]byte, 0, len(p)+8)
	for _, b := range p {
		if b == '\n' {
			out = append(out, '\r', '\n')
		} else {
			out = append(out, b)
		}
	}
	_, err := c.w.Write(out)
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

