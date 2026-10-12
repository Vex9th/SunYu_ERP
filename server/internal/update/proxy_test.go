package update

import (
	"net/url"
	"testing"
)

func TestWindowsProxySelectionAndBypass(t *testing.T) {
	for _, tc := range []struct{ raw, scheme, want string }{{"127.0.0.1:7890", "https", "http://127.0.0.1:7890"}, {"http=127.0.0.1:7880;https=127.0.0.1:7890;socks=127.0.0.1:7891", "https", "http://127.0.0.1:7890"}, {"socks=127.0.0.1:7891", "https", "socks5://127.0.0.1:7891"}} {
		got, err := selectWindowsProxy(tc.raw, tc.scheme)
		if err != nil || got != tc.want {
			t.Fatal(tc, got, err)
		}
	}
	u, _ := url.Parse("https://github.com/Vex9th/SunYu_ERP/releases/latest")
	if bypassWindowsProxy(u, "<local>;*.github.com;github.com") != true {
		t.Fatal("explicit bypass ignored")
	}
	if bypassWindowsProxy(u, "<local>;127.*") {
		t.Fatal("public host incorrectly bypassed")
	}
	u, _ = url.Parse("http://localhost:8765")
	if !bypassWindowsProxy(u, "<local>") {
		t.Fatal("local host not bypassed")
	}
}
