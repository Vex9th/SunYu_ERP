package main

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
)

func zipFixture(t *testing.T, files map[string]string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "package.zip")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	z := zip.NewWriter(f)
	for name, data := range files {
		w, err := z.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(data))
	}
	z.Close()
	f.Close()
	return p
}
func manifestFixture() Manifest {
	return Manifest{Format: 1, Application: "SunYu_ERP", Version: "1.2.5", Archive: Archive{URL: "https://github.com/Vex9th/SunYu_ERP/releases/download/v1.2.5/SunYu_ERP-windows-x64.zip", SHA256: sumBytes([]byte("archive"))}, Files: map[string]string{"SunYu_ERP.exe": sumBytes([]byte("app")), "update.exe": sumBytes([]byte("updater"))}}
}
func TestArchiveRejectsUnexpectedAndProtectedPayload(t *testing.T) {
	for _, bad := range []string{"../outside", "Data/iapm.sqlite", "config.json", "app.dll", "start.ps1", "UPDATE.exe", "foo/SunYu_ERP.exe", "SunYu_ERP.exe:ads"} {
		t.Run(bad, func(t *testing.T) {
			m := manifestFixture()
			p := zipFixture(t, map[string]string{"SunYu_ERP.exe": "app", "update.exe": "updater", bad: "extra"})
			if err := extractPackage(p, t.TempDir(), m); err == nil {
				t.Fatal("unsafe package accepted", bad)
			}
		})
	}
}
func TestArchiveHashFailureDoesNotPublishApplication(t *testing.T) {
	m := manifestFixture()
	p := zipFixture(t, map[string]string{"SunYu_ERP.exe": "corrupt", "update.exe": "updater"})
	stage := t.TempDir()
	if err := extractPackage(p, stage, m); err == nil {
		t.Fatal("hash mismatch accepted")
	}
}
func TestOnlyTwoExecutablesAreStaged(t *testing.T) {
	m := manifestFixture()
	p := zipFixture(t, map[string]string{"SunYu_ERP.exe": "app", "update.exe": "updater", "start.bat": "ignored", "README.md": "ignored", "LICENSE": "ignored", "config.example.json": "ignored"})
	stage := t.TempDir()
	if err := extractPackage(p, stage, m); err != nil {
		t.Fatal(err)
	}
	files, err := os.ReadDir(stage)
	if err != nil || len(files) != 2 {
		t.Fatal(files, err)
	}
}
func TestRejectsForeignManifestAndDowngrade(t *testing.T) {
	m := manifestFixture()
	m.Archive.URL = "https://example.com/app.zip"
	if err := m.Validate(); err == nil {
		t.Fatal("foreign URL accepted")
	}
	if compareVersion("1.2.4", "1.2.5") >= 0 || compareVersion("1.2.5", "1.2.5") != 0 {
		t.Fatal("version comparison permits downgrade")
	}
}
