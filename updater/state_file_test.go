package main

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestStateReadersPermitAtomicReplacementAndRetainSnapshot(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"status.json", "last-install.json", "transaction.json", "install.json"} {
		t.Run(name, func(t *testing.T) {
			p := filepath.Join(root, name)
			os.WriteFile(p, []byte(`{"value":"old"}`), 0600)
			reader, err := openStateFile(p)
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Close()
			if err = writeJSON(p, map[string]string{"value": "new"}); err != nil {
				t.Fatal("status polling blocked atomic publication", err)
			}
			old, err := io.ReadAll(reader)
			if err != nil || string(old) != `{"value":"old"}` {
				t.Fatal(string(old), err)
			}
			var current map[string]string
			if err = readJSON(p, &current); err != nil || current["value"] != "new" {
				t.Fatal(current, err)
			}
		})
	}
}
