package distribution

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"debug/pe"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"sunyu.local/erp/internal/update"
)

func fixturePE(machine uint16) []byte {
	b := new(bytes.Buffer)
	dos := make([]byte, 128)
	copy(dos, "MZ")
	binary.LittleEndian.PutUint32(dos[0x3c:], 128)
	b.Write(dos)
	b.WriteString("PE\x00\x00")
	_ = binary.Write(b, binary.LittleEndian, pe.FileHeader{Machine: machine, NumberOfSections: 1, SizeOfOptionalHeader: 240, Characteristics: 0x22})
	_ = binary.Write(b, binary.LittleEndian, pe.OptionalHeader64{Magic: 0x20b, AddressOfEntryPoint: 4096, ImageBase: 0x140000000, SectionAlignment: 4096, FileAlignment: 512, SizeOfImage: 8192, SizeOfHeaders: 512, Subsystem: 2, NumberOfRvaAndSizes: 16})
	section := make([]byte, 40)
	copy(section, ".text")
	binary.LittleEndian.PutUint32(section[8:], 1)
	binary.LittleEndian.PutUint32(section[12:], 4096)
	binary.LittleEndian.PutUint32(section[16:], 512)
	binary.LittleEndian.PutUint32(section[20:], 512)
	binary.LittleEndian.PutUint32(section[36:], 0x60000020)
	b.Write(section)
	for b.Len() < 1024 {
		b.WriteByte(0)
	}
	out := b.Bytes()
	out[512] = 0xc3
	return out
}
func fixture(t *testing.T) Options {
	t.Helper()
	root := t.TempDir()
	o := Options{Version: "2.0.1", BinDir: filepath.Join(root, "bin"), WebDir: filepath.Join(root, "web"), Output: filepath.Join(root, "release"), Notes: "原生 Go 正式版本"}
	if err := os.MkdirAll(o.BinDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(o.WebDir, "assets"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"SunYu_ERP.exe", "SunYuService.exe", "update.exe"} {
		if err := os.WriteFile(filepath.Join(o.BinDir, name), fixturePE(pe.IMAGE_FILE_MACHINE_AMD64), 0700); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{"index.html": `<!doctype html><script type="module" src="/__frontend/2.0.1/assets/main.js"></script><link rel="stylesheet" href="/__frontend/2.0.1/assets/main.css">`, "assets/main.js": "console.log('native')", "assets/main.css": "body{color:#111}"}
	for p, data := range files {
		if err := os.WriteFile(filepath.Join(o.WebDir, filepath.FromSlash(p)), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return o
}
func fileHash(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func TestBuildGeneratesVerifiedNativeRelease(t *testing.T) {
	o := fixture(t)
	_ = os.WriteFile(filepath.Join(o.BinDir, "python313.dll"), []byte("legacy"), 0600)
	_ = os.WriteFile(filepath.Join(o.BinDir, "config.json"), []byte("private"), 0600)
	result, err := Build(o)
	if err != nil {
		t.Fatal(err)
	}
	resolvedOutput, err := filepath.EvalSymlinks(o.Output)
	if err != nil {
		t.Fatal(err)
	}
	if result.Output != resolvedOutput || len(result.Artifacts) != 6 {
		t.Fatalf("wrong result: %#v", result)
	}
	installation := filepath.Join(o.Output, "SunYu_ERP")
	m, err := update.ReadManifest(installation)
	if err != nil {
		t.Fatal(err)
	}
	if m.Version != o.Version || m.Component != "" || len(m.Files) != 6 {
		t.Fatalf("wrong installed manifest: %#v", m)
	}
	for _, p := range []string{"SunYu_ERP.exe", "app/SunYuService.exe", "update.exe", "app/web/2.0.1/index.html", "app/web/2.0.1/assets/main.js", "app/web/2.0.1/assets/main.css"} {
		if _, ok := m.Files[p]; !ok {
			t.Fatalf("installed manifest missing %s", p)
		}
	}
	for p, h := range m.Files {
		if fileHash(t, filepath.Join(installation, filepath.FromSlash(p))) != h {
			t.Fatalf("installed hash mismatch: %s", p)
		}
	}
	for _, p := range []string{"Data", "config.json", "python313.dll", "SunYu_ERP_Upgrade.exe"} {
		if _, err := os.Stat(filepath.Join(installation, p)); !os.IsNotExist(err) {
			t.Fatalf("unexpected install member: %s %v", p, err)
		}
	}
	for _, component := range []string{"application", "frontend"} {
		archive := filepath.Join(o.Output, "SunYu_ERP-"+component+"-"+o.Version+".zip")
		extracted, err := update.ExtractPackage(archive, t.TempDir())
		if err != nil {
			t.Fatalf("%s package cannot install: %v", component, err)
		}
		if extracted.Component != component {
			t.Fatal(extracted.Component)
		}
		if component == "application" && extracted.Files["update.exe"] != m.Files["update.exe"] {
			t.Fatal("application package does not include the installed updater")
		}
		for p := range extracted.Files {
			if component == "frontend" && !strings.HasPrefix(p, "app/web/2.0.1/") {
				t.Fatalf("unexpected frontend payload: %s", p)
			}
		}
	}
	full, err := zip.OpenReader(filepath.Join(o.Output, "SunYu_ERP-windows-x64.zip"))
	if err != nil {
		t.Fatal(err)
	}
	defer full.Close()
	if len(full.File) != 7 {
		t.Fatalf("full archive members %d", len(full.File))
	}
	fullMembers := map[string]bool{}
	for _, f := range full.File {
		fullMembers[f.Name] = true
		if !strings.HasPrefix(f.Name, "SunYu_ERP/") || f.FileInfo().IsDir() {
			t.Fatalf("wrong full archive entry %s", f.Name)
		}
	}
	for p := range m.Files {
		if !fullMembers["SunYu_ERP/"+p] {
			t.Fatalf("full archive missing %s", p)
		}
	}
	var catalog update.Catalog
	b, err := os.ReadFile(filepath.Join(o.Output, "update-manifest-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(b, &catalog); err != nil {
		t.Fatal(err)
	}
	if catalog.Notes != o.Notes || catalog.Version != o.Version || len(catalog.Packages) != 2 {
		t.Fatalf("wrong catalog %#v", catalog)
	}
	var legacy map[string]any
	b, err = os.ReadFile(filepath.Join(o.Output, "update-manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(b, &legacy); err != nil {
		t.Fatal(err)
	}
	if len(legacy) != 4 || legacy["format"] != float64(1) || legacy["version"] != o.Version || !strings.Contains(legacy["notes"].(string), "/update.exe") || strings.Contains(legacy["notes"].(string), "SunYu_ERP_Upgrade.exe") {
		t.Fatalf("wrong legacy catalog: %#v", legacy)
	}
	components := legacy["components"].(map[string]any)
	for name, wantHash := range map[string]string{"frontend": "62f5b7b148846f47a26c9cefc6296a1ebb7d08cacc770534f096066d03496d31", "backend": "17a034d4a60518fabb3010d131c673388a063f7a93b6d304999045883b418d9a"} {
		c := components[name].(map[string]any)
		if len(c) != 3 || c["version"] != "1.3.1" || c["sha256"] != wantHash || c["url"] != "https://github.com/Vex9th/SunYu_ERP/releases/download/v1.3.1/SunYu_ERP-"+name+"-1.3.1.zip" {
			t.Fatalf("legacy component changed: %s %#v", name, c)
		}
	}
	for component, a := range catalog.Packages {
		name := "SunYu_ERP-" + component + "-" + o.Version + ".zip"
		if a.URL != "https://github.com/Vex9th/SunYu_ERP/releases/download/v2.0.1/"+name || a.SHA256 != fileHash(t, filepath.Join(o.Output, name)) {
			t.Fatalf("catalog does not match %s", name)
		}
	}
	sums, err := os.ReadFile(filepath.Join(o.Output, "SHA256SUMS.txt"))
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range result.Artifacts {
		if a.Size <= 0 || a.SHA256 != fileHash(t, filepath.Join(o.Output, a.Name)) || !strings.Contains(string(sums), a.SHA256+"  "+a.Name+"\n") {
			t.Fatalf("wrong artifact %v", a)
		}
	}
	if fileHash(t, filepath.Join(o.Output, "update.exe")) != m.Files["update.exe"] || fileHash(t, filepath.Join(o.Output, "update.exe")) != fileHash(t, filepath.Join(o.BinDir, "update.exe")) {
		t.Fatal("standalone updater differs from the installed updater")
	}
	if _, err := os.Stat(filepath.Join(o.Output, "SunYu_ERP_Upgrade.exe")); !os.IsNotExist(err) {
		t.Fatalf("obsolete standalone upgrade helper was published: %v", err)
	}
}

func TestBuildRejectsBadInputsWithoutPublishing(t *testing.T) {
	for _, name := range []string{"wrong-machine", "not-pe", "missing-updater", "wrong-updater-machine", "not-updater-pe", "old-frontend-base", "missing-asset", "case-alias", "invalid-version", "symlink-web", "output-inside-web"} {
		t.Run(name, func(t *testing.T) {
			o := fixture(t)
			switch name {
			case "wrong-machine":
				_ = os.WriteFile(filepath.Join(o.BinDir, "SunYuService.exe"), fixturePE(pe.IMAGE_FILE_MACHINE_ARM64), 0700)
			case "not-pe":
				_ = os.WriteFile(filepath.Join(o.BinDir, "SunYu_ERP.exe"), []byte("not a native executable"), 0700)
			case "missing-updater":
				_ = os.Remove(filepath.Join(o.BinDir, "update.exe"))
			case "wrong-updater-machine":
				_ = os.WriteFile(filepath.Join(o.BinDir, "update.exe"), fixturePE(pe.IMAGE_FILE_MACHINE_ARM64), 0700)
			case "not-updater-pe":
				_ = os.WriteFile(filepath.Join(o.BinDir, "update.exe"), []byte("not a native executable"), 0700)
			case "old-frontend-base":
				_ = os.WriteFile(filepath.Join(o.WebDir, "index.html"), []byte(`<script src="/assets/main.js"></script>`), 0600)
			case "missing-asset":
				_ = os.Remove(filepath.Join(o.WebDir, "assets", "main.js"))
			case "case-alias":
				_ = os.WriteFile(filepath.Join(o.WebDir, "assets", "MAIN.js"), []byte("duplicate on Windows"), 0600)
				a, _ := os.Stat(filepath.Join(o.WebDir, "assets", "main.js"))
				b, _ := os.Stat(filepath.Join(o.WebDir, "assets", "MAIN.js"))
				if a != nil && b != nil && os.SameFile(a, b) {
					t.Skip("filesystem cannot contain distinct case aliases")
				}
			case "invalid-version":
				o.Version = "../outside"
			case "symlink-web":
				if err := os.Symlink(filepath.Join(o.BinDir, "SunYu_ERP.exe"), filepath.Join(o.WebDir, "assets", "linked.js")); err != nil {
					t.Skip(err)
				}
			case "output-inside-web":
				o.Output = filepath.Join(o.WebDir, "release")
			}
			if _, err := Build(o); err == nil {
				t.Fatal("invalid input accepted")
			}
			if _, err := os.Stat(o.Output); !os.IsNotExist(err) {
				t.Fatalf("invalid inputs published partial output: %v", err)
			}
		})
	}
}

func TestBuildPreservesNonemptyOutput(t *testing.T) {
	o := fixture(t)
	if err := os.MkdirAll(o.Output, 0700); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(o.Output, "important.txt")
	if err := os.WriteFile(p, []byte("user file"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Build(o); err == nil {
		t.Fatal("accepted nonempty output")
	}
	b, err := os.ReadFile(p)
	if err != nil || string(b) != "user file" {
		t.Fatalf("existing output changed: %s %v", b, err)
	}
}

func TestBuildReproducibleWithIndependentComponentVersions(t *testing.T) {
	o := fixture(t)
	o.BackendVersion = "2.0.0"
	o.LauncherVersion = "2.0.0"
	first, err := Build(o)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(filepath.Join(o.WebDir, "index.html"), time.Now(), time.Now()); err != nil {
		t.Fatal(err)
	}
	o.Output = filepath.Join(filepath.Dir(o.Output), "second")
	second, err := Build(o)
	if err != nil {
		t.Fatal(err)
	}
	for i, a := range first.Artifacts {
		if a.SHA256 != second.Artifacts[i].SHA256 {
			t.Fatalf("timestamp changed %s checksum", a.Name)
		}
	}
	m, err := update.ReadManifest(filepath.Join(o.Output, "SunYu_ERP"))
	if err != nil || m.BackendVersion != "2.0.0" || m.LauncherVersion != "2.0.0" || m.FrontendVersion != "2.0.1" {
		t.Fatalf("component versions lost: %#v %v", m, err)
	}
}
