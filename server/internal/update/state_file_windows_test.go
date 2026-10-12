//go:build windows

package update

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWindowsStateReaderDoesNotBlockAtomicReplacement(t *testing.T) {
	for _, name := range []string{"job.json", "catalog-v2.json", "app/manifest.json", "requests/request.json"} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), name)
			if err := writeJSON(path, map[string]string{"state": "old"}); err != nil {
				t.Fatal(err)
			}
			reader, err := openStateFile(path)
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Close()
			if err := writeJSON(path, map[string]string{"state": "new"}); err != nil {
				t.Fatalf("our state reader blocked atomic replacement: %v", err)
			}
			old, err := io.ReadAll(reader)
			if err != nil {
				t.Fatal(err)
			}
			var snapshot map[string]string
			if err := json.Unmarshal(old, &snapshot); err != nil || snapshot["state"] != "old" {
				t.Fatal("old reader did not retain a complete snapshot", snapshot, err)
			}
			if err := readJSON(path, &snapshot); err != nil || snapshot["state"] != "new" {
				t.Fatal("new reader did not receive new snapshot", snapshot, err)
			}
		})
	}
}

func TestWindowsTemporaryForeignReaderReleasesAtomicReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "job.json")
	if err := writeJSON(path, "old"); err != nil {
		t.Fatal(err)
	}
	reader, err := os.Open(path) // Deliberately uses a foreign reader without SHARE_DELETE.
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { reader.Close() })
	done := make(chan error, 1)
	go func() { done <- writeJSON(path, "new") }()
	select {
	case err := <-done:
		t.Fatalf("replacement did not retry a temporary Windows share violation: %v", err)
	case <-time.After(75 * time.Millisecond):
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	var value string
	if err := readJSON(path, &value); err != nil || value != "new" {
		t.Fatal(value, err)
	}
}

func TestWindowsPermanentForeignReaderReportsStatePersistenceFailure(t *testing.T) {
	e := testEngine(t, t.TempDir())
	j := Job{ID: "persistent-lock", RequestID: "19a7a38d-8e3f-48fb-b7f0-a1193698b04d", Status: "checking"}
	if err := e.saveJob(&j); err != nil {
		t.Fatal(err)
	}
	reader, err := os.Open(filepath.Join(e.Root, ".updates", "job.json"))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	j.Status, j.Phase = "success", "success"
	start := time.Now()
	if err := e.saveJob(&j); err == nil {
		t.Fatal("permanent state lock was silently accepted")
	} else {
		t.Logf("actual persistence failure: %v", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("permanent lock was not bounded")
	}
	got, err := e.Request(j.RequestID)
	if err != nil || got.Status != "failed" || got.Error == "" {
		t.Fatalf("request remains nonterminal or falsely successful: %+v %v", got, err)
	}
	b, _ := json.Marshal(e.Status()["job"])
	var visible Job
	if err := json.Unmarshal(b, &visible); err != nil || visible.Status != "failed" || visible.Error == "" {
		t.Fatalf("UI cannot see persistence failure: %+v %v", visible, err)
	}
}
