//go:build !windows

package update

import "os"

func openStateFile(path string) (*os.File, error) { return os.Open(path) }

func replaceStateFile(source, target string) error { return os.Rename(source, target) }
