package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"

	"github.com/rohanthomare/baf/internal/project"
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

// TestProjectFrameOnConnect: after the cookie auth + WS upgrade, the
// server should push a `project` control frame describing the discovered
// .baf/config.toml (or null if none). The frame must arrive before the
// client could meaningfully render its settings sheet, so we read the
// first few text frames and assert one of them is the project frame.
func TestProjectFrameOnConnect(t *testing.T) {
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
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := l.Addr().String()
	_ = l.Close()

	token, _ := NewToken()
	proj := &project.Project{
		Sources: []project.Source{
			{
				Root: "/tmp/myproj",
				Name: "myproj",
				Commands: []project.Command{
					{ID: "abc12345", Name: "tests", Run: "make test"},
				},
			},
		},
	}
	ui := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}}
	s, err := New(Config{
		BindAddr: addr, TLSCert: cert, Token: token, UIFS: ui,
		Session: sess, Project: proj,
	})
	if err != nil {
		t.Fatalf("new: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = s.Run(ctx) }()
	if err := waitListen(addr, 2*time.Second); err != nil {
		t.Fatalf("never listened: %v", err)
	}

	pool := x509.NewCertPool()
	leaf, _ := x509.ParseCertificate(cert.Certificate[0])
	pool.AddCert(leaf)
	tr := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: "localhost"}}
	jar, _ := cookiejar.New(nil)
	httpClient := &http.Client{Transport: tr, Jar: jar}

	// Auth: GET /?t=<token> — let the redirect run so the cookie sticks.
	if _, err := httpClient.Get("https://" + addr + "/?t=" + url.QueryEscape(token)); err != nil {
		t.Fatalf("auth: %v", err)
	}

	// Dial the WS using the same HTTP client (cookie jar carries auth).
	dialCtx, dialCancel := context.WithTimeout(ctx, 3*time.Second)
	defer dialCancel()
	conn, _, err := websocket.Dial(dialCtx, "wss://"+addr+"/api/ws", &websocket.DialOptions{
		HTTPClient: httpClient,
	})
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "test done")

	// Read up to 6 frames; the project frame should arrive in that window
	// (geometry first, project right after, plus any binary replay).
	readCtx, readCancel := context.WithTimeout(ctx, 2*time.Second)
	defer readCancel()
	var sawProject bool
	for i := 0; i < 8 && !sawProject; i++ {
		typ, data, err := conn.Read(readCtx)
		if err != nil {
			t.Fatalf("ws read: %v", err)
		}
		if typ != websocket.MessageText {
			continue
		}
		var generic struct {
			Type    string           `json:"type"`
			Project *project.Project `json:"project"`
		}
		if err := json.Unmarshal(data, &generic); err != nil {
			continue
		}
		if generic.Type == "project" {
			sawProject = true
			if generic.Project == nil {
				t.Fatalf("project frame: want non-null, got null")
			}
			if len(generic.Project.Sources) != 1 {
				t.Fatalf("project payload should carry 1 source: %+v", generic.Project)
			}
			src := generic.Project.Sources[0]
			if src.Name != "myproj" || len(src.Commands) != 1 {
				t.Fatalf("source payload mismatch: %+v", src)
			}
			if src.Commands[0].ID != "abc12345" {
				t.Fatalf("command ID not preserved: %+v", src.Commands[0])
			}
		}
	}
	if !sawProject {
		t.Fatalf("project frame never arrived")
	}
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
