//go:build windows

package main

import (
	"golang.org/x/net/http/httpproxy"
	"golang.org/x/sys/windows/registry"
	"net/http"
	"net/url"
	"os"
)

// Windows desktop proxy settings (including Clash system proxy) are a fallback
// to explicit process environment variables; TLS certificate validation stays enabled.
func platformProxy(r *http.Request) (*url.URL, error) {
	environment := httpproxy.FromEnvironment()
	if r.URL.Scheme == "https" && environment.HTTPSProxy != "" || r.URL.Scheme == "http" && environment.HTTPProxy != "" {
		return environment.ProxyFunc()(r.URL)
	}
	key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Internet Settings`, registry.QUERY_VALUE)
	if err != nil {
		return environment.ProxyFunc()(r.URL)
	}
	defer key.Close()
	enabled, _, err := key.GetIntegerValue("ProxyEnable")
	if err != nil || enabled == 0 {
		return environment.ProxyFunc()(r.URL)
	}
	raw, _, err := key.GetStringValue("ProxyServer")
	if err != nil {
		return nil, err
	}
	override, _, _ := key.GetStringValue("ProxyOverride")
	if bypassWindowsProxy(r.URL, override) {
		return nil, nil
	}
	selected, err := selectWindowsProxy(raw, r.URL.Scheme)
	if err != nil {
		return nil, err
	}
	cfg := &httpproxy.Config{HTTPProxy: selected, HTTPSProxy: selected, NoProxy: os.Getenv("NO_PROXY")}
	if cfg.NoProxy == "" {
		cfg.NoProxy = os.Getenv("no_proxy")
	}
	return cfg.ProxyFunc()(r.URL)
}
