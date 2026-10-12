// Package distribution builds the native Windows release without a Python runtime.
package distribution

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sunyu.local/erp/internal/update"
)

type Options struct{ Version, BackendVersion, LauncherVersion, BinDir, WebDir, Output, Notes string }
type Artifact struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}
type Result struct {
	Output    string     `json:"output"`
	Artifacts []Artifact `json:"artifacts"`
}

const releaseURL = "https://github.com/Vex9th/SunYu_ERP/releases/download/"

// Build copies only the three expected binaries and the supplied frontend build.
// It publishes verified artifacts together, and never merges into an old release.
func Build(o Options) (Result, error) {
	if o.Version == "" || o.BinDir == "" || o.WebDir == "" || o.Output == "" {
		return Result{}, errors.New("version、bin-dir、web-dir 和 output 均为必填项")
	}
	if o.BackendVersion == "" {
		o.BackendVersion = o.Version
	}
	if o.LauncherVersion == "" {
		o.LauncherVersion = o.Version
	}
	m := update.Manifest{Format: 2, Application: update.Application, Version: o.Version, BackendVersion: o.BackendVersion, FrontendVersion: o.Version, LauncherVersion: o.LauncherVersion, APIVersion: 1, Component: "application", Files: map[string]string{}}
	// Validate version/path syntax before constructing any destination paths.
	for _, p := range []string{"SunYu_ERP.exe", "app/SunYuService.exe", "update.exe", "app/web/" + o.Version + "/index.html"} {
		m.Files[p] = strings.Repeat("0", 64)
	}
	if err := m.Validate(); err != nil {
		return Result{}, err
	}
	var err error
	if o.BinDir, err = filepath.EvalSymlinks(o.BinDir); err != nil {
		return Result{}, fmt.Errorf("bin-dir: %w", err)
	}
	if o.WebDir, err = filepath.EvalSymlinks(o.WebDir); err != nil {
		return Result{}, fmt.Errorf("web-dir: %w", err)
	}
	if o.BinDir, err = filepath.Abs(o.BinDir); err != nil {
		return Result{}, err
	}
	if o.WebDir, err = filepath.Abs(o.WebDir); err != nil {
		return Result{}, err
	}
	if o.Output, err = filepath.Abs(o.Output); err != nil {
		return Result{}, err
	}
	if err = emptyOutput(o.Output); err != nil {
		return Result{}, err
	}
	parent, err := resolvedMissingDirectory(filepath.Dir(o.Output))
	if err != nil {
		return Result{}, err
	}
	o.Output = filepath.Join(parent, filepath.Base(o.Output))
	for _, source := range []string{o.BinDir, o.WebDir} {
		if inside(source, o.Output) {
			return Result{}, errors.New("output 不能位于输入目录中")
		}
	}
	bin, err := os.OpenRoot(o.BinDir)
	if err != nil {
		return Result{}, err
	}
	defer bin.Close()
	web, err := os.OpenRoot(o.WebDir)
	if err != nil {
		return Result{}, err
	}
	defer web.Close()
	for _, name := range []string{"SunYu_ERP.exe", "SunYuService.exe", "update.exe"} {
		f, err := openRegular(bin, name)
		if err != nil {
			return Result{}, err
		}
		err = validateAMD64(f)
		_ = f.Close()
		if err != nil {
			return Result{}, fmt.Errorf("%s: %w", name, err)
		}
	}
	webFiles, err := frontendFiles(web)
	if err != nil {
		return Result{}, err
	}
	m.Files = map[string]string{"SunYu_ERP.exe": strings.Repeat("0", 64), "app/SunYuService.exe": strings.Repeat("0", 64), "update.exe": strings.Repeat("0", 64)}
	for _, name := range webFiles {
		m.Files["app/web/"+o.Version+"/"+name] = strings.Repeat("0", 64)
	}
	if err = m.Validate(); err != nil {
		return Result{}, err
	}
	if err = validateFrontend(web, webFiles, o.Version); err != nil {
		return Result{}, err
	}
	if err = os.MkdirAll(parent, 0755); err != nil {
		return Result{}, err
	}
	stage, err := os.MkdirTemp(parent, ".sunyu-package-*")
	if err != nil {
		return Result{}, err
	}
	defer os.RemoveAll(stage) // This path is generated and owned by this build only.
	installation := filepath.Join(stage, update.Application)
	if err = os.MkdirAll(installation, 0755); err != nil {
		return Result{}, err
	}
	for _, name := range []string{"SunYu_ERP.exe", "SunYuService.exe", "update.exe"} {
		target := name
		if name == "SunYuService.exe" {
			target = "app/" + name
		}
		m.Files[target], err = copySnapshot(bin, name, filepath.Join(installation, filepath.FromSlash(target)), 0755)
		if err != nil {
			return Result{}, err
		}
	}
	for _, name := range webFiles {
		target := "app/web/" + o.Version + "/" + name
		m.Files[target], err = copySnapshot(web, name, filepath.Join(installation, filepath.FromSlash(target)), 0644)
		if err != nil {
			return Result{}, err
		}
	}
	if err = m.Validate(); err != nil {
		return Result{}, err
	}
	// Validate the copied snapshot too, so concurrent source changes cannot turn
	// a preflight success into a broken archive.
	snapshot, err := os.OpenRoot(filepath.Join(installation, "app", "web", o.Version))
	if err != nil {
		return Result{}, err
	}
	err = validateFrontend(snapshot, webFiles, o.Version)
	_ = snapshot.Close()
	if err != nil {
		return Result{}, err
	}
	for _, name := range []string{"SunYu_ERP.exe", "app/SunYuService.exe", "update.exe"} {
		f, e := os.Open(filepath.Join(installation, filepath.FromSlash(name)))
		if e != nil {
			return Result{}, e
		}
		e = validateAMD64(f)
		_ = f.Close()
		if e != nil {
			return Result{}, e
		}
	}
	installed := m
	installed.Component = ""
	if err = writeJSON(filepath.Join(installation, "app", "manifest.json"), installed); err != nil {
		return Result{}, err
	}
	// The standalone first-migration download must be byte-for-byte identical to
	// the installed updater, even if the supplied build directory changes later.
	installationRoot, err := os.OpenRoot(installation)
	if err != nil {
		return Result{}, err
	}
	updaterHash, err := copySnapshot(installationRoot, "update.exe", filepath.Join(stage, "update.exe"), 0755)
	_ = installationRoot.Close()
	if err != nil {
		return Result{}, err
	}
	if updaterHash != m.Files["update.exe"] {
		return Result{}, errors.New("独立更新器与程序内更新器不一致")
	}
	applicationName := "SunYu_ERP-application-" + o.Version + ".zip"
	frontendName := "SunYu_ERP-frontend-" + o.Version + ".zip"
	if err = writeUpdateArchive(filepath.Join(stage, applicationName), installation, m); err != nil {
		return Result{}, err
	}
	frontend := m
	frontend.Component = "frontend"
	frontend.Files = map[string]string{}
	for p, h := range m.Files {
		if strings.HasPrefix(p, "app/web/") {
			frontend.Files[p] = h
		}
	}
	if err = writeUpdateArchive(filepath.Join(stage, frontendName), installation, frontend); err != nil {
		return Result{}, err
	}
	if err = writeFullArchive(filepath.Join(stage, "SunYu_ERP-windows-x64.zip"), installation, m); err != nil {
		return Result{}, err
	}
	catalog := update.Catalog{Format: 2, Application: update.Application, Version: o.Version, BackendVersion: o.BackendVersion, FrontendVersion: o.Version, LauncherVersion: o.LauncherVersion, APIVersion: 1, Notes: o.Notes, Packages: map[string]update.Archive{}}
	for component, name := range map[string]string{"application": applicationName, "frontend": frontendName} {
		a, err := artifact(stage, name)
		if err != nil {
			return Result{}, err
		}
		catalog.Packages[component] = update.Archive{URL: releaseURL + "v" + o.Version + "/" + name, SHA256: a.SHA256}
	}
	if err = writeJSON(filepath.Join(stage, "update-manifest-v2.json"), catalog); err != nil {
		return Result{}, err
	}
	if err = writeLegacyCatalog(filepath.Join(stage, "update-manifest.json"), o.Version); err != nil {
		return Result{}, err
	}
	names := []string{"SunYu_ERP-windows-x64.zip", applicationName, frontendName, "update.exe", "update-manifest-v2.json", "update-manifest.json"}
	sort.Strings(names)
	result := Result{Output: o.Output, Artifacts: []Artifact{}}
	var sums strings.Builder
	for _, name := range names {
		a, err := artifact(stage, name)
		if err != nil {
			return Result{}, err
		}
		result.Artifacts = append(result.Artifacts, a)
		fmt.Fprintf(&sums, "%s  %s\n", a.SHA256, a.Name)
	}
	if err = os.WriteFile(filepath.Join(stage, "SHA256SUMS.txt"), []byte(sums.String()), 0644); err != nil {
		return Result{}, err
	}
	if err = emptyOutput(o.Output); err != nil {
		return Result{}, err
	}
	// os.Remove only removes an empty directory, never an existing release.
	if err = os.Remove(o.Output); err != nil && !os.IsNotExist(err) {
		return Result{}, err
	}
	if err = os.Rename(stage, o.Output); err != nil {
		return Result{}, err
	}
	return result, nil
}
