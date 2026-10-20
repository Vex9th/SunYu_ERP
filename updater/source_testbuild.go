//go:build updatertest

package main

import (
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net/http"
	"os"
	"strings"
)

var testManifest, testPackage string

func addTestFlags(f *flag.FlagSet) {
	f.StringVar(&testManifest, "test-manifest", "", "仅验收构建：本地正式清单映射")
	f.StringVar(&testPackage, "test-package", "", "仅验收构建：本地整包映射")
}
func testArguments() []string {
	if testManifest == "" {
		return nil
	}
	return []string{"--test-manifest", testManifest, "--test-package", testPackage}
}

type fixtureTransport struct {
	manifest Manifest
	raw      []byte
	archive  string
}

func (f fixtureTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	var body io.ReadCloser
	switch {
	case r.URL.String() == latestURL:
		b, _ := json.Marshal(map[string]string{"tag_name": "v" + f.manifest.Version})
		body = io.NopCloser(strings.NewReader(string(b)))
	case strings.HasSuffix(r.URL.Path, "/update-manifest-singlefile.json"):
		body = io.NopCloser(strings.NewReader(string(f.raw)))
	case r.URL.String() == f.manifest.Archive.URL:
		var err error
		body, err = os.Open(f.archive)
		if err != nil {
			return nil, err
		}
	default:
		return nil, errors.New("验收映射拒绝未知URL")
	}
	return &http.Response{StatusCode: 200, Body: body, Header: http.Header{}}, nil
}
func configureTestSource(e *Engine) error {
	if testManifest == "" && testPackage == "" {
		return nil
	}
	if testManifest == "" || testPackage == "" {
		return errors.New("测试清单和整包必须同时指定")
	}
	b, err := os.ReadFile(testManifest)
	if err != nil {
		return err
	}
	var m Manifest
	if err = json.Unmarshal(b, &m); err != nil {
		return err
	}
	if err = m.Validate(); err != nil {
		return err
	}
	e.client = &http.Client{Transport: fixtureTransport{m, b, testPackage}}
	e.mirror = nil
	return nil
}
