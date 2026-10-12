package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sunyu.local/erp/internal/config"
	"sunyu.local/erp/internal/database"
	"testing"
	"time"
)

func businessTestServer(t *testing.T) *Server {
	t.Helper()
	root := t.TempDir()
	db, e := database.Open(filepath.Join(root, "test.sqlite"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	if e = database.ApplyMigrations(db); e != nil {
		t.Fatal(e)
	}
	s := New(db, config.Settings{DataDir: root, SessionSecret: "test-only-secret", MaxDocumentUploadMB: 5, BackupIntervalHours: 24})
	s.Now = func() time.Time { return time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC) }
	RegisterBusiness(s)
	return s
}
func businessRequest(t *testing.T, s *Server, method, path string, body any, idem string) (int, any) {
	t.Helper()
	b, e := json.Marshal(body)
	if e != nil {
		t.Fatal(e)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "sunyu_session", Value: CreateSession(s.Config.SessionSecret, s.Now())})
	if idem != "" {
		req.Header.Set("Idempotency-Key", idem)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	if w.Code == 204 {
		return w.Code, nil
	}
	var out any
	dec := json.NewDecoder(w.Body)
	dec.UseNumber()
	if e = dec.Decode(&out); e != nil {
		t.Fatalf("%s %s: status=%d body=%s", method, path, w.Code, w.Body.String())
	}
	return w.Code, out
}
func businessExpect(t *testing.T, s *Server, method, path string, body any, key string, status int) Row {
	t.Helper()
	got, value := businessRequest(t, s, method, path, body, key)
	if got != status {
		t.Fatalf("%s %s: expected %d got %d: %#v", method, path, status, got, value)
	}
	if value == nil {
		return nil
	}
	r, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("expected object: %v", value)
	}
	return r
}
func businessTestCompany(t *testing.T, s *Server, name string) Row {
	t.Helper()
	p := Row{}
	for _, f := range businessCompanyFields {
		p[f] = nil
	}
	p["name"] = name
	return businessExpect(t, s, "POST", "/api/companies", p, "", 201)
}
func businessTestProject(t *testing.T, s *Server, company Row, code string) Row {
	t.Helper()
	return businessExpect(t, s, "POST", "/api/projects", Row{"company_id": company["id"], "project_code": code, "name": "项目 " + code, "description": nil}, "", 201)
}
func businessTestExec(t *testing.T, s *Server, q string, args ...any) int64 {
	t.Helper()
	r, e := s.DB.Exec(q, args...)
	if e != nil {
		t.Fatalf("%s: %v", q, e)
	}
	id, e := r.LastInsertId()
	if e != nil {
		t.Fatal(e)
	}
	return id
}
func TestBusinessCompaniesRevisionIdempotencyAndReferences(t *testing.T) {
	s := businessTestServer(t)
	p := Row{}
	for _, f := range businessCompanyFields {
		p[f] = nil
	}
	p["name"] = "  供应商  "
	key := "04b8bb90-860b-45dd-9395-221801a6fc78"
	company := businessExpect(t, s, "POST", "/api/companies", p, key, 201)
	replay := businessExpect(t, s, "POST", "/api/companies", p, key, 201)
	if company["id"] != replay["id"] || company["name"] != "供应商" {
		t.Fatalf("replay/normalize: %v %v", company, replay)
	}
	p["name"] = "不同"
	if out := businessExpect(t, s, "POST", "/api/companies", p, key, 409); out["error_code"] != "IDEMPOTENCY_KEY_REUSED" {
		t.Fatal(out)
	}
	id := businessInt(company["id"])
	url := fmt.Sprintf("/api/companies/%d", id)
	p["name"] = "供应商"
	p["expected_revision"] = int64(1)
	updated := businessExpect(t, s, "PUT", url, p, "", 200)
	if businessInt(updated["revision"]) != 2 {
		t.Fatal(updated)
	}
	stale := businessExpect(t, s, "PUT", url, p, "", 409)
	if stale["error_code"] != "REVISION_CONFLICT" {
		t.Fatal(stale)
	}
	contact := businessExpect(t, s, "POST", url+"/contacts", Row{"name": "联系人", "phone": nil, "email": nil, "position": nil, "notes": nil}, "", 201)
	contactURL := fmt.Sprintf("%s/contacts/%d", url, businessInt(contact["id"]))
	businessExpect(t, s, "DELETE", contactURL, Row{"expected_revision": 2}, "", 409)
	businessExpect(t, s, "DELETE", contactURL, Row{"expected_revision": 1}, "", 204)
	businessTestProject(t, s, company, "DATA-1")
	businessExpect(t, s, "DELETE", url, Row{"expected_revision": 2}, "", 409)
	businessExpect(t, s, "GET", url, nil, "", 200)
}
func TestBusinessAuthenticationAndStrictBodies(t *testing.T) {
	s := businessTestServer(t)
	r := httptest.NewRequest("POST", "/api/companies", bytes.NewBufferString("{"))
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatalf("auth order: %d", w.Code)
	}
	for _, value := range []any{true, 1.1, "1", json.Number("9223372036854775808")} {
		if _, e := businessPositive(value, "Invalid"); e == nil {
			t.Fatalf("accepted %v", value)
		}
	}
	p := Row{"name": "X"}
	businessExpect(t, s, "POST", "/api/companies", p, "", 422)
}
