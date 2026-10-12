//go:build !windows

package main

import (
	"net/http"
	"net/url"
)

func platformProxy(r *http.Request) (*url.URL, error) { return http.ProxyFromEnvironment(r) }
