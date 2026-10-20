package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"time"
)

const downloadAttempts = 3

type httpStatusError struct{ code int }

func (e *httpStatusError) Error() string { return fmt.Sprintf("HTTP %d", e.code) }

type updateRequestError struct {
	host  string
	cause error
}

func (e *updateRequestError) Unwrap() error { return e.cause }
func (e *updateRequestError) Error() string {
	reason := "请求失败：" + safeNetworkDetail(e.cause)
	var status *httpStatusError
	var network net.Error
	var dns *net.DNSError
	switch {
	case errors.As(e.cause, &status):
		switch status.code {
		case 404:
			reason = "官方更新文件不存在（HTTP 404），请稍后检查正式版附件"
		case 429:
			reason = "官方服务请求过于频繁（HTTP 429），请稍后重试"
		default:
			reason = fmt.Sprintf("官方更新服务返回 HTTP %d，请稍后重试", status.code)
		}
	case certificateError(e.cause):
		reason = "TLS 证书验证失败，请检查系统时间和网络证书"
	case errors.As(e.cause, &network) && network.Timeout():
		reason = "连接超时，请稍后重试；若持续失败，请检查网络能否访问更新下载服务"
	case errors.As(e.cause, &dns):
		reason = "无法解析官方更新地址，请检查 DNS 或网络后重试"
	case errors.Is(e.cause, io.ErrUnexpectedEOF) || errors.Is(e.cause, io.EOF):
		reason = "下载连接中断，请稍后重试"
	case errors.Is(e.cause, context.Canceled):
		reason = "更新请求已取消"
	}
	return fmt.Sprintf("%s（%s）", reason, e.host)
}

// 保留原始原因供 errors.Is/As 使用，界面与日志不输出临时签名 URL。
var networkURL = regexp.MustCompile(`https?://[^\s"<>]+`)

func safeNetworkDetail(err error) string {
	return networkURL.ReplaceAllStringFunc(err.Error(), func(raw string) string {
		u, parseErr := url.Parse(raw)
		if parseErr != nil {
			return "[下载地址]"
		}
		return u.Hostname()
	})
}
func requestHost(address string, err error) string {
	var request *url.Error
	if errors.As(err, &request) {
		address = request.URL
	}
	if parsed, parseErr := url.Parse(address); parseErr == nil && parsed.Hostname() != "" {
		return parsed.Hostname()
	}
	return "GitHub"
}
func certificateError(err error) bool {
	var authority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	var verification *tls.CertificateVerificationError
	return errors.As(err, &authority) || errors.As(err, &hostname) || errors.As(err, &invalid) || errors.As(err, &verification)
}
func retryableRequestError(err error) bool {
	if certificateError(err) {
		return false
	}
	var status *httpStatusError
	if errors.As(err, &status) {
		return status.code == 408 || status.code == 429 || status.code >= 500 && status.code <= 599
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
		return true
	}
	var network net.Error
	if errors.As(err, &network) && (network.Timeout() || network.Temporary()) {
		return true
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return false
	}
	var connection *net.OpError
	return errors.As(err, &connection)
}

func (e *Engine) requestWithRetry(ctx context.Context, address string, consume func(io.Reader) error) error {
	u, err := url.Parse(address)
	if err != nil || !trustedURL(u) {
		return errors.New("拒绝非官方更新来源")
	}
	for attempt := 1; attempt <= downloadAttempts; attempt++ {
		// 每次从原始官方地址重新请求，以获取新的重定向和临时签名。
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", "SunYu-ERP-Singlefile-Updater/"+version)
		req.Header.Set("Cache-Control", "no-cache")
		response, err := e.client.Do(req)
		if err == nil {
			if response.StatusCode != http.StatusOK {
				err = &httpStatusError{response.StatusCode}
			} else {
				err = consume(response.Body)
			}
			response.Body.Close()
		}
		if err == nil {
			return nil
		}
		fmt.Fprintf(os.Stderr, "官方更新请求失败（%s，第 %d/%d 次）：%s\n", requestHost(address, err), attempt, downloadAttempts, safeNetworkDetail(err))
		if attempt == downloadAttempts || ctx.Err() != nil || !retryableRequestError(err) {
			return &updateRequestError{requestHost(address, err), err}
		}
		if e.status.Phase != "" {
			if progressErr := e.progress(e.status.Phase, fmt.Sprintf("连接官方更新服务中断，正在重试（%d/%d）", attempt+1, downloadAttempts), e.status.Progress); progressErr != nil {
				return progressErr
			}
		}
		timer := time.NewTimer(time.Duration(attempt) * time.Second)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return &updateRequestError{u.Hostname(), ctx.Err()}
		}
	}
	panic("unreachable")
}

func (e *Engine) fetchJSON(address string, v any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	return e.fetchJSONContext(ctx, address, v)
}

func (e *Engine) fetchJSONContext(ctx context.Context, address string, v any) error {
	var payload []byte
	if err := e.requestWithRetry(ctx, address, func(body io.Reader) error {
		b, err := io.ReadAll(io.LimitReader(body, 2<<20+1))
		if err != nil {
			return err
		}
		if len(b) > 2<<20 {
			return errors.New("官方清单过大")
		}
		payload = b
		return nil
	}); err != nil {
		return err
	}
	if err := json.Unmarshal(payload, v); err != nil {
		return fmt.Errorf("官方更新数据格式无效：%w", err)
	}
	return nil
}
func (e *Engine) download(address, target string) (result error) {
	f, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer func() {
		result = errors.Join(result, f.Close())
		if result != nil {
			result = errors.Join(result, os.Remove(target))
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	result = e.requestWithRetry(ctx, address, func(body io.Reader) error {
		// 文件由本次调用独占创建，失败重试先清空本次部分下载，绝不追加残缺内容。
		if err := f.Truncate(0); err != nil {
			return err
		}
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return err
		}
		n, err := io.Copy(f, io.LimitReader(body, maxArchive+1))
		if err != nil {
			return err
		}
		if n > maxArchive {
			return errors.New("更新包超过大小限制")
		}
		return nil
	})
	if result == nil {
		result = f.Sync()
	}
	return result
}
