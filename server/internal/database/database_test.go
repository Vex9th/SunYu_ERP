package database

import (
	"net/url"
	"path/filepath"
	"sync"
	"testing"
)

func TestMigrationsPreserveDataAndRejectFutureLedger(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "iapm.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = db.QueryRow("SELECT count(*) FROM schema_migrations").Scan(&count); err != nil || count != 23 {
		t.Fatalf("%d %v", count, err)
	}
	if _, err = db.Exec("INSERT INTO auth_secret VALUES(1,'unchanged','2026-10-12')"); err != nil {
		t.Fatal(err)
	}
	if err = ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	var hash string
	_ = db.QueryRow("SELECT password_hash FROM auth_secret").Scan(&hash)
	if hash != "unchanged" {
		t.Fatal(hash)
	}
	_, err = db.Exec("INSERT INTO schema_migrations VALUES('999_future','2026-10-12')")
	if err != nil {
		t.Fatal(err)
	}
	if err = ApplyMigrations(db); err == nil {
		t.Fatal("accepted newer schema")
	}
}

func TestSQLiteURIWindowsDriveAndReservedCharacters(t *testing.T) {
	for _, path := range []string{"C:/客户资料/ERP #1/iapm.sqlite", "/tmp/ERP ?1/iapm.sqlite"} {
		u, err := url.Parse(sqliteURI(path))
		if err != nil {
			t.Fatal(err)
		}
		want := path
		if path[0] != '/' {
			want = "/" + path
		}
		if u.Scheme != "file" || u.Host != "" || u.Path != want || u.Fragment != "" {
			t.Fatalf("wrong URI for %q: %#v", path, u)
		}
		if u.Query().Get("_txlock") != "immediate" {
			t.Fatalf("lost transaction locking: %s", u)
		}
	}
}

func TestMigrationsConcurrentStartup(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "iapm.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); <-start; errs <- ApplyMigrations(db) }()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Error(err)
		}
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM schema_migrations").Scan(&count); err != nil || count != 23 {
		t.Fatalf("migration count %d: %v", count, err)
	}
}

func TestProjectIdentityRejectsInvalidUTF8(t *testing.T) {
	if _, err := ProjectIdentity("project-\xff"); err == nil {
		t.Fatal("accepted invalid UTF-8 project directory")
	}
}
