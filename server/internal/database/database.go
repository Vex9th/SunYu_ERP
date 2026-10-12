package database

import (
	"database/sql"
	"database/sql/driver"
	"fmt"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
	"modernc.org/sqlite"
	"sunyu.local/erp/migrations"
)

var register sync.Once
var registerError error

func ProjectIdentity(value string) (string, error) {
	s := strings.TrimSpace(value)
	if !utf8.ValidString(s) || s == "" || s == "." || s == ".." || len([]byte(s)) > 120 || strings.TrimRight(s, ". ") != s {
		return "", fmt.Errorf("invalid project code")
	}
	for _, r := range s {
		if unicode.IsControl(r) || strings.ContainsRune("<>:\"/\\|?*", r) {
			return "", fmt.Errorf("invalid project code")
		}
	}
	base := strings.ToUpper(strings.TrimRight(strings.SplitN(s, ".", 2)[0], " "))
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || base == "CONIN$" || base == "CONOUT$" {
		return "", fmt.Errorf("reserved project code")
	}
	for _, prefix := range []string{"COM", "LPT"} {
		if strings.HasPrefix(base, prefix) && strings.Contains("123456789¹²³", strings.TrimPrefix(base, prefix)) && len([]rune(strings.TrimPrefix(base, prefix))) == 1 {
			return "", fmt.Errorf("reserved project code")
		}
	}
	return cases.Fold().String(norm.NFC.String(s)), nil
}
func Open(path string) (*sql.DB, error) {
	register.Do(func() {
		registerError = sqlite.RegisterDeterministicScalarFunction("project_code_identity", 1, func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
			s, ok := args[0].(string)
			if !ok {
				return nil, fmt.Errorf("project_code must be a string")
			}
			return ProjectIdentity(s)
		})
	})
	if registerError != nil {
		return nil, registerError
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", sqliteURI(filepath.ToSlash(absolute)))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)
	if err = db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func sqliteURI(absolute string) string {
	// A Windows drive must be a URI path (/C:/...), never the authority (C:).
	if len(absolute) >= 3 && absolute[1] == ':' && absolute[2] == '/' {
		absolute = "/" + absolute
	}
	u := url.URL{Scheme: "file", Path: absolute}
	q := url.Values{"_pragma": []string{"foreign_keys(1)", "journal_mode(WAL)", "busy_timeout(5000)"}, "_txlock": []string{"immediate"}}
	u.RawQuery = q.Encode()
	return u.String()
}

func ApplyMigrations(db *sql.DB) error {
	entries, err := migrations.FS.ReadDir(".")
	if err != nil {
		return err
	}
	names := []string{}
	known := map[string]int{}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for i, name := range names {
		known[strings.TrimSuffix(name, ".sql")] = i
	}
	applied := map[string]bool{}
	var exists int
	if err = db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations'").Scan(&exists); err != nil {
		return err
	}
	if exists > 0 {
		rows, e := db.Query("SELECT version FROM schema_migrations")
		if e != nil {
			return e
		}
		for rows.Next() {
			var v string
			if e = rows.Scan(&v); e != nil {
				rows.Close()
				return e
			}
			applied[v] = true
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
	}
	last := -1
	for v := range applied {
		i, ok := known[v]
		if !ok {
			return fmt.Errorf("migration drift: unknown applied version %s", v)
		}
		if i > last {
			last = i
		}
	}
	for i := 0; i <= last; i++ {
		v := strings.TrimSuffix(names[i], ".sql")
		if !applied[v] && v != "016_inventory_procurement_corrections" && v != "017_acceptance_corrections" {
			return fmt.Errorf("migration drift: missing prefix %s", v)
		}
	}
	for _, name := range names {
		v := strings.TrimSuffix(name, ".sql")
		if applied[v] {
			continue
		}
		script, e := migrations.FS.ReadFile(name)
		if e != nil {
			return e
		}
		tx, e := db.Begin()
		if e != nil {
			return e
		}
		// Another process may have advanced the ledger while BEGIN IMMEDIATE
		// waited for its write lock. Recheck under the lock before executing DDL.
		var ledgerExists, alreadyApplied int
		e = tx.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations'").Scan(&ledgerExists)
		if e == nil && ledgerExists > 0 {
			e = tx.QueryRow("SELECT count(*) FROM schema_migrations WHERE version=?", v).Scan(&alreadyApplied)
		}
		if e != nil {
			_ = tx.Rollback()
			return e
		}
		if alreadyApplied > 0 {
			_ = tx.Rollback()
			continue
		}
		if _, e = tx.Exec(string(script)); e == nil {
			_, e = tx.Exec("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)", v, time.Now().UTC().Format(time.RFC3339Nano))
		}
		if e != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration %s: %w", v, e)
		}
		if e = tx.Commit(); e != nil {
			return e
		}
	}
	return nil
}
