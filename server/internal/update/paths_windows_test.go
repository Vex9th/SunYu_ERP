//go:build windows

package update

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
	"sunyu.local/erp/internal/pathidentity"
)

func TestBackupRejectsWindowsShortNameAliasesOfProgramDirectories(t *testing.T) {
	e := testEngine(t, t.TempDir())
	applicationFixture(t, e.Root, "2.0.0")
	pointer, err := windows.UTF16PtrFromString(e.Root)
	if err != nil {
		t.Fatal(err)
	}
	buffer := make([]uint16, 32768)
	n, err := windows.GetShortPathName(pointer, &buffer[0], uint32(len(buffer)))
	if err != nil || n >= uint32(len(buffer)) {
		t.Fatalf("GetShortPathName: %d %v", n, err)
	}
	short := windows.UTF16ToString(buffer[:n])
	if strings.EqualFold(short, e.Root) {
		t.Skip("this volume does not expose an 8.3 alias for the test directory")
	}
	for _, relative := range []string{".", "app", ".updates", "app/not-created/nested", ".updates/not-created"} {
		t.Run(relative, func(t *testing.T) {
			data := filepath.Join(short, relative)
			config := []byte(`{"data_dir":` + quoteJSON(data) + `}`)
			if err := os.WriteFile(filepath.Join(e.Root, "config.json"), config, 0600); err != nil {
				t.Fatal(err)
			}
			if _, _, err := installationPaths(e.Root); err == nil {
				t.Fatal("unsafe Data path passed installation validation")
			}
			tx := Transaction{Job: Job{ID: "bad"}}
			if err := e.backup(&tx); err == nil {
				t.Fatalf("unsafe short-name data directory accepted: %q aliases %q", data, e.Root)
			}
			got, err := os.ReadFile(filepath.Join(e.Root, "config.json"))
			if err != nil || string(got) != string(config) {
				t.Fatal("path protection rewrote config")
			}
		})
	}
}

func windowsExtendedPath(path string) string {
	if strings.HasPrefix(path, `\\?\`) {
		return path
	}
	if strings.HasPrefix(path, `\\`) {
		return `\\?\UNC\` + strings.TrimPrefix(path, `\\`)
	}
	return `\\?\` + path
}

func TestBackupRejectsWindowsExtendedAliasesOfProgramDirectories(t *testing.T) {
	for _, relative := range []string{".", "app", ".updates", "app/not-created", ".updates/not-created"} {
		t.Run(relative, func(t *testing.T) {
			e := testEngine(t, t.TempDir())
			applicationFixture(t, e.Root, "2.0.0")
			data := windowsExtendedPath(filepath.Join(e.Root, relative))
			if err := writeJSON(filepath.Join(e.Root, "config.json"), map[string]string{"data_dir": data}); err != nil {
				t.Fatal(err)
			}
			if _, _, err := installationPaths(e.Root); err == nil {
				t.Fatal("unsafe Data path passed installation validation")
			}
			tx := Transaction{Job: Job{ID: "bad"}}
			if err := e.backup(&tx); err == nil {
				t.Fatalf("unsafe extended-path data accepted: %q", data)
			}
		})
	}
}

func windowsJunction(t *testing.T, link, target string) {
	t.Helper()
	output, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
	if err != nil {
		t.Fatalf("mklink /J: %v: %s", err, output)
	}
	t.Cleanup(func() { _ = os.Remove(link) })
}

func TestWindowsJunctionCannotRedirectDataOrManagedDirectories(t *testing.T) {
	for _, relative := range []string{".", "app", ".updates"} {
		t.Run("data/"+relative, func(t *testing.T) {
			e := testEngine(t, t.TempDir())
			applicationFixture(t, e.Root, "2.0.0")
			link := filepath.Join(t.TempDir(), "junction")
			windowsJunction(t, link, filepath.Join(e.Root, relative))
			if err := writeJSON(filepath.Join(e.Root, "config.json"), map[string]string{"data_dir": link}); err != nil {
				t.Fatal(err)
			}
			if _, err := noLinks(link); err == nil {
				t.Error("junction accepted as ordinary Data directory")
			}
			if err := e.backup(&Transaction{Job: Job{ID: "bad"}}); err == nil {
				t.Error("backup followed Data junction")
			}
		})
	}
	for _, relative := range []string{"app", ".updates"} {
		t.Run("managed/"+relative, func(t *testing.T) {
			root, target := t.TempDir(), t.TempDir()
			file := filepath.Join(target, "customer.txt")
			if err := os.WriteFile(file, []byte("preserve"), 0600); err != nil {
				t.Fatal(err)
			}
			windowsJunction(t, filepath.Join(root, relative), target)
			if _, err := safePath(root, relative+"/customer.txt"); err == nil {
				t.Error("managed path accepted junction")
			}
			if e, err := New(root); err == nil {
				e.Close()
				t.Error("engine accepted junction in managed directory")
			}
			got, err := os.ReadFile(file)
			if err != nil || string(got) != "preserve" {
				t.Fatal("outside data changed")
			}
		})
	}
}

func TestWindowsExternalDataAliasIsPreservedThroughRollback(t *testing.T) {
	for _, kind := range []string{"extended", "junction", "short_leaf", "default_Data_junction"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			outside, err := pathidentity.ResolveExisting(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			physical := filepath.Join(outside, "Customer Records Long Name")
			if err := os.Mkdir(physical, 0700); err != nil {
				t.Fatal(err)
			}
			data := physical
			switch kind {
			case "extended":
				data = windowsExtendedPath(physical)
			case "junction":
				data = filepath.Join(outside, "configured-link")
				windowsJunction(t, data, physical)
			case "default_Data_junction":
				windowsJunction(t, filepath.Join(root, "Data"), physical)
				data = "Data"
			case "short_leaf":
				pointer, err := windows.UTF16PtrFromString(physical)
				if err != nil {
					t.Fatal(err)
				}
				buffer := make([]uint16, 32768)
				n, err := windows.GetShortPathName(pointer, &buffer[0], uint32(len(buffer)))
				if err != nil || n >= uint32(len(buffer)) {
					t.Fatalf("GetShortPathName: %d %v", n, err)
				}
				data = windows.UTF16ToString(buffer[:n])
				if strings.EqualFold(filepath.Base(data), filepath.Base(physical)) {
					output, err := exec.Command("fsutil", "file", "setshortname", physical, "CUSTOM~1").CombinedOutput()
					if err != nil {
						t.Skipf("test volume cannot create a fixture short alias: %v %s", err, output)
					}
					data = filepath.Join(outside, "CUSTOM~1")
				}
			}
			e := testEngine(t, root)
			m := applicationFixture(t, e.Root, "2.0.0")
			if err := os.WriteFile(filepath.Join(physical, "database"), []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			configuration := []byte(`{ "data_dir": ` + quoteJSON(data) + `, "original_spacing": 1 }`)
			if err := os.WriteFile(filepath.Join(e.Root, "config.json"), configuration, 0600); err != nil {
				t.Fatal(err)
			}
			identity, err := os.Stat(physical)
			if err != nil {
				t.Fatal(err)
			}
			tx := Transaction{Job: Job{ID: "external"}, Manifest: m, Old: m}
			if err := e.backup(&tx); err != nil {
				t.Fatal(err)
			}
			if tx.DataDir != physical {
				t.Fatalf("did not freeze physical long path: %q", tx.DataDir)
			}
			if err := os.WriteFile(filepath.Join(physical, "database"), []byte("changed"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := e.restore(&tx); err != nil {
				t.Fatal(err)
			}
			// Simulate a second recovery interrupted after part of the content was
			// deleted and copied, then resume from its durable checkpoint.
			tx.State, tx.RestorePhase = "restoring", "data"
			if err := e.saveTransaction(&tx); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(filepath.Join(physical, "database")); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(physical, "partial"), []byte("partial"), 0600); err != nil {
				t.Fatal(err)
			}
			restarted := testEngine(t, e.Root)
			var recovered Transaction
			if err := readJSON(filepath.Join(e.Root, ".updates", "transaction-v2.json"), &recovered); err != nil {
				t.Fatal(err)
			}
			if err := restarted.restore(&recovered); err != nil {
				t.Fatal(err)
			}
			configured := data
			if !filepath.IsAbs(configured) {
				configured = filepath.Join(e.Root, configured)
			}
			got, err := os.ReadFile(filepath.Join(configured, "database"))
			if err != nil || string(got) != "original" {
				t.Fatal("original configured alias no longer reads restored data", string(got), err)
			}
			if _, err := os.Stat(filepath.Join(physical, "partial")); !os.IsNotExist(err) {
				t.Fatal("interrupted content retained")
			}
			after, err := os.Stat(physical)
			if err != nil || !os.SameFile(identity, after) {
				t.Fatal("original long-name Data root object changed")
			}
			got, err = os.ReadFile(filepath.Join(e.Root, "config.json"))
			if err != nil || string(got) != string(configuration) {
				t.Fatal("config bytes changed")
			}
		})
	}
}

func TestWindowsDataAliasesAreExcludedFromLegacyAndPendingCleanup(t *testing.T) {
	e := testEngine(t, t.TempDir())
	applicationFixture(t, e.Root, "2.0.0")
	rel := "releases/backend/1.3.1/customer.txt"
	data := windowsExtendedPath(filepath.Dir(filepath.Join(e.Root, filepath.FromSlash(rel))))
	if err := os.MkdirAll(data, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "customer.txt"), []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	for path, value := range map[string]any{
		"config.json":       map[string]string{"data_dir": data},
		"installation.json": map[string]any{"format": 1, "backend": "1.3.1", "frontend": "1.3.1", "api_version": 1, "runtime_version": 1},
		"releases/backend/1.3.1/.update-manifest.json": map[string]any{"format": 1, "application": Application, "component": "backend", "version": "1.3.1", "files": map[string]string{"customer.txt": digest("preserve")}},
	} {
		if err := writeJSON(filepath.Join(e.Root, filepath.FromSlash(path)), value); err != nil {
			t.Fatal(err)
		}
	}
	files, err := legacyInventory(e.Root)
	if err != nil {
		t.Fatal(err)
	}
	if _, included := files[rel]; included {
		t.Error("legacy inventory selected Data through its path alias")
	}
	if err := e.queueCleanup(map[string]string{rel: digest("preserve")}); err != nil {
		t.Fatal(err)
	}
	if err := e.retryCleanup(); err == nil {
		t.Error("pending cleanup accepted aliased Data")
	}
	got, err := os.ReadFile(filepath.Join(data, "customer.txt"))
	if err != nil || string(got) != "preserve" {
		t.Fatal("aliased Data was deleted")
	}
}
