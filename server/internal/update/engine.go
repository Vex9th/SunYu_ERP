package update

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"sunyu.local/erp/internal/lifecycle"
	"sunyu.local/erp/internal/pathidentity"
)

const DefaultCatalogURL = "https://github.com/Vex9th/SunYu_ERP/releases/latest/download/update-manifest-v2.json"

var ErrBusy = errors.New("正在处理另一个更新任务，请等待完成")
var requestPattern = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)

type Job struct {
	ID        string `json:"id"`
	RequestID string `json:"request_id"`
	Status    string `json:"status"`
	Phase     string `json:"phase"`
	Message   string `json:"message"`
	Error     string `json:"error,omitempty"`
	Version   string `json:"version,omitempty"`
	Component string `json:"component,omitempty"`
	Progress  int    `json:"progress"`
	StartedAt string `json:"started_at"`
	UpdatedAt string `json:"updated_at"`
}
type Engine struct {
	Root       string
	CatalogURL string
	Client     *http.Client
	mu         sync.Mutex
	running    bool
	closed     bool
	ctx        context.Context
	cancel     context.CancelFunc
	workers    sync.WaitGroup
}

func New(root string) (*Engine, error) {
	root, e := filepath.Abs(root)
	if e != nil {
		return nil, e
	}
	if e = os.MkdirAll(root, 0700); e != nil {
		return nil, e
	}
	root, e = pathidentity.ResolveExisting(root)
	if e != nil {
		return nil, e
	}
	for _, p := range []string{"app", ".updates", "config.json"} {
		if _, e = safePath(root, p); e != nil {
			return nil, e
		}
	}
	if e = os.MkdirAll(filepath.Join(root, ".updates"), 0700); e != nil {
		return nil, e
	}
	ctx, cancel := context.WithCancel(context.Background())
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = platformProxy
	engine := &Engine{Root: root, CatalogURL: DefaultCatalogURL, ctx: ctx, cancel: cancel, Client: &http.Client{Transport: transport, Timeout: 10 * time.Minute, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) > 5 {
			return errors.New("下载重定向次数过多")
		}
		return trustedRedirect(r.URL)
	}}}
	engine.recoverInterruptedJob()
	return engine, nil
}
func terminal(s string) bool { return s == "success" || s == "failed" || s == "manual_recovery" }
func readJSON(p string, v any) error {
	b, e := os.ReadFile(p)
	if e != nil {
		return e
	}
	if len(b) > 16<<20 {
		return errors.New("更新状态文件过大")
	}
	return json.Unmarshal(b, v)
}
func (e *Engine) Status() map[string]any {
	var j *Job
	var c *Catalog
	_ = readJSON(filepath.Join(e.Root, ".updates", "job.json"), &j)
	_ = readJSON(filepath.Join(e.Root, ".updates", "catalog-v2.json"), &c)
	m, err := ReadManifest(e.Root)
	var installed any
	if err == nil {
		installed = m
	}
	return map[string]any{"installed": installed, "latest": c, "job": j, "update_available": c != nil && available(m, *c), "restart_required": c != nil && available(m, *c) && (m.BackendVersion != c.BackendVersion || m.LauncherVersion != c.LauncherVersion)}
}
func (e *Engine) saveJob(j *Job) error {
	j.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := writeJSON(filepath.Join(e.Root, ".updates", "job.json"), j); err != nil {
		return err
	}
	if requestPattern.MatchString(j.RequestID) {
		return writeJSON(filepath.Join(e.Root, ".updates", "requests", strings.ToLower(j.RequestID)+".json"), j)
	}
	return nil
}
func (e *Engine) progress(j *Job, phase, message string, p int) error {
	j.Status, j.Phase, j.Message, j.Progress = phase, phase, message, p
	return e.saveJob(j)
}
func (e *Engine) start(id, phase string, fn func(*Job) error) error {
	return e.startPrepared(id, phase, nil, fn)
}
func (e *Engine) startPrepared(id, phase string, prepare func(*Job) error, fn func(*Job) error) error {
	if !requestPattern.MatchString(id) {
		return errors.New("更新请求标识必须为 UUID")
	}
	id = strings.ToLower(id)
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return errors.New("更新服务正在退出")
	}
	var previous Job
	if readJSON(filepath.Join(e.Root, ".updates", "requests", id+".json"), &previous) == nil {
		return nil
	}
	if e.running {
		return ErrBusy
	}
	release, err := lifecycle.Acquire(e.Root, "installer.lock")
	if errors.Is(err, lifecycle.ErrBusy) {
		return ErrBusy
	}
	if err != nil {
		return err
	}
	if _, pending, pendingErr := pendingState(e.Root); pending || pendingErr != nil {
		release()
		return ErrBusy
	}
	random := make([]byte, 12)
	if _, err = rand.Read(random); err != nil {
		release()
		return err
	}
	j := Job{ID: hex.EncodeToString(random), RequestID: id, Status: phase, Phase: phase, Message: "正在处理更新请求", StartedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if prepare != nil {
		if err = prepare(&j); err != nil {
			release()
			return err
		}
	}
	if err = e.saveJob(&j); err != nil {
		release()
		return err
	}
	_ = e.retryCleanup()
	e.pruneRequests()
	_ = e.cleanupWork(j.ID, false)
	e.running = true
	e.workers.Add(1)
	go func() {
		defer e.workers.Done()
		defer func() { release(); e.mu.Lock(); e.running = false; e.mu.Unlock() }()
		err := fn(&j)
		if err != nil {
			j.Status, j.Phase, j.Error, j.Message = "failed", "failed", err.Error(), "更新失败，原有业务数据已保留"
			_ = e.saveJob(&j)
		} else if j.Status != "restarting" {
			j.Status, j.Phase, j.Progress = "success", "success", 100
			if !strings.Contains(j.Message, "暂") && !strings.Contains(j.Message, "检查完成") {
				j.Message = "操作完成"
			}
			_ = e.saveJob(&j)
		}
	}()
	return nil
}
func (e *Engine) Check(id string) error {
	return e.start(id, "checking", func(j *Job) error {
		_, err := e.fetchCatalog()
		if err == nil {
			j.Message = "更新检查完成"
		}
		return err
	})
}
func (e *Engine) Install(id string) error {
	return e.start(id, "checking", func(j *Job) error {
		c, err := e.fetchCatalog()
		if err != nil {
			return err
		}
		m, err := ReadManifest(e.Root)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if m.Format != 2 && c.Format != 2 {
			return errors.New("当前正式发布尚未提供原生程序更新包，请等待正式发布后再运行迁移工具")
		}
		if !available(m, c) {
			return nil
		}
		component := "application"
		if m.BackendVersion == c.BackendVersion && m.LauncherVersion == c.LauncherVersion {
			component = "frontend"
		}
		archive, ok := c.Packages[component]
		if !ok {
			return fmt.Errorf("正式版本尚未提供 %s 更新包", component)
		}
		j.Version, j.Component = c.Version, component
		if err = e.progress(j, "downloading", "正在下载更新包", 10); err != nil {
			return err
		}
		work, err := e.createWork(j.ID)
		if err != nil {
			return err
		}
		p := filepath.Join(work, "download.zip")
		if err = e.download(archive.URL, p, MaxArchiveBytes); err != nil {
			return err
		}
		h, err := hashFile(p)
		if err != nil {
			return err
		}
		if h != archive.SHA256 {
			return errors.New("下载更新包 SHA256 不匹配")
		}
		return e.installArchive(j, p, c, component)
	})
}
func (e *Engine) Import(p, id string) error {
	var owned string
	return e.startPrepared(id, "verifying", func(j *Job) error {
		rel, err := filepath.Rel(e.Root, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if !validPath(rel) || !strings.HasPrefix(rel, ".updates/imports/") {
			return errors.New("导入文件必须位于当前安装的受管上传目录")
		}
		bound, err := os.OpenRoot(e.Root)
		if err != nil {
			return err
		}
		defer bound.Close()
		parts := strings.Split(rel, "/")
		for i := range parts {
			info, err := bound.Lstat(strings.Join(parts[:i+1], "/"))
			if err != nil {
				return err
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return errors.New("导入文件路径包含链接")
			}
		}
		source, err := bound.Open(rel)
		if err != nil {
			return err
		}
		defer source.Close()
		info, err := source.Stat()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() > MaxArchiveBytes {
			return errors.New("导入文件类型或大小无效")
		}
		dir, err := e.createWork(j.ID)
		if err != nil {
			return err
		}
		owned = filepath.Join(dir, "download.zip")
		out, err := os.OpenFile(owned, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		n, err := io.Copy(out, io.LimitReader(source, MaxArchiveBytes+1))
		if err == nil && n > MaxArchiveBytes {
			err = errors.New("更新包超过大小限制")
		}
		if err == nil {
			err = out.Sync()
		}
		ce := out.Close()
		if err == nil {
			err = ce
		}
		if err != nil {
			_ = os.Remove(owned)
		}
		return err
	}, func(j *Job) error {
		var c Catalog
		if readJSON(filepath.Join(e.Root, ".updates", "catalog-v2.json"), &c) != nil || e.validateCatalog(c) != nil {
			var err error
			c, err = e.fetchCatalog()
			if err != nil {
				return fmt.Errorf("无法验证离线包来源，请先联网检查一次更新以取得官方校验清单：%w", err)
			}
		}
		h, err := hashFile(owned)
		if err != nil {
			return err
		}
		component := ""
		for name, a := range c.Packages {
			if a.SHA256 == h {
				component = name
				break
			}
		}
		if component == "" {
			return errors.New("离线包校验值不在已取得的官方更新清单中，请先检查更新")
		}
		return e.installArchive(j, owned, c, component)
	})
}
func (e *Engine) installArchive(j *Job, p string, c Catalog, component string) error {
	j.Version, j.Component = c.Version, component
	if _, _, err := installationPaths(e.Root); err != nil {
		return err
	}
	if err := e.progress(j, "verifying", "正在校验更新包和文件", 30); err != nil {
		return err
	}
	stage := filepath.Join(e.Root, ".updates", "work", j.ID, "stage")
	m, err := ExtractPackage(p, stage)
	if err != nil {
		return err
	}
	if m.Component != component || m.Version != c.Version || m.BackendVersion != c.BackendVersion || m.FrontendVersion != c.FrontendVersion || m.LauncherVersion != c.LauncherVersion {
		return errors.New("更新包身份与官方清单不一致")
	}
	old, err := ReadManifest(e.Root)
	if err == nil && !available(old, c) {
		return errors.New("该更新包不是比当前安装更新的版本")
	}
	if component == "frontend" {
		if old.BackendVersion != m.BackendVersion || old.LauncherVersion != m.LauncherVersion {
			return errors.New("前端包要求先安装对应的程序更新")
		}
		err = e.installFrontend(j, m, stage)
		if err == nil {
			_ = os.RemoveAll(filepath.Join(e.Root, ".updates", "work", j.ID))
		}
		return err
	}
	return e.launchHelper(j, m, stage)
}
func officialURL(u *url.URL) bool {
	return u.Scheme == "https" && u.User == nil && u.Port() == "" && strings.EqualFold(u.Hostname(), "github.com") && strings.HasPrefix(u.Path, "/Vex9th/SunYu_ERP/releases/") && u.Fragment == ""
}
func trustedRedirect(u *url.URL) error {
	if officialURL(u) {
		return nil
	}
	if u.Scheme == "https" && u.User == nil && u.Port() == "" && (u.Hostname() == "release-assets.githubusercontent.com" || u.Hostname() == "objects.githubusercontent.com") {
		return nil
	}
	return errors.New("更新下载重定向到非官方地址")
}
func (e *Engine) validateCatalog(c Catalog) error {
	if c.Format != 2 || c.Application != Application || c.APIVersion != 1 {
		return errors.New("正式版本尚未提供兼容的原生更新清单")
	}
	for _, v := range []string{c.Version, c.BackendVersion, c.FrontendVersion, c.LauncherVersion} {
		if !validVersion(v) {
			return errors.New("更新版本无效")
		}
	}
	if len(c.Packages) == 0 {
		return errors.New("官方清单没有更新包")
	}
	for name, a := range c.Packages {
		if name != "application" && name != "frontend" {
			return errors.New("官方清单含未知组件")
		}
		u, err := url.Parse(a.URL)
		if err != nil || !officialURL(u) || !hashPattern.MatchString(a.SHA256) {
			return errors.New("官方更新包地址或校验值无效")
		}
	}
	return nil
}
func (e *Engine) fetchCatalog() (Catalog, error) {
	var c Catalog
	request, err := http.NewRequestWithContext(e.ctx, "GET", e.CatalogURL, nil)
	if err != nil {
		return c, err
	}
	request.Header.Set("User-Agent", "SunYu-ERP-Updater/2")
	request.Header.Set("Cache-Control", "no-cache")
	response, err := e.Client.Do(request)
	if err != nil {
		return c, err
	}
	if response.StatusCode == 404 && e.CatalogURL == DefaultCatalogURL {
		response.Body.Close()
		legacyRequest, requestErr := http.NewRequestWithContext(e.ctx, "GET", strings.Replace(DefaultCatalogURL, "update-manifest-v2.json", "update-manifest.json", 1), nil)
		if requestErr != nil {
			return c, requestErr
		}
		legacyRequest.Header.Set("User-Agent", "SunYu-ERP-Updater/2")
		response, err = e.Client.Do(legacyRequest)
		if err != nil {
			return c, err
		}
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return c, fmt.Errorf("获取官方更新清单失败（HTTP %d），请检查网络或稍后重试", response.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(response.Body, 2<<20+1))
	if err != nil {
		return c, err
	}
	if len(b) > 2<<20 {
		return c, errors.New("更新清单过大")
	}
	if err = json.Unmarshal(b, &c); err != nil {
		return c, err
	}
	if c.Format == 1 {
		var old struct {
			Components map[string]struct {
				Version string `json:"version"`
			} `json:"components"`
		}
		if json.Unmarshal(b, &old) != nil || !validVersion(c.Version) || !validVersion(old.Components["backend"].Version) || !validVersion(old.Components["frontend"].Version) {
			return c, errors.New("旧版更新清单无效")
		}
		c.Application = Application
		c.BackendVersion = old.Components["backend"].Version
		c.FrontendVersion = old.Components["frontend"].Version
		c.Packages = map[string]Archive{}
	} else if err = e.validateCatalog(c); err != nil {
		return c, err
	}
	if err = writeJSON(filepath.Join(e.Root, ".updates", "catalog-v2.json"), c); err != nil {
		return c, err
	}
	return c, nil
}
func (e *Engine) download(address, target string, max int64) error {
	u, err := url.Parse(address)
	if err != nil || !officialURL(u) {
		return errors.New("更新包地址不是官方发布地址")
	}
	req, err := http.NewRequestWithContext(e.ctx, "GET", address, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "SunYu-ERP-Updater/2")
	resp, err := e.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("更新包下载失败（HTTP %d）", resp.StatusCode)
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, io.LimitReader(resp.Body, max+1))
	if err == nil && n > max {
		err = errors.New("更新包超过大小限制")
	}
	if err == nil {
		err = f.Sync()
	}
	ce := f.Close()
	if err == nil {
		err = ce
	}
	return err
}
func available(m Manifest, c Catalog) bool {
	return c.Format == 2 && compareVersion(c.Version, m.Version) > 0 && compareVersion(c.BackendVersion, m.BackendVersion) >= 0 && compareVersion(c.FrontendVersion, m.FrontendVersion) >= 0 && compareVersion(c.LauncherVersion, m.LauncherVersion) >= 0
}

func (e *Engine) Close() { e.mu.Lock(); e.closed = true; e.cancel(); e.mu.Unlock(); e.workers.Wait() }
func (e *Engine) recoverInterruptedJob() {
	var j Job
	if readJSON(filepath.Join(e.Root, ".updates", "job.json"), &j) != nil || terminal(j.Status) {
		return
	}
	if _, pending := Pending(e.Root); pending {
		return
	}
	release, err := lifecycle.Acquire(e.Root, "installer.lock")
	if err != nil {
		return
	}
	defer release()
	j.Status, j.Phase, j.Error, j.Message = "failed", "failed", "上次更新任务意外中断", "上次任务已中断，可重新尝试更新"
	_ = e.saveJob(&j)
}

// Request returns the durable result for a repeated client request.
func (e *Engine) Request(id string) (*Job, error) {
	if !requestPattern.MatchString(id) {
		return nil, errors.New("更新请求标识无效")
	}
	var j Job
	err := readJSON(filepath.Join(e.Root, ".updates", "requests", strings.ToLower(id)+".json"), &j)
	return &j, err
}

func (e *Engine) RequestStatus(id string) (map[string]any, error) {
	j, err := e.Request(id)
	if err != nil {
		return nil, err
	}
	b, err := json.Marshal(j)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	err = json.Unmarshal(b, &out)
	return out, err
}
