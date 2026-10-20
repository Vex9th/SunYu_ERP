package main

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sunyu.local/updater/internal/pathidentity"
	"time"
)

const latestURL = "https://api.github.com/repos/Vex9th/SunYu_ERP/releases/latest"

var jobPattern = regexp.MustCompile(`^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$`)

type Status struct {
	JobID           string `json:"job_id"`
	Phase           string `json:"phase"`
	Message         string `json:"message"`
	Progress        int    `json:"progress"`
	CurrentVersion  string `json:"current_version"`
	LatestVersion   string `json:"latest_version"`
	UpdateAvailable bool   `json:"update_available"`
	Busy            bool   `json:"busy"`
	Error           string `json:"error"`
	CheckedAt       string `json:"checked_at"`
}
type Runtime struct {
	PID        int    `json:"pid"`
	Executable string `json:"executable"`
	Version    string `json:"version"`
	Port       int    `json:"port"`
	Instance   string `json:"instance_id"`
}
type Installer struct {
	JobID      string `json:"job_id"`
	Phase      string `json:"phase"`
	OldVersion string `json:"old_version"`
	NewVersion string `json:"new_version"`
}
type services interface {
	stop() error
	start(string) error
}
type Engine struct {
	apply               bool
	root, work, current string
	status              Status
	client              *http.Client
	services            services
	mirror              updateMirror
}

func newEngine(root, id string) (*Engine, error) {
	if !jobPattern.MatchString(id) {
		return nil, errors.New("任务标识必须是UUID")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(abs, 0700); err != nil {
		return nil, err
	}
	root, err = pathidentity.ResolveExisting(abs)
	if err != nil {
		return nil, err
	}
	for _, p := range []string{".updates", ".updates/work", ".updates/backup", ".updates/logs", ".updates/status.json", ".updates/transaction.json", ".updates/install.json", "config.json", "SunYu_ERP.exe", "update.exe"} {
		if err = noLinks(filepath.Join(root, p)); err != nil {
			return nil, err
		}
	}
	if err = os.MkdirAll(filepath.Join(root, ".updates"), 0700); err != nil {
		return nil, err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = platformProxy
	transport.TLSHandshakeTimeout = 30 * time.Second
	transport.ResponseHeaderTimeout = 30 * time.Second
	e := &Engine{root: root, work: filepath.Join(root, ".updates/work", id), status: Status{JobID: id}, client: &http.Client{Transport: transport, Timeout: 15 * time.Minute, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) > 5 {
			return errors.New("下载重定向过多")
		}
		if trustedURL(r.URL) {
			return nil
		}
		return errors.New("下载重定向到非官方地址")
	}}}
	e.services = &localServices{root: root, job: id}
	e.current = e.installedVersion()
	return e, nil
}
func trustedURL(u *url.URL) bool {
	return u.Scheme == "https" && u.User == nil && u.Port() == "" && (officialURL(u.String()) || u.Host == "release-assets.githubusercontent.com" || u.Host == "objects.githubusercontent.com" || u.String() == latestURL)
}
func (e *Engine) installedVersion() string {
	var runtime Runtime
	if readJSON(filepath.Join(e.root, ".updates/runtime.json"), &runtime) == nil && validVersion(runtime.Version) && processMatches(filepath.Join(e.root, "SunYu_ERP.exe"), runtime.PID) {
		return runtime.Version
	}
	var installed struct {
		Version string `json:"version"`
		SHA256  string `json:"sha256"`
	}
	if readJSON(filepath.Join(e.root, ".updates/installed.json"), &installed) == nil && validVersion(installed.Version) {
		h, err := hashFile(filepath.Join(e.root, "SunYu_ERP.exe"))
		if err == nil && h == installed.SHA256 {
			return installed.Version
		}
	}
	if h, err := hashFile(filepath.Join(e.root, "SunYu_ERP.exe")); err == nil && h == "cba4962dbbf3a3ddf2d69ad116bb0d4eb403c1224368b062cdc0bd0585de7fbe" {
		return "1.2.4"
	}
	return ""
}
func (e *Engine) ensureVersion(apply bool) error {
	if validVersion(e.current) {
		return nil
	}
	if !apply {
		return errors.New("尚未确认现有程序版本，请先启动本目录主程序后检查更新")
	}
	detector, ok := e.services.(interface{ detect() (string, error) })
	if !ok {
		return errors.New("无法确定原程序版本，未开始更新")
	}
	if err := e.progress("checking", "正在启动原程序以确认真实版本", 0); err != nil {
		return err
	}
	v, err := detector.detect()
	if err != nil {
		return fmt.Errorf("无法确认原程序版本，未替换文件：%w", err)
	}
	if !validVersion(v) {
		return errors.New("原程序未提供有效版本")
	}
	e.current = v
	return nil
}

func (e *Engine) progress(phase, message string, n int) error {
	e.status.Phase, e.status.Message, e.status.Progress = phase, message, n
	e.status.CurrentVersion = e.current
	e.status.Busy = phase != "idle" && phase != "available" && phase != "success" && phase != "failed"
	fmt.Println(message)
	err := writeJSON(filepath.Join(e.root, ".updates/status.json"), e.status)
	if e.apply && (phase == "success" || phase == "failed") {
		err = errors.Join(err, writeJSON(filepath.Join(e.root, ".updates/last-install.json"), e.status))
	}
	return err
}
func (e *Engine) run(apply bool) (result error) {
	e.apply = apply
	defer func() {
		if result != nil {
			e.status.Error = result.Error()
			if err := e.progress("failed", result.Error(), e.status.Progress); err != nil {
				fmt.Fprintf(os.Stderr, "状态保存失败：%v；原错误：%v\n", err, result)
			}
		}
	}()
	if apply {
		if handled, err := e.recoverPending(); handled || err != nil {
			return err
		}
	}
	if err := e.ensureVersion(apply); err != nil {
		return err
	}
	var previous Transaction
	keep := ""
	if readJSON(filepath.Join(e.root, ".updates/transaction.json"), &previous) == nil {
		keep = previous.JobID
	}
	if err := e.cleanup(keep); err != nil {
		fmt.Fprintln(os.Stderr, "旧缓存清理暂未完成：", err)
	}
	if err := e.progress("checking", "正在检查官方正式版本", 0); err != nil {
		return err
	}
	latest, manifest, mirrorID, err := e.latestRelease()
	if err != nil {
		return err
	}
	e.status.LatestVersion = latest
	e.status.CheckedAt = time.Now().UTC().Format(time.RFC3339Nano)
	e.status.UpdateAvailable = compareVersion(latest, e.current) > 0
	if !e.status.UpdateAvailable {
		phase := "idle"
		if apply {
			phase = "success"
		}
		return e.progress(phase, "当前没有可安装的新版本", 100)
	}
	if err := manifest.Validate(); err != nil {
		return err
	}
	if manifest.Version != latest {
		return errors.New("更新清单版本与正式发布不一致")
	}
	identical := true
	for name, want := range manifest.Files {
		got, err := hashFile(filepath.Join(e.root, name))
		if err != nil || got != want {
			identical = false
			break
		}
	}
	if identical {
		e.current = manifest.Version
		e.status.UpdateAvailable = false
		phase := "idle"
		if apply {
			phase = "success"
		}
		return e.progress(phase, "当前没有可安装的新版本", 100)
	}
	if !apply {
		return e.progress("available", "发现新版本，可选择一键更新", 100)
	}
	if err := os.MkdirAll(e.work, 0700); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(e.work, "owner.json"), map[string]string{"job_id": e.status.JobID, "application": "SunYu_ERP"}); err != nil {
		return err
	}
	if err := e.progress("downloading", "正在下载并校验更新；当前服务继续运行", 10); err != nil {
		return err
	}
	archive := filepath.Join(e.work, "package.zip")
	if err := e.downloadRelease(manifest, mirrorID, archive); err != nil {
		return fmt.Errorf("下载更新包失败：%w", err)
	}
	h, err := hashFile(archive)
	if err != nil {
		return err
	}
	if h != manifest.Archive.SHA256 {
		return errors.New("更新包SHA256校验失败，当前程序未停止")
	}
	stage := filepath.Join(e.work, "stage")
	if err = extractPackage(archive, stage, manifest); err != nil {
		return err
	}
	return e.install(manifest, stage)
}
