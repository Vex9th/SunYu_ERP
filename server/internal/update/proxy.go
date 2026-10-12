package update

import (
	"errors"
	"net"
	"net/url"
	"path"
	"strings"
)

func selectWindowsProxy(raw, scheme string) (string, error) {
	fallback, socks, selected := "", "", ""
	for _, part := range strings.Split(raw, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key, value, ok := strings.Cut(part, "=")
		if !ok {
			fallback = part
			continue
		}
		switch strings.ToLower(strings.TrimSpace(key)) {
		case scheme:
			selected = strings.TrimSpace(value)
		case "socks":
			socks = strings.TrimSpace(value)
		}
	}
	if selected == "" {
		selected = fallback
	}
	if selected == "" && socks != "" {
		selected = "socks5://" + strings.TrimPrefix(socks, "socks5://")
	}
	if selected == "" {
		return "", nil
	}
	if !strings.Contains(selected, "://") {
		selected = "http://" + selected
	}
	u, err := url.Parse(selected)
	if err != nil || u.Hostname() == "" || u.Path != "" || u.Fragment != "" || u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "socks5" && u.Scheme != "socks5h" {
		return "", errors.New("Windows系统代理地址无效")
	}
	return u.String(), nil
}
func bypassWindowsProxy(u *url.URL, override string) bool {
	host := strings.ToLower(u.Hostname())
	if host == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return true
	}
	for _, entry := range strings.Split(override, ";") {
		entry = strings.ToLower(strings.TrimSpace(entry))
		if entry == "<local>" && !strings.Contains(host, ".") {
			return true
		}
		if entry == host || entry == strings.ToLower(u.Host) {
			return true
		}
		if match, _ := path.Match(entry, host); match {
			return true
		}
	}
	return false
}
