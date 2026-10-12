package api

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/google/uuid"
)

type UpdateEngine interface {
	Status() map[string]any
	Check(string) error
	Install(string) error
	Import(string, string) error
	RequestStatus(string) (map[string]any, error)
}
type updatePreferences struct {
	AutoCheck      bool    `json:"auto_check"`
	IgnoredVersion *string `json:"ignored_version"`
}
type updatesAPI struct {
	s  *Server
	mu sync.Mutex
}

func updateInstallBlock(s *Server, r *http.Request) string {
	if s.Updates == nil {
		return "unsupported_runtime"
	}
	if !s.Supervised {
		return "not_supervised"
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return "client_unavailable"
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return "non_loopback_peer"
	}
	host = r.Host
	if strings.Contains(host, ":") {
		host, _, err = net.SplitHostPort(host)
		if err != nil {
			return "non_loopback_host"
		}
	}
	ip = net.ParseIP(host)
	if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return "non_loopback_host"
	}
	return ""
}
func requestOrigin(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errors.New("invalid origin")
	}
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return u.Scheme + "://" + net.JoinHostPort(strings.ToLower(u.Hostname()), port), nil
}
func updateSameOrigin(r *http.Request) error {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	expected, err := requestOrigin(scheme + "://" + r.Host)
	origins := r.Header.Values("Origin")
	if err != nil || len(origins) != 1 {
		return E(403, "更新操作只接受同源请求。", "")
	}
	actual, err := requestOrigin(origins[0])
	site := r.Header.Get("Sec-Fetch-Site")
	if err != nil || expected != actual || (site != "" && site != "same-origin" && site != "none") {
		return E(403, "更新操作只接受同源请求。", "")
	}
	return nil
}
func (u *updatesAPI) authorize(c *Context, local bool) error {
	if u.s.Updates == nil {
		return E(409, "当前运行方式不支持更新，请使用完整安装包。", "")
	}
	if e := updateSameOrigin(c.R); e != nil {
		return e
	}
	if local && updateInstallBlock(u.s, c.R) != "" {
		return E(403, "请在运行服务的本机，通过 SunYu_ERP.exe 启动并使用 127.0.0.1 访问后更新。", "")
	}
	return nil
}
func (u *updatesAPI) directory() (*os.Root, error) {
	installation, e := os.OpenRoot(u.s.Root)
	if e != nil {
		return nil, e
	}
	defer installation.Close()
	if e = installation.Mkdir(".updates", 0700); e != nil && !os.IsExist(e) {
		return nil, e
	}
	info, e := installation.Lstat(".updates")
	if e != nil {
		return nil, e
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("更新目录不能是符号链接")
	}
	return installation.OpenRoot(".updates")
}
func (u *updatesAPI) preferences() (updatePreferences, error) {
	p := updatePreferences{AutoCheck: true}
	if u.s.Root == "" {
		return p, nil
	}
	root, e := u.directory()
	if e != nil {
		return p, e
	}
	defer root.Close()
	f, e := root.Open("preferences.json")
	if os.IsNotExist(e) {
		return p, nil
	}
	if e != nil {
		return p, e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, (64<<10)+1))
	if e != nil {
		return p, e
	}
	if len(b) > 64<<10 || !json.Valid(b) {
		return p, errors.New("更新偏好文件无效")
	}
	e = json.Unmarshal(b, &p)
	return p, e
}
func (u *updatesAPI) savePreferences(p updatePreferences) error {
	root, e := u.directory()
	if e != nil {
		return e
	}
	defer root.Close()
	b, e := json.MarshalIndent(p, "", "  ")
	if e != nil {
		return e
	}
	name := ".preferences-" + rand.Text() + ".json"
	f, e := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer root.Remove(name)
	_, e = f.Write(append(b, '\n'))
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		return e
	}
	return root.Rename(name, "preferences.json")
}
func (u *updatesAPI) snapshot(c *Context) (any, error) {
	u.mu.Lock()
	prefs, err := u.preferences()
	u.mu.Unlock()
	if err != nil {
		return nil, err
	}
	reason := updateInstallBlock(u.s, c.R)
	var reasonValue any
	if reason != "" {
		reasonValue = reason
	}
	result := Row{"supported": u.s.Updates != nil, "can_install": reason == "", "install_block_reason": reasonValue, "current": Row{"backend": nil, "frontend": nil, "application": nil}, "frontend_version": nil, "latest": nil, "preferences": prefs, "job": nil}
	if u.s.Updates == nil {
		return result, nil
	}
	// Round-trip only the engine's small public state to normalize typed structs.
	raw, err := json.Marshal(u.s.Updates.Status())
	if err != nil {
		return nil, err
	}
	var state Row
	if err = json.Unmarshal(raw, &state); err != nil {
		return nil, err
	}
	installed, _ := state["installed"].(map[string]any)
	result["current"] = Row{"backend": installed["backend_version"], "frontend": installed["frontend_version"], "application": installed["version"]}
	result["frontend_version"] = installed["frontend_version"]
	result["job"] = state["job"]
	if requestID := c.R.URL.Query().Get("request_id"); requestID != "" {
		id, parseErr := uuid.Parse(requestID)
		if parseErr != nil || id.String() != requestID {
			return nil, E(422, "更新请求标识无效。", "")
		}
		requested, requestErr := u.s.Updates.RequestStatus(requestID)
		if requestErr != nil && !os.IsNotExist(requestErr) {
			return nil, requestErr
		}
		result["requested_job"] = requested
	}
	if latest, ok := state["latest"].(map[string]any); ok {
		components := Row{}
		packages, _ := latest["packages"].(map[string]any)
		for name, payload := range packages {
			p, ok := payload.(map[string]any)
			if !ok {
				continue
			}
			v := latest["version"]
			if name == "frontend" {
				v = latest["frontend_version"]
			}
			components[name] = Row{"version": v, "url": p["url"], "sha256": p["sha256"]}
		}
		result["latest"] = Row{"version": latest["version"], "notes": latest["notes"], "components": components}
	}
	return result, nil
}
func updateRequestID(r *http.Request) (string, error) {
	values := r.Header.Values("X-Update-Request-ID")
	if len(values) != 1 {
		return "", E(422, "更新请求缺少唯一标识，请刷新页面后重试。", "")
	}
	id, e := uuid.Parse(values[0])
	if e != nil || id.String() != values[0] {
		return "", E(422, "更新请求标识无效。", "")
	}
	return id.String(), nil
}
func RegisterUpdates(s *Server) {
	u := &updatesAPI{s: s}
	s.Handle("GET /api/system/updates", u.snapshot)
	for _, action := range []string{"check", "update"} {
		s.Handle("POST /api/system/updates/"+action, func(c *Context) (any, error) {
			if e := u.authorize(c, action != "check"); e != nil {
				return nil, e
			}
			id, e := updateRequestID(c.R)
			if e != nil {
				return nil, e
			}
			if action == "check" {
				e = s.Updates.Check(id)
			} else {
				e = s.Updates.Install(id)
			}
			if e != nil {
				return nil, E(409, e.Error(), "")
			}
			c.Status = 202
			return u.snapshot(c)
		})
	}
	s.Handle("PATCH /api/system/updates/preferences", func(c *Context) (any, error) {
		if e := u.authorize(c, true); e != nil {
			return nil, e
		}
		body, e := c.Body()
		if e != nil {
			return nil, e
		}
		if len(body) == 0 {
			return nil, E(422, "请选择需要更改的更新偏好。", "")
		}
		u.mu.Lock()
		p, e := u.preferences()
		if e == nil {
			for key, value := range body {
				switch key {
				case "auto_check":
					v, ok := value.(bool)
					if !ok {
						e = E(422, "auto_check 必须是布尔值。", "")
					} else {
						p.AutoCheck = v
					}
				case "ignored_version":
					if value == nil {
						p.IgnoredVersion = nil
					} else {
						v, ok := value.(string)
						if !ok || v == "" || len(v) > 100 {
							e = E(422, "忽略的版本号无效。", "")
						} else {
							p.IgnoredVersion = &v
						}
					}
				default:
					e = E(422, "更新偏好包含未知字段。", "")
				}
				if e != nil {
					break
				}
			}
		}
		if e == nil {
			e = u.savePreferences(p)
		}
		u.mu.Unlock()
		if e != nil {
			return nil, e
		}
		return u.snapshot(c)
	})
	s.Handle("POST /api/system/updates/import", func(c *Context) (any, error) {
		if e := u.authorize(c, true); e != nil {
			return nil, e
		}
		id, e := updateRequestID(c.R)
		if e != nil {
			return nil, e
		}
		const limit = 512 << 20
		c.R.Body = http.MaxBytesReader(c.W, c.R.Body, limit+(1<<20))
		reader, e := c.R.MultipartReader()
		if e != nil {
			return nil, E(422, "请选择一个 ZIP 更新包。", "")
		}
		part, e := reader.NextPart()
		if e != nil {
			return nil, E(422, "请选择一个 ZIP 更新包。", "")
		}
		defer part.Close()
		if part.FormName() != "file" || !strings.EqualFold(filepath.Ext(part.FileName()), ".zip") {
			return nil, E(422, "请选择一个 ZIP 更新包。", "")
		}
		updates, e := u.directory()
		if e != nil {
			return nil, e
		}
		defer updates.Close()
		if e = updates.Mkdir("imports", 0700); e != nil && !os.IsExist(e) {
			return nil, e
		}
		info, e := updates.Lstat("imports")
		if e != nil {
			return nil, e
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("更新导入目录不能是符号链接")
		}
		imports, e := updates.OpenRoot("imports")
		if e != nil {
			return nil, e
		}
		defer imports.Close()
		filename := "import-" + rand.Text() + ".zip"
		file, e := imports.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return nil, e
		}
		owned, e := file.Stat()
		if e != nil {
			file.Close()
			return nil, e
		}
		defer func() {
			file.Close()
			actual, e := imports.Lstat(filename)
			if e == nil && os.SameFile(owned, actual) {
				_ = imports.Remove(filename)
			}
		}()
		n, e := io.Copy(file, io.LimitReader(part, limit+1))
		if e != nil || n > limit {
			return nil, E(413, "更新包超过大小限制或上传中断。", "")
		}
		if e = file.Sync(); e != nil {
			return nil, e
		}
		if e = file.Close(); e != nil {
			return nil, e
		}
		if _, e = reader.NextPart(); e != io.EOF {
			return nil, E(422, "每次只能选择一个 ZIP 更新包。", "")
		}
		if e = s.Updates.Import(filepath.Join(s.Root, ".updates", "imports", filename), id); e != nil {
			return nil, E(409, e.Error(), "")
		}
		c.Status = 202
		return u.snapshot(c)
	})
}
