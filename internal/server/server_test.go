package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/rohanthomare/baf/internal/pty"
	"github.com/rohanthomare/baf/internal/tlsgen"
	"net"
)

// Smoke test the auth + static serving path. The PTY backend is real
// (spawns /bin/sh) so this also catches obvious regressions in the
// session-attach codepath.
func TestServerAuthFlow(t *testing.T) {
	t.Parallel()
	sess, err := pty.Start("/bin/sh", nil, 80, 24, nil)
	if err != nil {
		t.Fatalf("pty start: %v", err)
	}
	defer sess.Close()

	cert, err := tlsgen.LoadOrCreate(t.TempDir(), net.ParseIP("127.0.0.1"))
	if err != nil {
		t.Fatalf("tls: %v", err)
	}

	// Pick a free loopback port.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := l.Addr().String()
	_ = l.Close()

	token, _ := NewToken()
	ui := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<!doctype html><title>baf</title>OK")},
	}
	s, err := New(Config{
		BindAddr: addr,
		TLSCert:  cert,
		Token:    token,
		UIFS:     ui,
		Session:  sess,
	})
	if err != nil {
		t.Fatalf("new: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() { errCh <- s.Run(ctx) }()

	// Give the listener a beat to bind.
	if err := waitListen(addr, 2*time.Second); err != nil {
		t.Fatalf("server never listened: %v", err)
	}

	pool := x509.NewCertPool()
	leaf, _ := x509.ParseCertificate(cert.Certificate[0])
	pool.AddCert(leaf)
	tr := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: "localhost"}}
	jar, _ := cookiejar.New(nil)
	client := &http.Client{
		Transport: tr,
		Jar:       jar,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse // we want to inspect each step
		},
	}

	base := "https://" + addr

	// 1. Unauthenticated GET / → 401.
	resp, err := client.Get(base + "/")
	if err != nil {
		t.Fatalf("GET /: %v", err)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("GET / unauth: want 401, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// 2. GET /?t=<token> → 302 + cookie.
	tokenURL := base + "/?t=" + url.QueryEscape(token)
	resp, err = client.Get(tokenURL)
	if err != nil {
		t.Fatalf("GET token: %v", err)
	}
	if resp.StatusCode != http.StatusFound {
		t.Errorf("token exchange: want 302, got %d", resp.StatusCode)
	}
	// Cookie should now be in the jar.
	u, _ := url.Parse(base)
	hasCookie := false
	for _, c := range jar.Cookies(u) {
		if c.Name == sessionCookie {
			hasCookie = true
			break
		}
	}
	if !hasCookie {
		t.Errorf("expected session cookie after token exchange")
	}
	resp.Body.Close()

	// 3. Authenticated GET / → 200 with our UI body.
	resp, err = client.Get(base + "/")
	if err != nil {
		t.Fatalf("auth GET /: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Errorf("auth GET /: want 200, got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(body), "baf") {
		t.Errorf("auth GET / body missing 'baf': %q", string(body))
	}

	// 4. Token can only be used once.
	resp, err = client.Get(tokenURL)
	if err != nil {
		t.Fatalf("token replay: %v", err)
	}
	if resp.StatusCode == http.StatusFound {
		t.Errorf("token replay should fail, got 302")
	}
	resp.Body.Close()
}

func waitListen(addr string, max time.Duration) error {
	deadline := time.Now().Add(max)
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err == nil {
			_ = c.Close()
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return context.DeadlineExceeded
}
