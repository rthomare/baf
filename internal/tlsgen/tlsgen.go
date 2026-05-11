// Package tlsgen lazily generates and caches a self-signed TLS cert.
//
// The first time baf runs we create an ECDSA P-256 cert under ~/.baf/
// with the host's LAN IP listed in the SAN, so a phone hitting
// https://<lan-ip>:port doesn't get a cert/host mismatch warning on top
// of the unavoidable self-signed warning. The cert is valid for 5 years;
// when it expires (or if the LAN IP changes meaningfully) we regenerate.
package tlsgen

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// LoadOrCreate returns a TLS certificate for the given LAN IP. On first
// call it writes cert.pem and key.pem under dir (typically ~/.baf/).
func LoadOrCreate(dir string, lanIP net.IP) (tls.Certificate, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return tls.Certificate{}, err
	}
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")

	if cert, ok := loadIfFresh(certPath, keyPath, lanIP); ok {
		return cert, nil
	}
	return generate(certPath, keyPath, lanIP)
}

func loadIfFresh(certPath, keyPath string, lanIP net.IP) (tls.Certificate, bool) {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return tls.Certificate{}, false
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return tls.Certificate{}, false
	}
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return tls.Certificate{}, false
	}
	// Parse the leaf to check expiry + SAN match.
	parsed, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return tls.Certificate{}, false
	}
	if time.Now().After(parsed.NotAfter.Add(-30 * 24 * time.Hour)) {
		return tls.Certificate{}, false
	}
	if lanIP != nil {
		found := false
		for _, ip := range parsed.IPAddresses {
			if ip.Equal(lanIP) {
				found = true
				break
			}
		}
		if !found {
			return tls.Certificate{}, false
		}
	}
	cert.Leaf = parsed
	return cert, true
}

func generate(certPath, keyPath string, lanIP net.IP) (tls.Certificate, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, err
	}
	template := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "baf"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(5 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"baf.local", "localhost"},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}
	if lanIP != nil {
		template.IPAddresses = append(template.IPAddresses, lanIP)
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return tls.Certificate{}, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(certPath, certPEM, 0o600); err != nil {
		return tls.Certificate{}, err
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return tls.Certificate{}, err
	}
	return tls.X509KeyPair(certPEM, keyPEM)
}
