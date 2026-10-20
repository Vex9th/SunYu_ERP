package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func mirrorFixture(t *testing.T) (Manifest, []byte) {
	t.Helper()
	m := manifestFixture()
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	w, _ := z.Create("update-manifest-singlefile.json")
	json.NewEncoder(w).Encode(struct {
		Manifest
		Name string `json:"lanzou_archive"`
	}{m, "2026102001.zip"})
	z.Close()
	return m, b.Bytes()
}

func TestLanzouParsesDynamicFolderAndDownloadWithoutGitHub(t *testing.T) {
	m, payload := mirrorFixture(t)
	calls := 0
	c := newLanzouClient(transportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		var body string
		switch {
		case r.URL.Path == "/b019w91rof":
			body = `var random_t='123'; var random_k='abc';
			$.ajax({url:'/filemoreajax.php?file=14123945',data:{'lx':2,'fid':14123945,'pg':pgs,'t':random_t,'k':random_k,'pwd':pwd}})`
		case r.URL.Path == "/filemoreajax.php":
			r.ParseForm()
			if r.Form.Get("pwd") != "hru1" || r.Form.Get("t") != "123" || r.Form.Get("k") != "abc" || r.Form.Get("pg") != "1" {
				t.Fatal(r.Form)
			}
			body = `{"zt":1,"text":[{"id":"imanifest","name_all":"SunERP_v1.2.5_manifest.zip"},{"id":"ipackage","name_all":"2026102001.zip"},{"id":"https://ads.invalid/","name_all":"promotion","t":1}]}`
		case r.URL.Path == "/imanifest":
			body = `<iframe class="ifr2" src="/fn?dynamic"></iframe>`
		case r.URL.Path == "/fn":
			body = `var ajaxdata='nonce';var wp_sign='fresh';
			var domain1='https://apifile.woozooo.com/ajaxfile.php?file=42';
			$.ajax({url:dom_ajaxs,data:{'action':'downprocess','sign':wp_sign,'signs':ajaxdata,'websignkey':ajaxdata,'websign':'','kd':kdns,'ves':1}})`
		case r.URL.Path == "/ajaxfile.php":
			r.ParseForm()
			if r.Form.Get("sign") != "fresh" || r.Form.Get("kd") != "1" {
				t.Fatal(r.Form)
			}
			body = `{"zt":1,"dom":"https://developer4.lanrar.com","url":"temporary"}`
		case r.URL.Path == "/file/temporary":
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(payload))}, nil
		default:
			t.Fatalf("unexpected source %s", r.URL.Host)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
	}))
	got, err := c.latest(context.Background())
	if err != nil || got.manifest.Version != m.Version || got.archiveID != "ipackage" || calls != 6 {
		t.Fatal(got, err, calls)
	}
}

func TestLanzouRejectsUntrustedURLsAndInteractiveVerification(t *testing.T) {
	for _, raw := range []string{"http://developer4.lanrar.com/file/x", "https://lanrar.com.evil.test/x", "https://127.0.0.1/x", "https://user@urldown.lanzouw.com/x", "https://developer4.lanrar.com:443/x"} {
		if lanzouURL(raw) {
			t.Fatal("accepted", raw)
		}
	}
	c := newLanzouClient(transportFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/html"}}, Body: io.NopCloser(strings.NewReader("<html>系统发现您的网络异常，需要验证后下载文件</html>"))}, nil
	}))
	_, err := c.readArchive(context.Background(), "https://developer4.lanrar.com/file/x", 1024)
	if err == nil || !strings.Contains(err.Error(), "验证") {
		t.Fatal(err)
	}
}

func TestLanzouManifestRejectsMissingDuplicateAndUnsafeArchive(t *testing.T) {
	m, good := mirrorFixture(t)
	if _, err := readMirrorManifest(good, m.Version); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../Data/config.json", "https://bad.test/a.zip", "SunERP.zip", "2026102001.zip/"} {
		var b bytes.Buffer
		z := zip.NewWriter(&b)
		w, _ := z.Create("update-manifest-singlefile.json")
		json.NewEncoder(w).Encode(map[string]any{"format": 1, "application": m.Application, "version": m.Version, "archive": m.Archive, "files": m.Files, "lanzou_archive": name})
		z.Close()
		if _, err := readMirrorManifest(b.Bytes(), m.Version); err == nil {
			t.Fatal(name)
		}
	}
}

type failingMirror struct{}

func (failingMirror) latest(context.Context) (mirrorRelease, error) {
	return mirrorRelease{}, errors.New("蓝奏不可用")
}
func (failingMirror) download(context.Context, string, string) error {
	return errors.New("蓝奏不可用")
}

func TestMirrorFailureFallsBackToGitHubWithoutStopping(t *testing.T) {
	e, _ := newEngine(t.TempDir(), "0123456789abcdef0123456789abcdef")
	e.current = "1.2.4"
	e.mirror = failingMirror{}
	m := manifestFixture()
	svc := &fakeServices{running: true}
	e.services = svc
	e.client = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		body := `{"tag_name":"v1.2.5"}`
		if strings.HasSuffix(r.URL.Path, ".json") {
			b, _ := json.Marshal(m)
			body = string(b)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	if err := e.run(false); err != nil || e.status.Phase != "available" || svc.stops != 0 {
		t.Fatal(err, e.status, svc)
	}
}

func TestLanzouFailedDownloadDoesNotOverwriteExistingFile(t *testing.T) {
	c := newLanzouClient(nil)
	target := filepath.Join(t.TempDir(), "package.zip")
	os.WriteFile(target, []byte("keep"), 0600)
	if err := c.download(context.Background(), "ifile", target); err == nil {
		t.Fatal("overwrote existing destination")
	}
	b, _ := os.ReadFile(target)
	if string(b) != "keep" {
		t.Fatal(string(b))
	}
}

func TestLanzouConfirmationWaitsForPageAndHandlesCookie(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		_, payload := mirrorFixture(t)
		started := time.Now()
		confirmations := 0
		// 合成普通 JS 校验参数，不保存真实站点令牌。
		key := base64.NewEncoding("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/").EncodeToString([]byte(strings.Repeat("0", 40)))
		challenge := "<html><script>var arg1='1111111111111111111111111111111111111111';var m=[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40];var key='" + key + "';</script>"
		c := newLanzouClient(transportFunc(func(r *http.Request) (*http.Response, error) {
			var body string
			switch r.URL.Path {
			case "/file/start":
				body = `function down_r(el){ $.ajax({url : 'ajax.php', data:{'file':'temporary','el':el,'sign':'signed'}}); }`
			case "/file/ajax.php":
				if time.Since(started) < 2*time.Second {
					t.Fatal("confirmed before the page delay")
				}
				confirmations++
				r.ParseForm()
				if r.Form.Get("el") != "2" || r.Form.Get("sign") != "signed" {
					t.Fatal(r.Form)
				}
				if confirmations == 1 {
					body = challenge
				} else {
					cookie, err := r.Cookie("acw_sc__v2")
					if err != nil || cookie.Value != strings.Repeat("1", 40) {
						t.Fatal(cookie, err)
					}
					body = `{"zt":1,"url":"https://zip2.webgetstore.com/download.zip"}`
				}
			case "/download.zip":
				body = string(payload)
			default:
				t.Fatal(r.URL.Path)
			}
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
		}))
		got, err := c.readArchive(context.Background(), "https://developer4.lanrar.com/file/start", mirrorManifestLimit)
		if err != nil || !bytes.Equal(got, payload) || confirmations != 2 {
			t.Fatal(err, confirmations)
		}
	})
}

type staticMirror struct {
	release mirrorRelease
	data    []byte
}

func (m staticMirror) latest(context.Context) (mirrorRelease, error) { return m.release, nil }
func (m staticMirror) download(_ context.Context, _, target string) error {
	return os.WriteFile(target, m.data, 0600)
}

func TestMirrorStaleVersionChecksGitHubWithBoundedDeadline(t *testing.T) {
	e, _ := newEngine(t.TempDir(), "0123456789abcdef0123456789abcdef")
	e.current = "1.2.4"
	e.mirror = staticMirror{release: mirrorRelease{manifest: Manifest{Version: "1.2.4"}}}
	m := manifestFixture()
	calls := 0
	e.client = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		deadline, ok := r.Context().Deadline()
		if !ok || time.Until(deadline) > 8*time.Second {
			t.Fatal("missing bounded stale-mirror probe")
		}
		body := []byte(`{"tag_name":"v1.2.5"}`)
		if r.URL.String() != latestURL {
			body, _ = json.Marshal(m)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body))}, nil
	})}
	v, got, mirrorID, err := e.latestRelease()
	if err != nil || v != "1.2.5" || got.Version != v || mirrorID != "" || calls != 2 {
		t.Fatal(v, got, mirrorID, err, calls)
	}
}

func TestMirrorNewReleaseDoesNotDependOnGitHub(t *testing.T) {
	e, _ := newEngine(t.TempDir(), "0123456789abcdef0123456789abcdef")
	e.current = "1.2.4"
	m := manifestFixture()
	e.mirror = staticMirror{release: mirrorRelease{manifest: m, archiveID: "ifile"}}
	e.client = &http.Client{Transport: transportFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("new mirror release unexpectedly contacted GitHub")
		return nil, errors.New("unavailable")
	})}
	v, _, mirrorID, err := e.latestRelease()
	if err != nil || v != m.Version || mirrorID != "ifile" {
		t.Fatal(v, mirrorID, err)
	}
}

func TestMirrorCorruptArchiveFallsBackWithoutStoppingService(t *testing.T) {
	e, _ := newEngine(t.TempDir(), "0123456789abcdef0123456789abcdef")
	e.mirror = staticMirror{data: []byte("corrupt mirror bytes")}
	svc := &fakeServices{running: true}
	e.services = svc
	calls := 0
	e.client = &http.Client{Transport: transportFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("official bytes"))}, nil
	})}
	target := filepath.Join(t.TempDir(), "package.zip")
	if err := e.downloadRelease(manifestFixture(), "ifile", target); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(target)
	if string(got) != "official bytes" || calls != 1 || svc.stops != 0 {
		t.Fatal(string(got), calls, svc)
	}
}

func TestLanzouInterruptedDownloadReparsesAndRemovesPartialFile(t *testing.T) {
	downloads, resolves := 0, 0
	c := newLanzouClient(transportFunc(func(r *http.Request) (*http.Response, error) {
		var body io.Reader
		switch r.URL.Path {
		case "/ifile":
			resolves++
			body = strings.NewReader(`<iframe src="/fn?fresh"></iframe>`)
		case "/fn":
			body = strings.NewReader(`var domain1='https://apifile.woozooo.com/ajaxfile.php';$.ajax({data:{'action':'downprocess','sign':'fresh'}})`)
		case "/ajaxfile.php":
			body = strings.NewReader(`{"zt":1,"dom":"https://developer4.lanrar.com","url":"temporary"}`)
		case "/file/temporary":
			downloads++
			body = io.MultiReader(strings.NewReader("PK\x03\x04"), &interruptedBody{})
		default:
			t.Fatal(r.URL.Path)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(body)}, nil
	}))
	target := filepath.Join(t.TempDir(), "package.zip")
	err := c.download(context.Background(), "ifile", target)
	if !errors.Is(err, io.ErrUnexpectedEOF) || resolves != 2 || downloads != 2 {
		t.Fatal(err, resolves, downloads)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("partial file retained", err)
	}
}

func TestLanzouLivePublishedMirror(t *testing.T) {
	if os.Getenv("SUNYU_LANZOU_LIVE_TEST") != "1" {
		t.Skip("仅显式请求时访问真实分发目录")
	}
	e, err := newEngine(t.TempDir(), "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	c := newLanzouClient(e.client.Transport)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	r, err := c.release(ctx, os.Getenv("SUNYU_LANZOU_EXPECTED_VERSION"))
	if err != nil {
		t.Fatal(err)
	}
	if want := os.Getenv("SUNYU_LANZOU_EXPECTED_VERSION"); want != "" && r.manifest.Version != want {
		t.Fatalf("mirror version=%s, expected=%s", r.manifest.Version, want)
	}
	if want := os.Getenv("SUNYU_LANZOU_EXPECTED_SHA256"); want != "" && r.manifest.Archive.SHA256 != want {
		t.Fatal("mirror manifest differs from verified official release")
	}
	path := filepath.Join(t.TempDir(), "release.zip")
	if err := c.download(ctx, r.archiveID, path); err != nil {
		t.Fatal(err)
	}
	got, err := hashFile(path)
	if err != nil || got != r.manifest.Archive.SHA256 {
		t.Fatal(got, err)
	}
	if err := extractPackage(path, filepath.Join(t.TempDir(), "stage"), r.manifest); err != nil {
		t.Fatal(err)
	}
	t.Logf("verified version=%s archive_sha256=%s; archive and both executable hashes match", r.manifest.Version, got)
}
