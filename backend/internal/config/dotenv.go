package config

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// LoadDotenv reads KEY=VALUE pairs from a .env file and sets them as
// environment variables, but only when the key is not already set. Missing
// files are silently ignored so production deployments using real env vars
// are not disturbed.
//
// If name is a bare filename (no path separator), LoadDotenv walks up from
// the current working directory looking for it. This lets `go run` work from
// any subdirectory of the project — e.g. `cd cmd/server && go run main.go`
// finds the .env at the project root. An absolute or relative path with a
// separator is used as-is.
func LoadDotenv(name string) error {
	resolved, ok := resolveDotenv(name)
	if !ok {
		return nil
	}
	f, err := os.Open(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer f.Close()

	s := bufio.NewScanner(f)
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		val = strings.Trim(val, `"'`)
		if _, set := os.LookupEnv(key); set {
			continue
		}
		if err := os.Setenv(key, val); err != nil {
			return err
		}
	}
	return s.Err()
}

func resolveDotenv(name string) (string, bool) {
	if filepath.IsAbs(name) || strings.ContainsRune(name, filepath.Separator) {
		return name, true
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", false
	}
	for i := 0; i < 8; i++ {
		candidate := filepath.Join(dir, name)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", false
}
