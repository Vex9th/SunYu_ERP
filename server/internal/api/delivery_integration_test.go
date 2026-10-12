package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sunyu.local/erp/internal/config"
	"sunyu.local/erp/internal/database"
	"testing"
	"time"
)

type dlHarness struct {
	t    *testing.T
	s    *Server
	db   *sql.DB
	root string
}

func dlNewHarness(t *testing.T) *dlHarness {
	t.Helper()
	root := t.TempDir()
	db, err := database.Open(filepath.Join(root, "data.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err = database.ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 2, 1, 4, 0, 0, 0, time.UTC)
	stamp := now.Format(time.RFC3339)
	if _, err = db.Exec("INSERT INTO companies(id,name,created_at,updated_at) VALUES(1,'客户',?,?)", stamp, stamp); err != nil {
		t.Fatal(err)
	}
	for i, code := range []string{"P-001", "P-002"} {
		if _, err = db.Exec("INSERT INTO projects(id,project_code,project_code_key,company_id,name,status,created_at,updated_at) VALUES(?,?,?,1,?,'active',?,?)", i+1, code, strings.ToLower(code), "测试项目", stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	s := New(db, config.Settings{DataDir: root, SessionSecret: "test-session-secret-with-at-least-32-bytes", MaxDocumentUploadMB: 20})
	s.Now = func() time.Time { return now }
	RegisterDelivery(s)
	return &dlHarness{t, s, db, root}
}
func (h *dlHarness) send(method, path string, body any, key string) (int, any) {
	h.t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		h.t.Fatal(err)
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(data))
	r.Header.Set("Content-Type", "application/json")
	if key == "" {
		key = uuid.NewString()
	}
	r.Header.Set("Idempotency-Key", key)
	return h.run(r)
}
func (h *dlHarness) run(r *http.Request) (int, any) {
	h.t.Helper()
	r.AddCookie(&http.Cookie{Name: "sunyu_session", Value: CreateSession(h.s.Config.SessionSecret, h.s.Now())})
	w := httptest.NewRecorder()
	h.s.ServeHTTP(w, r)
	var out any
	dec := json.NewDecoder(w.Body)
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		h.t.Fatalf("response %d: %s: %v", w.Code, w.Body.String(), err)
	}
	return w.Code, out
}
func (h *dlHarness) ok(method, path string, body any, want int) Row {
	h.t.Helper()
	status, out := h.send(method, path, body, "")
	if status != want {
		h.t.Fatalf("%s %s: %d != %d: %v", method, path, status, want, out)
	}
	return out.(map[string]any)
}
func (h *dlHarness) count(table string) int64 {
	h.t.Helper()
	var n int64
	if err := h.db.QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
		h.t.Fatal(err)
	}
	return n
}
func (h *dlHarness) workerAndAssignment(name string) Row {
	h.t.Helper()
	worker := h.ok("POST", "/api/workers", Row{"name": name, "phone": nil, "notes": nil}, 201)
	return h.ok("POST", "/api/projects/P-001/crew-assignments", Row{"worker_id": worker["id"], "role": "施工", "scheduled_start_on": "2026-01-01", "scheduled_end_on": "2026-12-31", "pay_basis": "daily", "rate_cents": 20001, "notes": nil}, 201)
}
func dlLaborPayload(assignment any) Row {
	return Row{"assignment_id": assignment, "attendance_status": "present", "day_fraction": "0.500", "work_minutes": nil, "work_summary": "安装", "notes": nil, "expected_revision": nil}
}
func TestWorkforceBatchAtomicRollbackAndHistoricalRate(t *testing.T) {
	h := dlNewHarness(t)
	a := h.workerAndAssignment("甲")
	b := h.workerAndAssignment("乙")
	bad := dlLaborPayload(b["id"])
	bad["work_minutes"] = 60
	status, out := h.send("POST", "/api/projects/P-001/labor-entries/batch", Row{"work_date": "2026-02-01", "entries": []any{dlLaborPayload(a["id"]), bad}}, "")
	if status != 422 || h.count("labor_entries") != 0 {
		t.Fatalf("batch must rollback: %d %v", status, out)
	}
	entry := h.ok("POST", "/api/projects/P-001/labor-entries/batch", Row{"work_date": "2026-02-01", "entries": []any{dlLaborPayload(a["id"])}}, 200)["items"].([]any)[0].(map[string]any)
	if dI(entry["cost_cents"]) != 10001 {
		t.Fatalf("rounding %v", entry)
	}
	h.ok("PUT", fmt.Sprintf("/api/projects/P-001/crew-assignments/%d", dI(a["id"])), Row{"worker_id": a["worker_id"], "role": "施工", "scheduled_start_on": "2026-01-01", "scheduled_end_on": "2026-12-31", "pay_basis": "daily", "rate_cents": 99999, "notes": nil, "expected_revision": 1}, 200)
	corrected := dlLaborPayload(a["id"])
	corrected["expected_revision"] = 1
	corrected["day_fraction"] = "1.000"
	result := h.ok("POST", "/api/projects/P-001/labor-entries/batch", Row{"work_date": "2026-02-01", "entries": []any{corrected}}, 200)["items"].([]any)[0].(map[string]any)
	if dI(result["cost_cents"]) != 20001 || dI(result["rate_cents"]) != 20001 {
		t.Fatalf("historical wage changed: %v", result)
	}
}
func TestSiteReportVersionAndReimbursementAudit(t *testing.T) {
	h := dlNewHarness(t)
	a := h.workerAndAssignment("垫付人")
	report := Row{"location": "现场", "weather": nil, "work_summary": "初版施工", "blockers": nil, "next_plan": nil, "notes": nil, "expected_revision": nil}
	h.ok("PUT", "/api/projects/P-001/site-daily-reports/2026-02-01", report, 200)
	h.ok("POST", "/api/projects/P-001/site-daily-reports/2026-02-01/confirm", Row{"confirmed_at": "2026-02-01T11:00:00+08:00", "expected_revision": 1}, 200)
	h.ok("POST", "/api/projects/P-001/site-daily-reports/2026-02-01/reopen", Row{"reason": "更正", "expected_revision": 2}, 200)
	report["expected_revision"] = 3
	report["work_summary"] = "更正施工"
	updated := h.ok("PUT", "/api/projects/P-001/site-daily-reports/2026-02-01", report, 200)
	versions := updated["versions"].([]any)
	if len(versions) != 1 || versions[0].(map[string]any)["work_summary"] != "初版施工" {
		t.Fatalf("immutable snapshot changed: %v", updated)
	}
	advancePayload := Row{"worker_id": a["worker_id"], "spent_on": "2026-02-01", "vendor_name": "五金店", "notes": nil, "document_version_ids": []any{}, "items": []any{Row{"name": "螺钉", "specification": nil, "brand": nil, "quantity": "2.500", "unit": "包", "unit_price_cents": 1200, "line_amount_cents": 3000}}}
	advance := h.ok("POST", "/api/projects/P-001/material-advances", advancePayload, 201)
	base := fmt.Sprintf("/api/projects/P-001/material-advances/%d", dI(advance["id"]))
	payment := h.ok("POST", base+"/reimbursements", Row{"amount_cents": 1500, "reimbursed_on": "2026-02-01", "payment_method": "cash", "notes": nil}, 201)
	if payment["advance_status"] != "partial" {
		t.Fatalf("bad derived balance: %v", payment)
	}
	advancePayload["expected_revision"] = 2
	h.ok("PUT", base, advancePayload, 409)
	undone := h.ok("POST", fmt.Sprintf("%s/reimbursements/%d/void", base, dI(payment["id"])), Row{"reason": "付款撤销", "expected_revision": 1}, 200)
	if undone["status"] != "voided" || dI(undone["advance_outstanding_amount_cents"]) != 3000 || h.count("advance_reimbursements") != 1 {
		t.Fatalf("audit/balance lost: %v", undone)
	}
}
func TestDeliverySecondAttachmentFailureRollsBackPublishedFiles(t *testing.T) {
	h := dlNewHarness(t)
	// The first attachment reaches disk and DB; fail the second document insert.
	if _, err := h.db.Exec(`CREATE TRIGGER fail_second_document BEFORE INSERT ON documents WHEN (SELECT count(*) FROM documents)>=1 BEGIN SELECT RAISE(ABORT,'injected second publish failure'); END`); err != nil {
		t.Fatal(err)
	}
	payload := Row{"invoice_type": "other", "status": "planned", "requested_on": nil, "recorded_on": nil, "invoice_number": nil, "amount_cents": nil, "counterparty_name": nil, "notes": nil, "document_version_ids": []any{}}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	raw, _ := json.Marshal(payload)
	if err := writer.WriteField("payload", string(raw)); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"first.pdf", "second.pdf"} {
		part, err := writer.CreateFormFile("files", name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = part.Write([]byte(name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/api/projects/P-001/invoices", &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	r.Header.Set("Idempotency-Key", uuid.NewString())
	status, out := h.run(r)
	if status != 500 {
		t.Fatalf("failure hidden: %d %v", status, out)
	}
	for _, table := range []string{"project_invoices", "documents", "document_versions", "workforce_document_links", "idempotency_requests"} {
		if h.count(table) != 0 {
			t.Fatalf("partial commit in %s", table)
		}
	}
	for _, dir := range []string{"Projects", "Temp"} {
		err := filepath.WalkDir(filepath.Join(h.root, dir), func(path string, entry os.DirEntry, err error) error {
			if os.IsNotExist(err) {
				return nil
			}
			if err != nil {
				return err
			}
			if !entry.IsDir() {
				t.Errorf("failed transaction leaked %s", path)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}
func TestDeliveryFinalAcceptanceRequiresAtomicWarrantyAndIdempotency(t *testing.T) {
	h := dlNewHarness(t)
	a := h.ok("POST", "/api/projects/P-001/acceptances", Row{"acceptance_type": "final", "scheduled_on": "2026-01-31", "notes": nil}, 201)
	path := fmt.Sprintf("/api/projects/P-001/acceptances/%d/complete", dI(a["id"]))
	p := Row{"performed_on": "2026-01-31", "result": "passed", "notes": nil, "document_version_ids": []any{}, "warranty": nil, "expected_revision": 1}
	h.ok("POST", path, p, 422)
	if h.count("warranties") != 0 {
		t.Fatal("failed completion created warranty")
	}
	p["warranty"] = Row{"starts_on": "2026-01-31", "duration_months": 1, "renewal_price_cents": nil, "notes": nil}
	key := uuid.NewString()
	status, out := h.send("POST", path, p, key)
	if status != 200 {
		t.Fatalf("completion failed: %d %v", status, out)
	}
	first := out.(map[string]any)
	if first["warranty"].(map[string]any)["ends_on"] != "2026-02-28" {
		t.Fatalf("calendar month failed: %v", out)
	}
	if _, err := h.db.Exec("UPDATE projects SET status='archived',archived_at=? WHERE id=1", h.s.Now().Format(time.RFC3339)); err != nil {
		t.Fatal(err)
	}
	status, replayed := h.send("POST", path, p, key)
	if status != 200 || h.count("warranties") != 1 {
		t.Fatalf("unknown outcome replay failed: %d %v", status, replayed)
	}
}
func TestDeliveryReadDomainUsesOneSnapshot(t *testing.T) {
	h := dlNewHarness(t)
	c := &Context{S: h.s, DB: h.db, R: httptest.NewRequest("GET", "/api/projects/P-001/invoices", nil), Status: 200}
	_, err := dDomain("delivery", func(tx *Context) any {
		before := dRow(tx.DB, "SELECT name FROM projects WHERE id=1")["name"]
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if _, err := h.db.ExecContext(ctx, "UPDATE projects SET name='并发更新' WHERE id=1"); err != nil {
			t.Fatalf("read snapshot blocked writer: %v", err)
		}
		after := dRow(tx.DB, "SELECT name FROM projects WHERE id=1")["name"]
		if before != after {
			t.Fatalf("read changed within one response: %v -> %v", before, after)
		}
		return Row{}
	})(c)
	if err != nil {
		t.Fatal(err)
	}
	if dRow(h.db, "SELECT name FROM projects WHERE id=1")["name"] != "并发更新" {
		t.Fatal("concurrent writer did not persist")
	}
}
func TestDeliveryRejectsRationalDayFractionAndMalformedJSON(t *testing.T) {
	if _, err := dWrap(func(*Context) any { return dDecimalMilli("1/2", "day_fraction", "INVALID_LABOR_PAYLOAD", 1000) })(nil); err == nil {
		t.Fatal("non-decimal rational accepted")
	}
	h := dlNewHarness(t)
	r := httptest.NewRequest("POST", "/api/projects/P-001/invoices", strings.NewReader("{"))
	r.Header.Set("Content-Type", "application/json")
	status, out := h.run(r)
	if status != 422 || out.(map[string]any)["error_code"] != "INVALID_INVOICE_PAYLOAD" {
		t.Fatalf("missing structured error: %d %v", status, out)
	}
}
