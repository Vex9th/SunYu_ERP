package main

import (
	"crypto/x509"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
)

type handshakeTimeout struct{}

func (handshakeTimeout) Error() string   { return "net/http: TLS handshake timeout" }
func (handshakeTimeout) Timeout() bool   { return true }
func (handshakeTimeout) Temporary() bool { return true }

const manifestURL = "https://github.com/Vex9th/SunYu_ERP/releases/download/v1.2.8/update-manifest-singlefile.json"
const signedAssetURL = "https://release-assets.githubusercontent.com/test/manifest?sig=PRIVATE_SIGNED_QUERY"

func TestManifestRetriesFromOfficialURLAfterRedirectHandshakeTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		e, _ := newEngine(t.TempDir(), "0123456789abcdef0123456789abcdef")
		starts, assets := 0, 0
		e.client = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
			if r.URL.String() == manifestURL {
				starts++
				return &http.Response{StatusCode: 302, Header: http.Header{"Location": {signedAssetURL}}, Body: io.NopCloser(strings.NewReader(""))}, nil
			}
			if r.URL.String() != signedAssetURL {
				t.Fatalf("unexpected URL %s", r.URL.Host)
			}
			assets++
			if assets < 3 {
				return nil, handshakeTimeout{}
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"version":"1.2.8"}`))}, nil
		})}
		var result struct{ Version string }
		if err := e.fetchJSON(manifestURL, &result); err != nil {
			t.Fatal(err)
		}
		if starts != 3 || assets != 3 || result.Version != "1.2.8" {
			t.Fatal(starts, assets, result)
		}
	})
}

func TestManifestTimeoutIsBoundedAccurateAndKeepsServiceRunning(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		e, _ := newEngine(t.TempDir(), "1123456789abcdef0123456789abcdef")
		e.current = "1.2.7"
		svc := &fakeServices{running: true}
		e.services = svc
		attempts := 0
		e.client = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
			if r.URL.String() == latestURL {
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"tag_name":"v1.2.8"}`))}, nil
			}
			if r.URL.String() == manifestURL {
				return &http.Response{StatusCode: 302, Header: http.Header{"Location": {signedAssetURL}}, Body: io.NopCloser(strings.NewReader(""))}, nil
			}
			attempts++
			return nil, handshakeTimeout{}
		})}
		err := e.run(true)
		if err == nil || attempts != 3 {
			t.Fatal(err, attempts)
		}
		for _, text := range []string{err.Error(), e.status.Error, e.status.Message} {
			if !strings.Contains(text, "超时") || strings.Contains(text, "尚未提供") || strings.Contains(text, "PRIVATE_SIGNED_QUERY") || strings.Contains(text, "https://") {
				t.Fatal(text)
			}
		}
		var timeout handshakeTimeout
		if !errors.As(err, &timeout) {
			t.Fatalf("cause lost: %v", err)
		}
		if svc.stops != 0 || !svc.running || e.status.Busy || e.status.Phase != "failed" {
			t.Fatal(svc, e.status)
		}
	})
}

func TestUpdateHTTPFailuresRetryOnlyTemporaryStatuses(t *testing.T) {
	for _, code := range []int{404, 403, 503, 429} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				e, _ := newEngine(t.TempDir(), "2123456789abcdef0123456789abcdef")
				attempts := 0
				e.client = &http.Client{Transport: transportFunc(func(*http.Request) (*http.Response, error) {
					attempts++
					return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader(""))}, nil
				})}
				var result any
				err := e.fetchJSON(manifestURL, &result)
				want := 1
				if code == 503 || code == 429 {
					want = 3
				}
				if err == nil || attempts != want {
					t.Fatal(err, attempts, want)
				}
				if code == 404 && !strings.Contains(err.Error(), "404") {
					t.Fatal(err)
				}
			})
		})
	}
}

func TestUpdateCertificateFailureIsNotRetriedOrHidden(t *testing.T) {
	e, _ := newEngine(t.TempDir(), "3123456789abcdef0123456789abcdef")
	attempts := 0
	e.client = &http.Client{Transport: transportFunc(func(*http.Request) (*http.Response, error) { attempts++; return nil, x509.UnknownAuthorityError{} })}
	var result any
	err := e.fetchJSON(manifestURL, &result)
	var cert x509.UnknownAuthorityError
	if err == nil || attempts != 1 || !errors.As(err, &cert) || !strings.Contains(err.Error(), "证书") {
		t.Fatal(err, attempts)
	}
}

type interruptedBody struct{ sent bool }

func (b *interruptedBody) Read(p []byte) (int, error) {
	if !b.sent {
		b.sent = true
		return copy(p, "partial"), nil
	}
	return 0, io.ErrUnexpectedEOF
}
func (*interruptedBody) Close() error { return nil }

func TestUpdateInterruptedDownloadRestartsWithoutAppendingPartialBytes(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		e, _ := newEngine(t.TempDir(), "4123456789abcdef0123456789abcdef")
		attempts := 0
		e.client = &http.Client{Transport: transportFunc(func(*http.Request) (*http.Response, error) {
			attempts++
			var body io.ReadCloser = &interruptedBody{}
			if attempts > 1 {
				body = io.NopCloser(strings.NewReader("complete archive"))
			}
			return &http.Response{StatusCode: 200, Body: body}, nil
		})}
		target := filepath.Join(t.TempDir(), "package.zip")
		if err := e.download("https://github.com/Vex9th/SunYu_ERP/releases/download/v1.2.8/SunYu_ERP-windows-x64.zip", target); err != nil {
			t.Fatal(err)
		}
		b, _ := os.ReadFile(target)
		if string(b) != "complete archive" || attempts != 2 {
			t.Fatal(string(b), attempts)
		}
		if err := e.download(manifestURL, target); err == nil {
			t.Fatal("overwrote existing file")
		}
		b, _ = os.ReadFile(target)
		if string(b) != "complete archive" {
			t.Fatal(string(b))
		}
	})
}

func TestUpdateExhaustedDownloadRemovesOnlyOwnPartialFile(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		e, _ := newEngine(t.TempDir(), "5123456789abcdef0123456789abcdef")
		attempts := 0
		e.client = &http.Client{Transport: transportFunc(func(*http.Request) (*http.Response, error) {
			attempts++
			return &http.Response{StatusCode: 200, Body: &interruptedBody{}}, nil
		})}
		target := filepath.Join(t.TempDir(), "package.zip")
		err := e.download(manifestURL, target)
		if err == nil || attempts != 3 {
			t.Fatal(err, attempts)
		}
		if _, statErr := os.Stat(target); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatal(statErr)
		}
	})
}
