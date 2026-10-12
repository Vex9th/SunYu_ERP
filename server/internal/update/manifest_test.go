package update

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func digest(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func testManifest(version, component string) Manifest {
	return Manifest{Format: 2, Application: "SunYu_ERP", Version: version, BackendVersion: "2.0.0", FrontendVersion: version, LauncherVersion: "2.0.0", APIVersion: 1, Component: component, Files: map[string]string{"app/web/" + version + "/index.html": digest("new")}}
}
func testArchive(t *testing.T, m Manifest, data map[string]string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "package.zip")
	f, e := os.Create(p)
	if e != nil {
		t.Fatal(e)
	}
	z := zip.NewWriter(f)
	b, _ := json.Marshal(m)
	w, _ := z.Create("manifest.json")
	w.Write(b)
	for p, s := range data {
		w, e = z.Create("payload/" + p)
		if e != nil {
			t.Fatal(e)
		}
		w.Write([]byte(s))
	}
	if e = z.Close(); e != nil {
		t.Fatal(e)
	}
	f.Close()
	return p
}
func TestPackageRejectsProtectedPathsAndWindowsAliases(t *testing.T) {
	for _, p := range []string{"Data/iapm.sqlite", "config.json", "../escape", "app/web/2.0.1/../old", "app/web/2.0.1/CON", "app/web/2.0.1/a.", "app/web/2.0.1/a:ads", "app/web/2.0.1/a\\b", "app/manifest.json", ".updates/job.json"} {
		t.Run(p, func(t *testing.T) {
			m := testManifest("2.0.1", "frontend")
			m.Files[p] = digest("bad")
			if e := m.Validate(); e == nil {
				t.Fatal("unsafe managed path accepted")
			}
		})
	}
}
func TestPackageVerifiesBytesAndRejectsExtraPayload(t *testing.T) {
	m := testManifest("2.0.1", "frontend")
	for _, contents := range []map[string]string{{"app/web/2.0.1/index.html": "tampered"}, {"app/web/2.0.1/index.html": "new", "app/web/2.0.1/unlisted": "extra"}} {
		p := testArchive(t, m, contents)
		if _, e := ExtractPackage(p, t.TempDir()); e == nil {
			t.Fatal("untrusted payload accepted")
		}
	}
	p := testArchive(t, m, map[string]string{"app/web/2.0.1/index.html": "new"})
	if _, e := ExtractPackage(p, t.TempDir()); e != nil {
		t.Fatal(e)
	}
}
func TestPackageRejectsSymlinkDestination(t *testing.T) {
	dest := t.TempDir()
	outside := t.TempDir()
	if e := os.Symlink(outside, filepath.Join(dest, "app")); e != nil {
		t.Skip(e)
	}
	m := testManifest("2.0.1", "frontend")
	p := testArchive(t, m, map[string]string{"app/web/2.0.1/index.html": "new"})
	if _, e := ExtractPackage(p, dest); e == nil {
		t.Fatal("followed extraction symlink")
	}
	entries, _ := os.ReadDir(outside)
	if len(entries) != 0 {
		t.Fatal("wrote outside stage")
	}
}
