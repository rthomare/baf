// Package server runs the HTTPS + WebSocket front door for baf.
//
// Endpoints:
//   GET /?t=<token>  → if token matches the one-time login token, sets
//                       the session cookie and redirects to /. Token is
//                       consumed on first use.
//   GET /            → serves the embedded UI (gated by session cookie).
//   GET /api/ws      → WebSocket upgrade (gated by session cookie).
//                      Binary frames = raw PTY bytes both directions.
//                      Text frames = JSON control messages (resize, ping).
package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/rohanthomare/baf/internal/pty"
)

const (
	sessionCookie = "baf_session"
	tokenQueryKey = "t"
)

// Config controls how the server binds and authenticates.
type Config struct {
	BindAddr  string          // e.g. "192.168.1.42:8443"
	TLSCert   tls.Certificate // self-signed, from tlsgen
	Token     string          // one-time login token (URL ?t=...)
	UIFS      fs.FS           // embedded web/dist (production)
	DevProxy  string          // if non-empty, proxy UI requests here (e.g. "http://localhost:5173") instead of serving UIFS
	Session   *pty.Session
	OnFirstClient func()      // optional, called the first time a remote attaches
}

// Server wires routes and runs the HTTPS listener.
type Server struct {
	cfg Config

	mu          sync.Mutex
	tokenLive   bool   // becomes false after first successful exchange
	sessionID   string // cookie value gating /, /api/ws
	firedFirst  bool
}

// New returns a server ready to Run. Generates a session-cookie value
// immediately; the cookie is only set on the client when they prove
// possession of the token via /?t=<token>.
func New(cfg Config) (*Server, error) {
	id, err := randomHex(32)
	if err != nil {
		return nil, err
	}
	return &Server{cfg: cfg, tokenLive: true, sessionID: id}, nil
}

// Run blocks serving until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ws", s.handleWS)
	mux.Handle("/", s.staticHandler())

	srv := &http.Server{
		Addr:      s.cfg.BindAddr,
		Handler:   s.exchangeToken(mux),
		TLSConfig: &tls.Config{Certificates: []tls.Certificate{s.cfg.TLSCert}, MinVersion: tls.VersionTLS12},
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServeTLS("", "") }()
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		return err
	}
}

// exchangeToken intercepts the ?t=<token> query param. On match, it
// consumes the token (single-use), sets the session cookie, and redirects
// to a token-free URL so the QR-scanned link is bookmark-safe.
func (s *Server) exchangeToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if t := r.URL.Query().Get(tokenQueryKey); t != "" {
			s.mu.Lock()
			ok := s.tokenLive && subtle.ConstantTimeCompare([]byte(t), []byte(s.cfg.Token)) == 1
			if ok {
				s.tokenLive = false
			}
			s.mu.Unlock()
			if ok {
				http.SetCookie(w, &http.Cookie{
					Name:     sessionCookie,
					Value:    s.sessionID,
					Path:     "/",
					HttpOnly: true,
					Secure:   true,
					SameSite: http.SameSiteStrictMode,
					MaxAge:   60 * 60 * 24, // 24h
				})
				// Strip the token from the URL.
				q := r.URL.Query()
				q.Del(tokenQueryKey)
				r.URL.RawQuery = q.Encode()
				http.Redirect(w, r, r.URL.RequestURI(), http.StatusFound)
				return
			}
			// Bad token: fall through to handler, which will 401.
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) authenticated(r *http.Request) bool {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(c.Value), []byte(s.sessionID)) == 1
}

func (s *Server) staticHandler() http.Handler {
	if s.cfg.DevProxy != "" {
		return s.devProxyHandler()
	}
	fileServer := http.FileServer(http.FS(s.cfg.UIFS))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.authenticated(r) {
			http.Error(w, "unauthorized — open the URL from baf's terminal output", http.StatusUnauthorized)
			return
		}
		// Light cache control: the binary's UI is versioned by the binary
		// itself, but during dev we don't want stale assets.
		w.Header().Set("Cache-Control", "no-cache")
		// SPA-style fallback: unknown paths under / serve index.html so
		// client-side routing works if we ever add it.
		if r.URL.Path != "/" && !s.fileExists(r.URL.Path) {
			r.URL.Path = "/"
		}
		fileServer.ServeHTTP(w, r)
	})
}

// devProxyHandler reverse-proxies UI traffic (and Vite's HMR WebSocket) to a
// running Vite dev server. Auth is still enforced via the session cookie, and
// /api/ws is unaffected because it's routed by the mux before the static
// handler runs. Go's httputil.ReverseProxy handles WebSocket upgrades
// transparently, which is what makes HMR work end-to-end over our HTTPS
// listener.
func (s *Server) devProxyHandler() http.Handler {
	target, err := url.Parse(s.cfg.DevProxy)
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "bad BAF_DEV URL: "+err.Error(), http.StatusInternalServerError)
		})
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.authenticated(r) {
			http.Error(w, "unauthorized — open the URL from baf's terminal output", http.StatusUnauthorized)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}

func (s *Server) fileExists(urlPath string) bool {
	p := strings.TrimPrefix(urlPath, "/")
	if p == "" {
		p = "index.html"
	}
	f, err := s.cfg.UIFS.Open(p)
	if err != nil {
		return false
	}
	_ = f.Close()
	return true
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if !s.authenticated(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if !s.cfg.Session.TryAcquireRemote() {
		http.Error(w, "another mobile client is already connected", http.StatusConflict)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Same-origin is enforced by the cookie check above.
		InsecureSkipVerify: true,
	})
	if err != nil {
		// TryAcquireRemote succeeded — release it.
		// We do this via a temporary subscribe/detach with the writer flag.
		c, _, _ := s.cfg.Session.Subscribe(true)
		s.cfg.Session.Detach(c)
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "bye")

	client, replayTail, replayHistory := s.cfg.Session.Subscribe(true)
	defer s.cfg.Session.Detach(client)
	// If this client set a geometry override, drop it when they leave so
	// the host's terminal isn't stuck at mobile dimensions.
	defer func() { _ = s.cfg.Session.ReleaseOverride() }()

	s.mu.Lock()
	first := !s.firedFirst
	s.firedFirst = true
	s.mu.Unlock()
	if first && s.cfg.OnFirstClient != nil {
		s.cfg.OnFirstClient()
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Geometry is host-authoritative. Send the current size up front, then
	// re-send whenever the host's SIGWINCH triggers a resize. The mobile
	// client uses this to lay out its own renderer; it does NOT get to
	// reshape the PTY.
	writeGeometry := func(cols, rows uint16) {
		payload, err := json.Marshal(ctrlMsg{Type: "geometry", Cols: cols, Rows: rows})
		if err != nil {
			return
		}
		_ = conn.Write(ctx, websocket.MessageText, payload)
	}
	cols, rows := s.cfg.Session.Geometry()
	writeGeometry(cols, rows)
	cancelGeom := s.cfg.Session.OnGeometry(func(c, r uint16) {
		writeGeometry(c, r)
	})
	defer cancelGeom()

	// Initial replay, sent before starting the live drain so its frames
	// land first on the wire. Order: tail (binary) → history-start (text)
	// → history (binary) → history-end (text). The client builds its
	// blocks from the tail straight away and then prepends the older
	// history blocks when history-end arrives. Live PTY bytes broadcast
	// during this window buffer in client.Output() and flush right after.
	if len(replayTail) > 0 {
		_ = conn.Write(ctx, websocket.MessageBinary, replayTail)
	}
	if len(replayHistory) > 0 {
		if payload, err := json.Marshal(ctrlMsg{Type: "history-start"}); err == nil {
			_ = conn.Write(ctx, websocket.MessageText, payload)
		}
		_ = conn.Write(ctx, websocket.MessageBinary, replayHistory)
		if payload, err := json.Marshal(ctrlMsg{Type: "history-end"}); err == nil {
			_ = conn.Write(ctx, websocket.MessageText, payload)
		}
	}

	// PTY → WS (binary frames)
	go func() {
		for chunk := range client.Output() {
			if err := conn.Write(ctx, websocket.MessageBinary, chunk); err != nil {
				cancel()
				return
			}
		}
		cancel()
	}()

	// WS → PTY (binary frames) + control (text frames). 'resize' from the
	// client is intentionally ignored — the host owns geometry.
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		switch typ {
		case websocket.MessageBinary:
			if _, err := s.cfg.Session.Write(data); err != nil {
				return
			}
		case websocket.MessageText:
			var msg ctrlMsg
			if err := json.Unmarshal(data, &msg); err != nil {
				continue
			}
			switch msg.Type {
			case "ping":
				// no-op; presence of frame keeps the connection alive
			case "override-geometry":
				if msg.Cols > 0 && msg.Rows > 0 {
					_ = s.cfg.Session.OverrideGeometry(msg.Cols, msg.Rows)
				}
			case "release-geometry":
				_ = s.cfg.Session.ReleaseOverride()
			}
		}
	}
}

type ctrlMsg struct {
	Type string `json:"type"`
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
}

// NewToken generates a short URL-safe token for the one-time login link.
func NewToken() (string, error) { return randomHex(12) }

func randomHex(nBytes int) (string, error) {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// LANIP returns the first non-loopback IPv4 address on the host, which is
// the address mobile devices on the LAN will use to reach baf. Falls back
// to 127.0.0.1 if no LAN address is found (e.g. offline laptop).
func LANIP() net.IP {
	ifaces, err := net.Interfaces()
	if err != nil {
		return net.ParseIP("127.0.0.1")
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipnet.IP.To4()
			if ip4 == nil || ip4.IsLoopback() || ip4.IsLinkLocalUnicast() {
				continue
			}
			return ip4
		}
	}
	return net.ParseIP("127.0.0.1")
}

// URL builds the login URL printed and QR-encoded for the user.
func URL(ip net.IP, port int, token string) string {
	return fmt.Sprintf("https://%s:%d/?t=%s", ip.String(), port, token)
}
