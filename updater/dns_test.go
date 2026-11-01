package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func missingDNS() error {
	return &net.OpError{Op: "dial", Net: "tcp", Err: &net.DNSError{Name: "developer4.lanrar.com", Err: "no such host", IsNotFound: true}}
}

func TestUpdateDNSFallbackRouting(t *testing.T) {
	for _, tc := range []struct {
		name, address, proxy string
		failure              error
		want                 int
	}{
		{"lanzou", "https://developer4.lanrar.com/file", "", missingDNS(), 1},
		{"github", manifestURL, "", missingDNS(), 1},
		{"asset", signedAssetURL, "", missingDNS(), 1},
		{"proxy DNS", "https://developer4.lanrar.com/file", "http://proxy.invalid:8080", missingDNS(), 0},
		{"proxy with official hostname", "https://developer4.lanrar.com/file", "http://developer4.lanrar.com:443", missingDNS(), 0},
		{"untrusted", "https://example.com/file", "", missingDNS(), 0},
		{"custom port", "https://developer4.lanrar.com:8443/file", "", missingDNS(), 0},
		{"plain HTTP", "http://developer4.lanrar.com/file", "", missingDNS(), 0},
		{"connection failure", "https://developer4.lanrar.com/file", "", io.EOF, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			transport := newUpdateTransport()
			defer transport.CloseIdleConnections()
			proxyCalls, fallbackCalls := 0, 0
			transport.proxy = func(*http.Request) (*url.URL, error) {
				proxyCalls++
				if tc.proxy == "" {
					return nil, nil
				}
				return url.Parse(tc.proxy)
			}
			transport.dialer.system = func(context.Context, string, string) (net.Conn, error) { return nil, tc.failure }
			transport.dialer.fallback = []dnsDialTarget{{"test DNS", func(context.Context, string, string) (net.Conn, error) {
				fallbackCalls++
				return nil, io.EOF
			}}}
			req, _ := http.NewRequest(http.MethodGet, tc.address, nil)
			_, err := transport.RoundTrip(req)
			if err == nil || proxyCalls != 1 || fallbackCalls != tc.want {
				t.Fatalf("err=%v proxy calls=%d fallback calls=%d want=%d", err, proxyCalls, fallbackCalls, tc.want)
			}
		})
	}
}

func TestUpdateDNSSystemSuccessSkipsFallback(t *testing.T) {
	conn, peer := net.Pipe()
	defer conn.Close()
	defer peer.Close()
	d := &updateDialer{system: func(context.Context, string, string) (net.Conn, error) { return conn, nil }, fallback: []dnsDialTarget{{"unused", func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("system success must not use fallback")
		return nil, nil
	}}}}
	ctx := context.WithValue(context.Background(), updateRouteKey{}, updateRoute{host: "developer4.lanrar.com", request: context.Background()})
	got, err := d.DialContext(ctx, "tcp", "developer4.lanrar.com:443")
	if err != nil || got != conn {
		t.Fatal(got, err)
	}
}

func TestUpdateDNSFallbackExhaustionAndCancellation(t *testing.T) {
	for _, cancelRequest := range []bool{false, true} {
		t.Run(map[bool]string{false: "all resolvers failed", true: "request canceled during fallback"}[cancelRequest], func(t *testing.T) {
			request, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			d := &updateDialer{system: func(context.Context, string, string) (net.Conn, error) { return nil, missingDNS() }}
			for range 2 {
				d.fallback = append(d.fallback, dnsDialTarget{"test DNS", func(ctx context.Context, _, _ string) (net.Conn, error) {
					calls++
					if cancelRequest {
						cancel()
						<-ctx.Done()
						return nil, ctx.Err()
					}
					return nil, missingDNS()
				}})
			}
			ctx := context.WithValue(context.WithoutCancel(request), updateRouteKey{}, updateRoute{host: "developer4.lanrar.com", request: request})
			_, err := d.DialContext(ctx, "tcp", "developer4.lanrar.com:443")
			var dns *net.DNSError
			if cancelRequest {
				if calls != 1 || !errors.Is(err, context.Canceled) {
					t.Fatal(calls, err)
				}
			} else if calls != 2 || !errors.As(err, &dns) {
				t.Fatal(calls, err)
			}
		})
	}
}

func TestUpdateDNSFallbackHasSharedTimeBudget(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		d := &updateDialer{system: func(ctx context.Context, _, _ string) (net.Conn, error) {
			time.Sleep(35 * time.Second)
			return nil, missingDNS()
		}}
		calls := 0
		for range 2 {
			d.fallback = append(d.fallback, dnsDialTarget{"test DNS", func(ctx context.Context, _, _ string) (net.Conn, error) {
				calls++
				<-ctx.Done()
				return nil, &net.DNSError{Err: "timeout", IsTimeout: true}
			}})
		}
		ctx := context.WithValue(context.Background(), updateRouteKey{}, updateRoute{host: "developer4.lanrar.com", request: context.Background()})
		start := time.Now()
		_, err := d.DialContext(ctx, "tcp", "developer4.lanrar.com:443")
		if !errors.Is(err, context.DeadlineExceeded) || calls != 2 || time.Since(start) != 45*time.Second {
			t.Fatal(calls, time.Since(start), err)
		}
	})
}

type closeTrackedBody struct {
	io.Reader
	closed bool
}

func (b *closeTrackedBody) Close() error { b.closed = true; return nil }

func TestUpdateDNSProxySelectionErrorClosesBody(t *testing.T) {
	transport := newUpdateTransport()
	defer transport.CloseIdleConnections()
	want := errors.New("proxy selection failed")
	transport.proxy = func(*http.Request) (*url.URL, error) { return nil, want }
	body := &closeTrackedBody{Reader: strings.NewReader("file=123")}
	req, _ := http.NewRequest(http.MethodPost, "https://apifile.woozooo.com/api", body)
	_, err := transport.RoundTrip(req)
	if !errors.Is(err, want) || !body.closed {
		t.Fatal(err, body.closed)
	}
}

func updateDNSTLSServer(t *testing.T, handler http.Handler) (*httptest.Server, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), DNSNames: []string{"developer4.lanrar.com", "zip4.webgetstore.com"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	server.StartTLS()
	t.Cleanup(server.Close)
	return server, roots
}

func TestUpdateDNSFallbackPreservesTLSAndSinglePost(t *testing.T) {
	for _, trust := range []bool{true, false} {
		t.Run(map[bool]string{true: "trusted certificate", false: "untrusted certificate rejected"}[trust], func(t *testing.T) {
			var requests atomic.Int32
			server, roots := updateDNSTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				body, _ := io.ReadAll(r.Body)
				if r.Host != "developer4.lanrar.com" || r.TLS.ServerName != "developer4.lanrar.com" || string(body) != "file=123" {
					t.Errorf("changed HTTPS request: host=%s SNI=%s body=%s", r.Host, r.TLS.ServerName, body)
				}
				w.Write([]byte("ok"))
			}))
			transport := newUpdateTransport()
			defer transport.CloseIdleConnections()
			transport.proxy = func(*http.Request) (*url.URL, error) { return nil, nil }
			if !trust {
				roots = x509.NewCertPool()
			}
			transport.base.TLSClientConfig = &tls.Config{RootCAs: roots}
			transport.dialer.system = func(context.Context, string, string) (net.Conn, error) { return nil, missingDNS() }
			var fallback atomic.Int32
			transport.dialer.fallback = []dnsDialTarget{
				{"first resolver fails", func(context.Context, string, string) (net.Conn, error) { return nil, missingDNS() }},
				{"second resolver", func(ctx context.Context, network, address string) (net.Conn, error) {
					fallback.Add(1)
					if address != "developer4.lanrar.com:443" {
						t.Errorf("rewritten host: %s", address)
					}
					return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
				}},
			}
			client := &http.Client{Transport: transport}
			// 不可回放的 Body 也能成功，DNS 恢复发生在发送 HTTP 内容之前。
			body := &closeTrackedBody{Reader: strings.NewReader("file=123")}
			req, _ := http.NewRequest(http.MethodPost, "https://developer4.lanrar.com/file", body)
			response, err := client.Do(req)
			if trust {
				if err != nil {
					t.Fatal(err)
				}
				io.Copy(io.Discard, response.Body)
				response.Body.Close()
				if requests.Load() != 1 || fallback.Load() != 1 {
					t.Fatal(requests.Load(), fallback.Load())
				}
			} else if !certificateError(err) || requests.Load() != 0 || fallback.Load() != 1 {
				t.Fatal(err, requests.Load(), fallback.Load())
			}
		})
	}
}

func TestUpdateDNSRedirectReevaluatesRoute(t *testing.T) {
	server, roots := updateDNSTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			http.Redirect(w, r, "https://zip4.webgetstore.com/end", http.StatusFound)
			return
		}
		if r.Host != "zip4.webgetstore.com" || r.TLS.ServerName != "zip4.webgetstore.com" {
			t.Error(r.Host, r.TLS.ServerName)
		}
		w.Write([]byte("ok"))
	}))
	transport := newUpdateTransport()
	defer transport.CloseIdleConnections()
	var hosts []string
	transport.proxy = func(r *http.Request) (*url.URL, error) { hosts = append(hosts, r.URL.Hostname()); return nil, nil }
	transport.base.TLSClientConfig = &tls.Config{RootCAs: roots}
	transport.dialer.system = func(context.Context, string, string) (net.Conn, error) { return nil, missingDNS() }
	var calls atomic.Int32
	transport.dialer.fallback = []dnsDialTarget{{"test DNS", func(ctx context.Context, network, _ string) (net.Conn, error) {
		calls.Add(1)
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}}}
	client := newLanzouClient(transport).client
	response, err := client.Get("https://developer4.lanrar.com/start")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if strings.Join(hosts, ",") != "developer4.lanrar.com,zip4.webgetstore.com" || calls.Load() != 2 {
		t.Fatal(hosts, calls.Load())
	}
}

// 使用真实分发服务和备用 DNS；仅注入本进程的系统解析失败，不修改机器网络设置。
func TestUpdateDNSLivePublishedMirror(t *testing.T) {
	if os.Getenv("SUNYU_DNS_LIVE_TEST") != "1" {
		t.Skip("仅显式请求时验证真实 DNS 恢复与下载")
	}
	e, err := newEngine(t.TempDir(), "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	transport := e.client.Transport.(*updateTransport)
	defer transport.CloseIdleConnections()
	transport.proxy = func(*http.Request) (*url.URL, error) { return nil, nil }
	system := transport.dialer.system
	var forced atomic.Int32
	transport.dialer.system = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, _, _ := net.SplitHostPort(address)
		if strings.HasSuffix(host, ".lanrar.com") || strings.HasSuffix(host, ".webgetstore.com") {
			forced.Add(1)
			return nil, &net.DNSError{Name: host, Err: "injected NXDOMAIN", IsNotFound: true}
		}
		return system(ctx, network, address)
	}
	c := newLanzouClient(transport)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	r, err := c.release(ctx, os.Getenv("SUNYU_LANZOU_EXPECTED_VERSION"))
	if err != nil {
		t.Fatal(err)
	}
	if want := os.Getenv("SUNYU_LANZOU_EXPECTED_SHA256"); want == "" || r.manifest.Archive.SHA256 != want {
		t.Fatal("must match verified official archive SHA256")
	}
	path := filepath.Join(t.TempDir(), "release.zip")
	if err = c.download(ctx, r.archiveID, path); err != nil {
		t.Fatal(err)
	}
	got, err := hashFile(path)
	if err != nil || got != r.manifest.Archive.SHA256 {
		t.Fatal(got, err)
	}
	if err = extractPackage(path, filepath.Join(t.TempDir(), "stage"), r.manifest); err != nil {
		t.Fatal(err)
	}
	if forced.Load() == 0 {
		t.Fatal("download did not exercise DNS fallback")
	}
	t.Logf("direct HTTPS verified version=%s sha256=%s injected_DNS_failures=%d; archive and EXE hashes match", r.manifest.Version, got, forced.Load())
}
