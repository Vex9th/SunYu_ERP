package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"time"
)

type dialContextFunc func(context.Context, string, string) (net.Conn, error)

type dnsDialTarget struct {
	name string
	dial dialContextFunc
}

type updateDialer struct {
	system   dialContextFunc
	fallback []dnsDialTarget
}

type updateRouteKey struct{}
type updateRoute struct {
	proxy   *url.URL
	host    string
	request context.Context
}

// 每一跳只判断一次代理；拨号层读取同一结果，代理失败不能绕过代理直连。
type updateTransport struct {
	base   *http.Transport
	proxy  func(*http.Request) (*url.URL, error)
	dialer *updateDialer
}

func newUpdateTransport() *updateTransport {
	base := http.DefaultTransport.(*http.Transport).Clone()
	dialer := &updateDialer{system: base.DialContext}
	for _, server := range []string{"223.5.5.5:53", "119.29.29.29:53"} {
		resolver := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, server)
		}}
		fallback := &net.Dialer{Timeout: 7 * time.Second, KeepAlive: 30 * time.Second, Resolver: resolver}
		dialer.fallback = append(dialer.fallback, dnsDialTarget{server, fallback.DialContext})
	}
	base.Proxy = func(r *http.Request) (*url.URL, error) {
		route, _ := r.Context().Value(updateRouteKey{}).(updateRoute)
		return route.proxy, nil
	}
	base.DialContext = dialer.DialContext
	base.TLSHandshakeTimeout = 30 * time.Second
	base.ResponseHeaderTimeout = 30 * time.Second
	return &updateTransport{base: base, proxy: platformProxy, dialer: dialer}
}

func (t *updateTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	proxy, err := t.proxy(r)
	if err != nil {
		if r.Body != nil {
			r.Body.Close()
		}
		return nil, err
	}
	route := updateRoute{proxy: proxy, request: r.Context()}
	if proxy == nil && (trustedURL(r.URL) || lanzouURL(r.URL.String())) {
		route.host = r.URL.Hostname()
	}
	return t.base.RoundTrip(r.WithContext(context.WithValue(r.Context(), updateRouteKey{}, route)))
}

func (t *updateTransport) CloseIdleConnections() { t.base.CloseIdleConnections() }

func (d *updateDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	route, _ := ctx.Value(updateRouteKey{}).(updateRoute)
	// Transport 会剥离拨号 context 的取消信号；恢复请求取消，并限制全部解析/拨号总时间。
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	if route.request != nil {
		stop := context.AfterFunc(route.request, cancel)
		defer stop()
		if err := route.request.Err(); err != nil {
			return nil, err
		}
	}
	conn, err := d.system(ctx, network, address)
	if err == nil {
		return conn, nil
	}
	host, port, splitErr := net.SplitHostPort(address)
	var dns *net.DNSError
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if splitErr != nil || port != "443" || route.proxy != nil || route.host == "" || host != route.host || !errors.As(err, &dns) {
		return nil, err
	}
	fmt.Fprintf(os.Stderr, "系统 DNS 解析失败（%s），尝试更新器备用 DNS：%s\n", host, safeNetworkDetail(err))
	for _, target := range d.fallback {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		attempt, done := context.WithTimeout(ctx, 7*time.Second)
		conn, err = target.dial(attempt, network, address)
		done()
		if err == nil {
			fmt.Fprintf(os.Stderr, "备用 DNS 连接成功（%s，%s）\n", host, target.name)
			return conn, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// 已解析但 TCP 连接失败时保留真实连接错误，不继续把它当作 DNS 问题。
		if !errors.As(err, &dns) {
			return nil, err
		}
		fmt.Fprintf(os.Stderr, "备用 DNS 解析失败（%s，%s）：%s\n", host, target.name, safeNetworkDetail(err))
	}
	return nil, err
}
