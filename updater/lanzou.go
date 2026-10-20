package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/html"
)

const lanzouFolder = "https://urldown.lanzouw.com/b019w91rof"
const lanzouOrigin = "https://urldown.lanzouw.com"
const lanzouPassword = "hru1" // 公开分发目录的提取码，不是账号登录凭据。
const mirrorManifestLimit = 2 << 20

var mirrorName = regexp.MustCompile(`^SunERP_v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))_manifest\.zip$`)
var mirrorArchiveName = regexp.MustCompile(`^[0-9]{10}\.zip$`)
var shareID = regexp.MustCompile(`^i[A-Za-z0-9_-]+$`)
var jsVars = regexp.MustCompile(`\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(?:'([^']*)'|"([^"]*)"|([0-9]+))`)
var jsData = regexp.MustCompile(`(?s)\bdata\s*:\s*\{([^}]+)\}`)
var jsFields = regexp.MustCompile(`['"](\w+)['"]\s*:\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*|[0-9]+))`)
var jsURL = regexp.MustCompile(`\burl\s*:\s*['"]([^'"]+)['"]`)

type mirrorRelease struct {
	manifest  Manifest
	archiveID string
}
type updateMirror interface {
	latest(context.Context) (mirrorRelease, error)
	download(context.Context, string, string) error
}
type lanzouClient struct{ client *http.Client }
type mirrorManifest struct {
	Manifest
	ArchiveName string `json:"lanzou_archive"`
}
type lanzouFile struct {
	ID   string `json:"id"`
	Name string `json:"name_all"`
	Ad   int    `json:"t"`
}

func newLanzouClient(transport http.RoundTripper) *lanzouClient {
	return &lanzouClient{&http.Client{
		Transport: transport, Timeout: 15 * time.Minute,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 || !lanzouURL(req.URL.String()) {
				return errors.New("蓝奏下载重定向不受信任")
			}
			return nil
		},
	}}
}

// 限定已验证的分享、解析、下载域名；不接受第三方解析站、明文或任意端口。
func lanzouURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Fragment != "" {
		return false
	}
	host := u.Hostname()
	if host == "urldown.lanzouw.com" || host == "apifile.woozooo.com" || host == "apifile.lanzouw.com" {
		return true
	}
	return regexp.MustCompile(`^developer[0-9]+\.lanrar\.com$`).MatchString(host) ||
		regexp.MustCompile(`^zip[0-9]+\.webgetstore\.com$`).MatchString(host)
}

func literalData(page string, overrides map[string]string) (url.Values, map[string]string, error) {
	vars := map[string]string{}
	for _, m := range jsVars.FindAllStringSubmatch(page, -1) {
		vars[m[1]] = m[2] + m[3] + m[4]
	}
	for k, v := range overrides {
		vars[k] = v
	}
	match := jsData.FindStringSubmatch(page)
	if match == nil {
		return nil, vars, errors.New("蓝奏页面接口格式已变化")
	}
	values := url.Values{}
	for _, m := range jsFields.FindAllStringSubmatch(match[1], -1) {
		value := m[2] + m[3]
		if m[4] != "" {
			if n, err := strconv.Atoi(m[4]); err == nil {
				value = strconv.Itoa(n)
			} else {
				var ok bool
				value, ok = vars[m[4]]
				if !ok {
					return nil, vars, errors.New("蓝奏动态参数无法解析")
				}
			}
		}
		values.Set(m[1], value)
	}
	return values, vars, nil
}

// 只处理站点公开页面的字面参数，不执行下载页 JavaScript。
func (c *lanzouClient) request(ctx context.Context, address string, data url.Values, consume func(io.Reader) error) error {
	if !lanzouURL(address) {
		return errors.New("拒绝非蓝奏官方节点")
	}
	// 分享下载不携带账号会话，只处理当前节点返回的临时浏览器校验。
	client := *c.client
	client.Jar = nil
	cookie := ""
	for attempt := 0; attempt < 2; attempt++ {
		method, body := http.MethodGet, ""
		if data != nil {
			method, body = http.MethodPost, data.Encode()
		}
		req, err := http.NewRequestWithContext(ctx, method, address, strings.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", "Mozilla/5.0")
		req.Header.Set("Referer", lanzouFolder)
		// 分享页的下载链接带 rel=noreferrer，文件节点不沿用分享目录 Referer。
		if strings.HasSuffix(req.URL.Hostname(), ".lanrar.com") || strings.HasSuffix(req.URL.Hostname(), ".webgetstore.com") {
			req.Header.Del("Referer")
		}
		if data != nil {
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		}
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "acw_sc__v2", Value: cookie})
		}
		resp, err := client.Do(req)
		if err != nil {
			return &updateRequestError{requestHost(address, err), err}
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return &updateRequestError{requestHost(address, nil), &httpStatusError{resp.StatusCode}}
		}
		reader := io.Reader(resp.Body)
		if resp.Header.Get("Content-Encoding") == "gzip" {
			gz, gzipErr := gzip.NewReader(reader)
			if gzipErr != nil {
				resp.Body.Close()
				return gzipErr
			}
			defer gz.Close()
			reader = gz
		}
		buffered := bufio.NewReader(reader)
		prefix, _ := buffered.Peek(32)
		if bytes.HasPrefix(prefix, []byte("<html><script>var arg1=")) {
			b, readErr := readBounded(buffered, 64<<10)
			resp.Body.Close()
			if readErr != nil {
				return readErr
			}
			var cookieErr error
			cookie, cookieErr = lanzouCookie(string(b))
			if cookieErr != nil || attempt != 0 {
				return errors.New("蓝奏浏览器校验失败，请稍后重试")
			}
			continue
		}
		err = consume(buffered)
		resp.Body.Close()
		return err
	}
	return errors.New("蓝奏浏览器校验失败")
}

func readBounded(r io.Reader, limit int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err == nil && int64(len(b)) > limit {
		err = errors.New("蓝奏响应超过大小限制")
	}
	return b, err
}
func (c *lanzouClient) text(ctx context.Context, address string, data url.Values) ([]byte, error) {
	var b []byte
	err := c.request(ctx, address, data, func(r io.Reader) (err error) { b, err = readBounded(r, mirrorManifestLimit); return })
	return b, err
}
func (c *lanzouClient) list(ctx context.Context) ([]lanzouFile, error) {
	page, err := c.text(ctx, lanzouFolder, nil)
	if err != nil {
		return nil, err
	}
	form, _, err := literalData(string(page), map[string]string{"pwd": lanzouPassword, "pgs": "1"})
	endpoint := jsURL.FindSubmatch(page)
	if err != nil || endpoint == nil || string(endpoint[1]) != "/filemoreajax.php?file=14123945" || form.Get("fid") != "14123945" {
		return nil, errors.New("SunERP 分享目录接口无效")
	}
	var files []lanzouFile
	for pg := 1; pg <= 20; pg++ {
		form.Set("pg", strconv.Itoa(pg))
		b, err := c.text(ctx, lanzouOrigin+string(endpoint[1]), form)
		if err != nil {
			return nil, err
		}
		var response struct {
			ZT   json.RawMessage `json:"zt"`
			Text json.RawMessage `json:"text"`
		}
		if err := json.Unmarshal(b, &response); err != nil {
			return nil, errors.New("蓝奏目录返回格式无效")
		}
		code := strings.Trim(string(response.ZT), `"`)
		if code == "2" {
			return files, nil
		}
		if code != "1" {
			return nil, errors.New("蓝奏目录暂不可用或提取码无效")
		}
		var batch []lanzouFile
		if err := json.Unmarshal(response.Text, &batch); err != nil {
			return nil, errors.New("蓝奏目录文件列表无效")
		}
		for _, file := range batch {
			if file.Ad == 0 && shareID.MatchString(file.ID) {
				files = append(files, file)
			}
		}
		if len(batch) < 50 {
			return files, nil
		}
	}
	return nil, errors.New("蓝奏目录文件过多，未完成读取")
}

func (c *lanzouClient) latest(ctx context.Context) (mirrorRelease, error) {
	return c.release(ctx, "")
}

func (c *lanzouClient) release(ctx context.Context, version string) (mirrorRelease, error) {
	files, err := c.list(ctx)
	if err != nil {
		return mirrorRelease{}, err
	}
	var candidates []lanzouFile
	for _, f := range files {
		if mirrorName.MatchString(f.Name) && (version == "" || f.Name == "SunERP_v"+version+"_manifest.zip") {
			candidates = append(candidates, f)
		}
	}
	if len(candidates) == 0 {
		return mirrorRelease{}, errors.New("蓝奏目录尚无正式更新清单")
	}
	sort.Slice(candidates, func(i, j int) bool {
		return compareVersion(mirrorName.FindStringSubmatch(candidates[i].Name)[1], mirrorName.FindStringSubmatch(candidates[j].Name)[1]) > 0
	})
	f := candidates[0]
	if len(candidates) > 1 && candidates[1].Name == f.Name {
		return mirrorRelease{}, errors.New("蓝奏正式清单重名，请维护者检查")
	}
	direct, err := c.resolve(ctx, f.ID)
	if err != nil {
		return mirrorRelease{}, err
	}
	b, err := c.readArchive(ctx, direct, mirrorManifestLimit)
	if err != nil {
		return mirrorRelease{}, err
	}
	m, err := readMirrorManifest(b, mirrorName.FindStringSubmatch(f.Name)[1])
	if err != nil {
		return mirrorRelease{}, err
	}
	var id string
	for _, file := range files {
		if file.Name == m.ArchiveName {
			if id != "" {
				return mirrorRelease{}, errors.New("蓝奏更新包重名，请维护者检查")
			}
			id = file.ID
		}
	}
	if id == "" {
		return mirrorRelease{}, errors.New("蓝奏完整包尚未上传")
	}
	return mirrorRelease{m.Manifest, id}, nil
}

func readMirrorManifest(payload []byte, wantVersion string) (mirrorManifest, error) {
	var m mirrorManifest
	z, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil || len(z.File) != 1 || z.File[0].Name != "update-manifest-singlefile.json" || !z.File[0].Mode().IsRegular() || z.File[0].UncompressedSize64 > mirrorManifestLimit {
		return m, errors.New("蓝奏更新清单 ZIP 无效")
	}
	r, err := z.File[0].Open()
	if err != nil {
		return m, err
	}
	defer r.Close()
	b, err := readBounded(r, mirrorManifestLimit)
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return m, errors.New("蓝奏更新清单 JSON 无效")
	}
	if err := m.Validate(); err != nil {
		return m, err
	}
	if m.Version != wantVersion || !mirrorArchiveName.MatchString(m.ArchiveName) {
		return m, errors.New("蓝奏清单版本或完整包名称无效")
	}
	return m, nil
}

func (c *lanzouClient) resolve(ctx context.Context, id string) (string, error) {
	if !shareID.MatchString(id) {
		return "", errors.New("蓝奏文件标识无效")
	}
	page, err := c.text(ctx, lanzouOrigin+"/"+id, nil)
	if err != nil {
		return "", err
	}
	t := html.NewTokenizer(bytes.NewReader(page))
	var frame string
	for {
		tt := t.Next()
		if tt == html.ErrorToken {
			break
		}
		if tt == html.StartTagToken || tt == html.SelfClosingTagToken {
			token := t.Token()
			if token.Data == "iframe" {
				for _, a := range token.Attr {
					if a.Key == "src" && strings.HasPrefix(a.Val, "/fn?") {
						frame = lanzouOrigin + a.Val
					}
				}
			}
		}
	}
	if frame == "" {
		return "", errors.New("蓝奏文件页面格式已变化或需要人工验证")
	}
	page, err = c.text(ctx, frame, nil)
	if err != nil {
		return "", err
	}
	form, vars, err := literalData(string(page), map[string]string{"kdns": "1"})
	if err != nil {
		return "", err
	}
	address := vars["domain1"]
	if address == "" {
		if m := jsURL.FindSubmatch(page); m != nil {
			address = string(m[1])
			if strings.HasPrefix(address, "/ajaxm.php") {
				address = lanzouOrigin + address
			}
		}
	}
	u, _ := url.Parse(address)
	if u == nil || !lanzouURL(address) || (u.Path != "/ajaxfile.php" && u.Path != "/ajaxm.php") || form.Get("action") != "downprocess" {
		return "", errors.New("蓝奏解析接口已变化")
	}
	b, err := c.text(ctx, address, form)
	if err != nil {
		return "", err
	}
	var result struct {
		ZT  json.RawMessage `json:"zt"`
		Dom string          `json:"dom"`
		URL string          `json:"url"`
	}
	if json.Unmarshal(b, &result) != nil || strings.Trim(string(result.ZT), `"`) != "1" || result.URL == "" || strings.ContainsAny(result.URL, "\r\n") {
		return "", errors.New("蓝奏临时下载地址获取失败")
	}
	direct := result.Dom + "/file/" + result.URL
	if !lanzouURL(direct) {
		return "", errors.New("蓝奏返回了未验证的下载节点")
	}
	return direct, nil
}

func (c *lanzouClient) archive(ctx context.Context, address string, consume func(io.Reader) error) error {
	// 最多跟进一次站点普通下载确认。验证码、滑块及未知页面均交给人工处理。
	for attempt := 0; attempt < 2; attempt++ {
		next := ""
		err := c.request(ctx, address, nil, func(r io.Reader) error {
			br := bufio.NewReader(r)
			magic, _ := br.Peek(4)
			if bytes.Equal(magic, []byte("PK\x03\x04")) {
				return consume(br)
			}
			page, err := readBounded(br, 64<<10)
			if err != nil {
				return err
			}
			form, _, err := literalData(string(page), map[string]string{"el": "2"})
			if err != nil || form.Get("file") == "" || form.Get("sign") == "" ||
				!strings.Contains(string(page), "function down_r(el)") || !strings.Contains(string(page), "url : 'ajax.php'") {
				return errors.New("蓝奏返回验证页面或非 ZIP 文件，请手动下载或稍后重试")
			}
			u, _ := url.Parse(address)
			endpoint := u.ResolveReference(&url.URL{Path: "ajax.php"}).String()
			// 页面在 2000ms 后才关闭加载层；立即提交会得到 ?SignError。
			// 遵循普通下载确认的等待时间，取消时不继续发出请求。
			timer := time.NewTimer(2 * time.Second)
			select {
			case <-timer.C:
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			}
			b, err := c.text(ctx, endpoint, form)
			if err != nil {
				return err
			}
			var result struct {
				ZT  json.RawMessage `json:"zt"`
				URL string          `json:"url"`
			}
			if json.Unmarshal(b, &result) != nil || strings.Trim(string(result.ZT), `"`) != "1" {
				return errors.New("蓝奏下载确认失败或需要人工验证")
			}
			if !lanzouURL(result.URL) {
				return errors.New("蓝奏下载确认未返回有效地址，请稍后重试")
			}
			next = result.URL
			return nil
		})
		if err != nil || next == "" {
			return err
		}
		address = next
	}
	return errors.New("蓝奏下载确认次数超过限制")
}
func (c *lanzouClient) readArchive(ctx context.Context, address string, limit int64) ([]byte, error) {
	var b []byte
	err := c.archive(ctx, address, func(r io.Reader) (err error) { b, err = readBounded(r, limit); return })
	return b, err
}
func (c *lanzouClient) download(ctx context.Context, id, target string) (result error) {
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer func() {
		result = errors.Join(result, out.Close())
		if result != nil {
			result = errors.Join(result, os.Remove(target))
		}
	}()
	// 重试重新解析临时地址，避免继续使用已过期直链。
	for attempt := 0; attempt < 2; attempt++ {
		var address string
		address, result = c.resolve(ctx, id)
		if result == nil {
			result = out.Truncate(0)
			if result == nil {
				_, result = out.Seek(0, io.SeekStart)
			}
			if result == nil {
				result = c.archive(ctx, address, func(r io.Reader) error {
					n, err := io.Copy(out, io.LimitReader(r, maxArchive+1))
					if n > maxArchive {
						return errors.New("蓝奏更新包超过大小限制")
					}
					return err
				})
			}
		}
		if result == nil {
			return out.Sync()
		}
		if ctx.Err() != nil || !retryableRequestError(result) {
			return result
		}
	}
	return result
}

// 对已知的普通 JS Cookie 校验做有界字面解析；不运行网页脚本。
func lanzouCookie(page string) (string, error) {
	arg := regexp.MustCompile(`\barg1='([0-9A-Fa-f]{40})'`).FindStringSubmatch(page)
	perm := regexp.MustCompile(`var m=\[([0-9a-fx,]+)\]`).FindStringSubmatch(page)
	if arg == nil || perm == nil {
		return "", errors.New("未知浏览器校验")
	}
	var key []byte
	alphabet := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/"
	encoding := base64.NewEncoding(alphabet)
	for _, token := range regexp.MustCompile(`'([A-Za-z0-9+/=]+)'`).FindAllStringSubmatch(page, -1) {
		s := strings.TrimRight(token[1], "=")
		b, err := encoding.WithPadding(base64.NoPadding).DecodeString(s)
		if err == nil && regexp.MustCompile(`^[0-9a-f]{40}$`).Match(b) {
			key, _ = hex.DecodeString(string(b))
		}
	}
	positions := strings.Split(perm[1], ",")
	if len(positions) != 40 || len(key) != 20 {
		return "", errors.New("浏览器校验参数无效")
	}
	scrambled := make([]byte, 40)
	seen := map[int64]bool{}
	for i, s := range positions {
		n, err := strconv.ParseInt(s, 0, 32)
		if err != nil || n < 1 || n > 40 || seen[n] {
			return "", errors.New("浏览器校验顺序无效")
		}
		seen[n] = true
		scrambled[i] = arg[1][n-1]
	}
	b, err := hex.DecodeString(string(scrambled))
	if err != nil {
		return "", fmt.Errorf("浏览器校验值无效：%w", err)
	}
	for i := range b {
		b[i] ^= key[i]
	}
	return hex.EncodeToString(b), nil
}
