package update

import "io"

func readStateFile(path string, limit int64) ([]byte, error) {
	file, err := openStateFile(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(io.LimitReader(file, limit+1))
}
