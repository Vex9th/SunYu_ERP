package distribution

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sunyu.local/erp/internal/update"
	"time"
)

func copySnapshot(root *os.Root, source, target string, mode os.FileMode) (string, error) {
	in, err := openRegular(root, source)
	if err != nil {
		return "", err
	}
	defer in.Close()
	if err = os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return "", err
	}
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(out, h), in)
	if err == nil {
		err = out.Sync()
	}
	closed := out.Close()
	if err == nil {
		err = closed
	}
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func writeJSON(p string, value any) error {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, append(b, '\n'), 0644)
}
func artifact(root, name string) (Artifact, error) {
	f, err := os.Open(filepath.Join(root, name))
	if err != nil {
		return Artifact{}, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return Artifact{}, err
	}
	return Artifact{Name: name, SHA256: hex.EncodeToString(h.Sum(nil)), Size: n}, nil
}
func sortedFiles(files map[string]string) []string {
	names := make([]string, 0, len(files))
	for p := range files {
		names = append(names, p)
	}
	sort.Strings(names)
	return names
}

// ZIP timestamps/modes/order are fixed so identical inputs yield identical hashes.
var zipEpoch = time.Date(1980, time.January, 1, 0, 0, 0, 0, time.UTC)

func addZIP(z *zip.Writer, name string, reader io.Reader, mode os.FileMode) error {
	h := &zip.FileHeader{Name: name, Method: zip.Deflate, Modified: zipEpoch}
	h.SetMode(mode)
	w, err := z.CreateHeader(h)
	if err != nil {
		return err
	}
	_, err = io.Copy(w, reader)
	return err
}
func createZIP(p string, write func(*zip.Writer) error) error {
	f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	z := zip.NewWriter(f)
	err = write(z)
	closeZIP := z.Close()
	if err == nil {
		err = closeZIP
	}
	if err == nil {
		err = f.Sync()
	}
	closeFile := f.Close()
	if err == nil {
		err = closeFile
	}
	return err
}
func addFileZIP(z *zip.Writer, name, source string) error {
	f, err := os.Open(source)
	if err != nil {
		return err
	}
	defer f.Close()
	mode := os.FileMode(0644)
	if strings.HasSuffix(name, ".exe") {
		mode = 0755
	}
	return addZIP(z, name, f, mode)
}
func writeUpdateArchive(p, installation string, m update.Manifest) error {
	if err := m.Validate(); err != nil {
		return err
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return createZIP(p, func(z *zip.Writer) error {
		if err := addZIP(z, "manifest.json", strings.NewReader(string(append(b, '\n'))), 0644); err != nil {
			return err
		}
		for _, name := range sortedFiles(m.Files) {
			if err := addFileZIP(z, "payload/"+name, filepath.Join(installation, filepath.FromSlash(name))); err != nil {
				return err
			}
		}
		return nil
	})
}
func writeFullArchive(p, installation string, m update.Manifest) error {
	names := append(sortedFiles(m.Files), "app/manifest.json")
	sort.Strings(names)
	return createZIP(p, func(z *zip.Writer) error {
		for _, name := range names {
			if err := addFileZIP(z, update.Application+"/"+name, filepath.Join(installation, filepath.FromSlash(name))); err != nil {
				return err
			}
		}
		return nil
	})
}
