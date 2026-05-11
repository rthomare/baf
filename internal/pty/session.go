// Package pty owns the mirrored PTY session.
//
// The model: baf spawns the user's $SHELL inside a PTY it owns, then tees
// PTY output to the local terminal and any connected remote client. Local
// stdin and remote input are merged into the PTY's write side. The local
// terminal is always the primary writer; at most one remote writer is
// admitted at a time via TryAcquireRemote.
package pty

import (
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"

	cpty "github.com/creack/pty"
)

// ScrollbackBytes is the size of the ring buffer of recent PTY output kept
// in memory. ReplayBytes caps how much of that is actually shipped to a
// new client on connect — initial paint on mobile parses every replayed
// byte through the block pipeline, so a smaller replay means a faster
// first frame. The ring stays a few screens deep for safety, the replay
// stays tight.
const (
	ScrollbackBytes = 64 * 1024
	ReplayBytes     = 32 * 1024
)

// GeometryListener is notified whenever the PTY is resized. Listeners
// run synchronously under the session lock — they must be fast.
type GeometryListener = func(cols, rows uint16)

// Session is a running mirrored shell.
type Session struct {
	cmd *exec.Cmd
	tty *os.File // master side of the PTY

	mu        sync.Mutex
	ring      *ring
	clients   map[*Client]struct{}
	hasWriter bool // a remote currently holds the writer lock
	closed    bool

	// Geometry. Two inputs (host SIGWINCH and an optional remote
	// override), one effective size applied to the PTY. The override is
	// used to fit the PTY to the mobile viewport while a TUI has the
	// screen — the user actively driving from their phone shouldn't be
	// reading 140-col output through a 380px display.
	geomCols, geomRows         uint16 // effective
	hostCols, hostRows         uint16 // last LocalResize
	overrideCols, overrideRows uint16 // 0 = no override
	geomListeners              map[*GeometryListener]struct{}
}

// Client is a remote subscriber. Output() yields PTY bytes; closing it
// detaches the client. Only one client at a time can be a writer.
type Client struct {
	out      chan []byte
	isWriter bool
	sess     *Session
}

// Start spawns name+args inside a fresh PTY, sized to (cols, rows).
// extraEnv is appended to os.Environ (later entries win), so callers can
// inject BAF_PID, PATH prefixes, ZDOTDIR, etc. The returned Session can
// have its local TTY wired up via AttachLocal and remote clients via
// Subscribe.
func Start(name string, args []string, cols, rows uint16, extraEnv []string) (*Session, error) {
	if name == "" {
		name = "/bin/bash"
	}
	cmd := exec.Command(name, args...)
	env := append(os.Environ(), "BAF=1")
	env = append(env, extraEnv...)
	cmd.Env = env
	tty, err := cpty.StartWithSize(cmd, &cpty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, err
	}
	s := &Session{
		cmd:           cmd,
		tty:           tty,
		ring:          newRing(ScrollbackBytes),
		clients:       make(map[*Client]struct{}),
		geomCols:      cols,
		geomRows:      rows,
		hostCols:      cols,
		hostRows:      rows,
		geomListeners: make(map[*GeometryListener]struct{}),
	}
	go s.pump()
	return s, nil
}

// pump reads PTY output forever, into the ring buffer and out to clients.
// Local mirroring is handled by AttachLocal via a Tee on the receiving end.
func (s *Session) pump() {
	buf := make([]byte, 64*1024)
	for {
		n, err := s.tty.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			s.broadcast(chunk)
		}
		if err != nil {
			s.markClosed()
			return
		}
	}
}

func (s *Session) broadcast(b []byte) {
	s.mu.Lock()
	s.ring.write(b)
	clients := make([]*Client, 0, len(s.clients))
	for c := range s.clients {
		clients = append(clients, c)
	}
	s.mu.Unlock()
	for _, c := range clients {
		// Non-blocking — if a client can't keep up, drop. Voice/UI flow
		// matters more than perfect replay for a laggy client.
		select {
		case c.out <- b:
		default:
		}
	}
}

// LocalOutput returns the file the local terminal should read PTY output
// from. Callers should io.Copy(os.Stdout, sess.LocalOutput()) — but in
// practice we use AttachLocal which sets up both directions.
func (s *Session) LocalOutput() io.Reader { return s.tty }

// AttachLocal wires the local TTY (stdin/stdout) to the PTY. It writes
// PTY output to localOut and reads localIn into the PTY. Returns when
// either copy ends (usually shell exit). The caller should put localIn
// into raw mode first.
//
// We don't use this directly for the broadcast path — broadcast happens
// in pump(). Instead, we register a synthetic "local" client that writes
// to localOut. This keeps a single source of truth (pump) for PTY output.
func (s *Session) AttachLocal(localIn io.Reader, localOut io.Writer) {
	local := &Client{out: make(chan []byte, 256), isWriter: false, sess: s}
	s.mu.Lock()
	s.clients[local] = struct{}{}
	// Replay scrollback so local catches up to whatever pump emitted
	// before AttachLocal was called.
	scrollback := s.ring.snapshot()
	s.mu.Unlock()
	if len(scrollback) > 0 {
		_, _ = localOut.Write(scrollback)
	}
	go func() {
		for chunk := range local.out {
			_, _ = localOut.Write(chunk)
		}
	}()
	// Local input → PTY. Local is always allowed to write.
	go func() {
		_, _ = io.Copy(s.tty, localIn)
	}()
}

// Subscribe registers a remote client and returns the initial replay
// split into tail (recent, parsed straight into the live stream so the
// client can render fast) and history (the older portion, to be
// streamed after the tail so it can be prepended once the main view is
// already on screen). The Client's Output channel carries live PTY
// bytes only — the caller writes the tail/history to the wire itself.
// If writer is true, the caller must already hold the writer lock from
// TryAcquireRemote.
func (s *Session) Subscribe(writer bool) (c *Client, tail, history []byte) {
	c = &Client{out: make(chan []byte, 256), isWriter: writer, sess: s}
	s.mu.Lock()
	s.clients[c] = struct{}{}
	history, tail = s.ring.snapshotSplit(ReplayBytes)
	s.mu.Unlock()
	return c, tail, history
}

// Detach removes a client and releases the writer lock if it held one.
func (s *Session) Detach(c *Client) {
	s.mu.Lock()
	if _, ok := s.clients[c]; ok {
		delete(s.clients, c)
		close(c.out)
		if c.isWriter {
			s.hasWriter = false
		}
	}
	s.mu.Unlock()
}

// Output returns the channel of PTY byte chunks for this client.
func (c *Client) Output() <-chan []byte { return c.out }

// TryAcquireRemote returns true if no other remote currently holds the
// writer lock. Caller should call Subscribe(true) on success and refuse
// the connection on failure.
func (s *Session) TryAcquireRemote() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hasWriter || s.closed {
		return false
	}
	s.hasWriter = true
	return true
}

// Write sends input bytes to the PTY. Only callers that hold the writer
// lock (local TTY or the one allowed remote) should call this.
func (s *Session) Write(p []byte) (int, error) {
	return s.tty.Write(p)
}

// Resize records the host's preferred geometry (typically from
// SIGWINCH). The effective PTY size becomes this size unless a remote
// override is active, in which case the override wins. Notifies
// geometry listeners on every effective change.
func (s *Session) Resize(cols, rows uint16) error {
	s.mu.Lock()
	s.hostCols, s.hostRows = cols, rows
	s.mu.Unlock()
	return s.applyEffective()
}

// OverrideGeometry pins the PTY to the given size regardless of the
// host's SIGWINCH. Used by mobile when a TUI is being driven from the
// phone — host's terminal reflows along with us, by design.
func (s *Session) OverrideGeometry(cols, rows uint16) error {
	if cols == 0 || rows == 0 {
		return s.ReleaseOverride()
	}
	s.mu.Lock()
	s.overrideCols, s.overrideRows = cols, rows
	s.mu.Unlock()
	return s.applyEffective()
}

// ReleaseOverride drops any active override; effective size falls back
// to the host's last reported geometry.
func (s *Session) ReleaseOverride() error {
	s.mu.Lock()
	s.overrideCols, s.overrideRows = 0, 0
	s.mu.Unlock()
	return s.applyEffective()
}

func (s *Session) applyEffective() error {
	s.mu.Lock()
	cols, rows := s.hostCols, s.hostRows
	if s.overrideCols > 0 && s.overrideRows > 0 {
		cols, rows = s.overrideCols, s.overrideRows
	}
	if cols == s.geomCols && rows == s.geomRows {
		s.mu.Unlock()
		return nil
	}
	s.geomCols, s.geomRows = cols, rows
	listeners := make([]GeometryListener, 0, len(s.geomListeners))
	for cb := range s.geomListeners {
		listeners = append(listeners, *cb)
	}
	s.mu.Unlock()
	if err := cpty.Setsize(s.tty, &cpty.Winsize{Cols: cols, Rows: rows}); err != nil {
		return err
	}
	for _, cb := range listeners {
		cb(cols, rows)
	}
	return nil
}

// Geometry returns the PTY's current (cols, rows).
func (s *Session) Geometry() (uint16, uint16) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.geomCols, s.geomRows
}

// OnGeometry registers a listener for resize events. The returned cancel
// function unsubscribes.
func (s *Session) OnGeometry(cb GeometryListener) (cancel func()) {
	s.mu.Lock()
	key := &cb
	s.geomListeners[key] = struct{}{}
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		delete(s.geomListeners, key)
		s.mu.Unlock()
	}
}

// Wait blocks until the underlying shell exits.
func (s *Session) Wait() error {
	err := s.cmd.Wait()
	s.markClosed()
	if errors.Is(err, &exec.ExitError{}) {
		return nil
	}
	return err
}

// Close terminates the shell and tears down the PTY.
func (s *Session) Close() error {
	s.markClosed()
	if s.cmd.Process != nil {
		_ = s.cmd.Process.Signal(syscall.SIGHUP)
	}
	return s.tty.Close()
}

func (s *Session) markClosed() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	for c := range s.clients {
		close(c.out)
	}
	s.clients = nil
}

// ring is a simple byte ring buffer for scrollback replay.
type ring struct {
	buf  []byte
	w    int  // write cursor
	full bool
}

func newRing(size int) *ring { return &ring{buf: make([]byte, size)} }

func (r *ring) write(p []byte) {
	for len(p) > 0 {
		n := copy(r.buf[r.w:], p)
		r.w += n
		if r.w == len(r.buf) {
			r.w = 0
			r.full = true
		}
		p = p[n:]
	}
}

func (r *ring) snapshot() []byte {
	if !r.full {
		out := make([]byte, r.w)
		copy(out, r.buf[:r.w])
		return out
	}
	out := make([]byte, len(r.buf))
	copy(out, r.buf[r.w:])
	copy(out[len(r.buf)-r.w:], r.buf[:r.w])
	return out
}

// snapshotSplit splits the ring into (head, tail) where tail is at most
// maxTailBytes from the end aligned to the next newline after the cut,
// and head is everything before. The cut never lands mid-line, so
// neither side starts on a partial escape sequence.
func (r *ring) snapshotSplit(maxTailBytes int) (head, tail []byte) {
	snap := r.snapshot()
	if len(snap) <= maxTailBytes {
		return nil, snap
	}
	cut := len(snap) - maxTailBytes
	if i := bytes.IndexByte(snap[cut:], '\n'); i >= 0 {
		cut += i + 1
	}
	return snap[:cut], snap[cut:]
}
