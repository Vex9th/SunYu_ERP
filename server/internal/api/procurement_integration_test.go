package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/xuri/excelize/v2"
)

func procFixture(t *testing.T) (*Server, Row, Row) {
	t.Helper()
	s := businessTestServer(t)
	RegisterProcurement(s)
	company := businessTestCompany(t, s, "南京昆辰")
	project := businessTestProject(t, s, company, "PROJ-01")
	return s, company, project
}
func procKey(n int) string { return fmt.Sprintf("12345678-1234-4234-8234-%012d", n) }
func procLinePayload() Row {
	return Row{"sequence_no": 1, "category": "电气", "name": "按钮", "specification": nil, "brand": nil, "model": "A", "quantity": "3.000", "unit": "个", "unit_cost_cents": 100, "quoted_unit_price_cents": 150}
}
func procReadyList(t *testing.T, s *Server) (Row, Row) {
	t.Helper()
	list := businessExpect(t, s, "POST", "/api/projects/PROJ-01/procurement-lists", Row{"name": "采购清单", "notes": nil}, procKey(1), 201)
	path := fmt.Sprintf("/api/projects/PROJ-01/procurement-lists/%d", pInt(list["id"]))
	line := businessExpect(t, s, "POST", path+"/lines", procLinePayload(), procKey(2), 201)
	list = businessExpect(t, s, "POST", path+"/confirm", Row{"expected_revision": line["list_revision"]}, procKey(3), 200)
	return list, line
}
func procOrderPayload(company, line Row) Row {
	return Row{"order_no": "", "supplier_company_id": company["id"], "ordered_on": "2026-10-12", "expected_delivery_on": nil, "notes": nil, "document_version_ids": []any{}, "tax_rate_bps": 1300, "lines": []any{Row{"procurement_line_id": line["id"], "quantity": "3.000", "unit_cost_cents": 100, "overage_reason": nil}}}
}
func TestProcurementLifecycleConservesMoneyAndReversals(t *testing.T) {
	s, company, _ := procFixture(t)
	_, line := procReadyList(t, s)
	order := businessExpect(t, s, "POST", "/api/projects/PROJ-01/purchase-orders", procOrderPayload(company, line), procKey(4), 201)
	if pInt(order["ordered_amount_cents"]) != 339 || pInt(order["tax_amount_cents"]) != 39 {
		t.Fatalf("tax: %#v", order)
	}
	if !strings.HasPrefix(Str(order["order_no"]), "PO_") {
		t.Fatal(order)
	}
	path := fmt.Sprintf("/api/projects/PROJ-01/purchase-orders/%d", pInt(order["id"]))
	order = businessExpect(t, s, "POST", path+"/confirm", Row{"expected_revision": 1}, procKey(5), 200)
	ol := order["lines"].([]any)[0].(map[string]any)
	over := Row{"paid_on": "2026-10-12", "amount_cents": 340, "payment_method": "银行", "reference_no": nil, "notes": nil, "allocations": []any{Row{"purchase_order_line_id": ol["id"], "amount_cents": 340}}}
	failure := businessExpect(t, s, "POST", path+"/supplier-payments", over, procKey(6), 409)
	if failure["error_code"] != "PAYMENT_AMOUNT_EXCEEDED" {
		t.Fatal(failure)
	}
	if n := pScalar(s.DB, "SELECT COUNT(*) FROM supplier_payments"); n != 0 {
		t.Fatal("failed payment leaked", n)
	}
	over["amount_cents"] = 339
	over["allocations"] = []any{Row{"purchase_order_line_id": ol["id"], "amount_cents": 339}}
	payment := businessExpect(t, s, "POST", path+"/supplier-payments", over, procKey(6), 201)
	replay := businessExpect(t, s, "POST", path+"/supplier-payments", over, procKey(6), 201)
	if replay["id"] != payment["id"] {
		t.Fatal("idempotency lost")
	}
	receiptBody := Row{"received_on": "2026-10-12", "warehouse_name": "主仓", "notes": nil, "lines": []any{Row{"purchase_order_line_id": ol["id"], "quantity": "3.000"}}}
	receipt := businessExpect(t, s, "POST", path+"/goods-receipts", receiptBody, procKey(7), 201)
	rl := receipt["lines"].([]any)[0].(map[string]any)
	if pInt(rl["value_cents"]) != 339 {
		t.Fatal(rl)
	}
	item := rl["inventory_item_id"]
	issueBody := Row{"issued_on": "2026-10-12", "worker_id": nil, "notes": nil, "lines": []any{Row{"inventory_item_id": item, "procurement_line_id": line["id"], "quantity": "1.000"}}}
	issue := businessExpect(t, s, "POST", "/api/projects/PROJ-01/inventory-issues", issueBody, procKey(8), 201)
	if pInt(issue["total_cost_cents"]) != 113 {
		t.Fatal(issue)
	}
	reverse := Row{"reason": "纠正", "expected_revision": 1}
	businessExpect(t, s, "POST", fmt.Sprintf("/api/projects/PROJ-01/goods-receipts/%d/reverse", pInt(receipt["id"])), reverse, procKey(9), 409)
	businessExpect(t, s, "POST", fmt.Sprintf("/api/projects/PROJ-01/inventory-issues/%d/reverse", pInt(issue["id"])), reverse, procKey(10), 200)
	businessExpect(t, s, "POST", fmt.Sprintf("/api/projects/PROJ-01/goods-receipts/%d/reverse", pInt(receipt["id"])), reverse, procKey(9), 200)
	businessExpect(t, s, "POST", fmt.Sprintf("/api/projects/PROJ-01/supplier-payments/%d/reverse", pInt(payment["id"])), reverse, procKey(11), 200)
	order = businessExpect(t, s, "GET", path, nil, "", 200)
	if pInt(order["paid_amount_cents"]) != 0 || pInt(order["received_amount_cents"]) != 0 || order["status"] != "confirmed" {
		t.Fatal(order)
	}
	balance := pOne(s.DB, "SELECT quantity_milli,inventory_value_cents FROM inventory_items WHERE id=?", item)
	if pInt(balance["quantity_milli"]) != 0 || pInt(balance["inventory_value_cents"]) != 0 {
		t.Fatal(balance)
	}
}
func TestProcurementFailedBulkReceiptRollsBackAllLines(t *testing.T) {
	s, company, _ := procFixture(t)
	_, line := procReadyList(t, s)
	order := businessExpect(t, s, "POST", "/api/projects/PROJ-01/purchase-orders", procOrderPayload(company, line), procKey(4), 201)
	path := fmt.Sprintf("/api/projects/PROJ-01/purchase-orders/%d", pInt(order["id"]))
	order = businessExpect(t, s, "POST", path+"/confirm", Row{"expected_revision": 1}, procKey(5), 200)
	ol := order["lines"].([]any)[0].(map[string]any)
	body := Row{"received_on": "2026-10-12", "warehouse_name": "仓库", "notes": nil, "lines": []any{Row{"purchase_order_line_id": ol["id"], "quantity": "1"}, Row{"purchase_order_line_id": 99999, "quantity": "1"}}}
	businessExpect(t, s, "POST", path+"/goods-receipts", body, procKey(8), 422)
	for _, table := range []string{"goods_receipts", "inventory_items", "inventory_movements"} {
		if n := pScalar(s.DB, "SELECT COUNT(*) FROM "+table); n != 0 {
			t.Fatalf("%s leaked %d", table, n)
		}
	}
}
func TestProcurementConcurrentAutoNumbersAndRevisions(t *testing.T) {
	s, company, _ := procFixture(t)
	list, line := procReadyList(t, s)
	payload := procOrderPayload(company, line)
	var wg sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			b, _ := json.Marshal(payload)
			req := httptest.NewRequest("POST", "/api/projects/PROJ-01/purchase-orders", bytes.NewReader(b))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Idempotency-Key", procKey(100+i))
			req.AddCookie(&http.Cookie{Name: "sunyu_session", Value: CreateSession(s.Config.SessionSecret, s.Now())})
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			results <- w
		}(i)
	}
	wg.Wait()
	close(results)
	for w := range results {
		if w.Code != 201 {
			t.Fatalf("concurrent auto number failed: %d %s", w.Code, w.Body.String())
		}
	}
	if n := pScalar(s.DB, "SELECT COUNT(DISTINCT order_no) FROM purchase_orders"); n != 8 {
		t.Fatal(n)
	}
	bad := businessExpect(t, s, "POST", fmt.Sprintf("/api/projects/PROJ-01/procurement-lists/%d/copy-as-draft", pInt(list["id"])), Row{"expected_revision": 1}, procKey(200), 409)
	if bad["error_code"] != "REVISION_CONFLICT" {
		t.Fatal(bad)
	}
}
func procWorkbookBytes(t *testing.T, formula bool) []byte {
	t.Helper()
	f := excelize.NewFile()
	defer f.Close()
	pWriteRow(f, "Sheet1", 1, pStringsAny(pTemplateHeaders))
	pWriteRow(f, "Sheet1", 2, []any{1, "电气", "按钮", nil, nil, "A", "3.000", "个", "1.00", "1.50"})
	if formula {
		if e := f.SetCellFormula("Sheet1", "I2", "1+1"); e != nil {
			t.Fatal(e)
		}
	}
	b, e := f.WriteToBuffer()
	if e != nil {
		t.Fatal(e)
	}
	return b.Bytes()
}
func TestProcurementSpreadsheetRejectsFormulaAndCommitsOnce(t *testing.T) {
	s, _, _ := procFixture(t)
	bad, e := pParseWorkbook(procWorkbookBytes(t, true))
	if e != nil {
		t.Fatal(e)
	}
	if len(bad["errors"].([]Row)) != 1 || len(bad["rows"].([]Row)) != 0 {
		t.Fatal(bad)
	}
	data := procWorkbookBytes(t, false)
	post := func(key string) *httptest.ResponseRecorder {
		var b bytes.Buffer
		m := multipart.NewWriter(&b)
		part, e := m.CreateFormFile("file", "采购.xlsx")
		if e != nil {
			t.Fatal(e)
		}
		part.Write(data)
		m.Close()
		req := httptest.NewRequest("POST", "/api/projects/PROJ-01/procurement-imports/preview", &b)
		req.Header.Set("Content-Type", m.FormDataContentType())
		req.Header.Set("Idempotency-Key", key)
		req.AddCookie(&http.Cookie{Name: "sunyu_session", Value: CreateSession(s.Config.SessionSecret, s.Now())})
		w := httptest.NewRecorder()
		s.ServeHTTP(w, req)
		return w
	}
	w := post(procKey(1))
	if w.Code != 201 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	var r Row
	d := json.NewDecoder(w.Body)
	d.UseNumber()
	if e := d.Decode(&r); e != nil {
		t.Fatal(e)
	}
	if len(r["rows"].([]any)) != 1 {
		t.Fatal(r)
	}
	path := fmt.Sprintf("/api/projects/PROJ-01/procurement-imports/%d/confirm", pInt(r["id"]))
	body := Row{"list_name": "导入采购", "expected_revision": 1}
	out := businessExpect(t, s, "POST", path, body, procKey(2), 201)
	if out["procurement_list"].(map[string]any)["line_count"].(json.Number) != "1" {
		t.Fatal(out)
	}
	businessExpect(t, s, "POST", path, body, procKey(2), 201)
	if pScalar(s.DB, "SELECT COUNT(*) FROM procurement_lists") != 1 {
		t.Fatal("duplicate imported list")
	}
	w = post(procKey(3))
	if w.Code != 409 {
		t.Fatalf("confirmed workbook must not reimport: %d %s", w.Code, w.Body.String())
	}
}

func TestProcurementSecondAttachmentFilesystemFailureRollsBack(t *testing.T) {
	for _, invoice := range []bool{false, true} {
		t.Run(fmt.Sprint(invoice), func(t *testing.T) {
			s, company, _ := procFixture(t)
			_, line := procReadyList(t, s)
			payload := procOrderPayload(company, line)
			endpoint := "/api/projects/PROJ-01/purchase-orders"
			category := "procurement_contract"
			kind := "purchase_orders"
			if invoice {
				order := businessExpect(t, s, "POST", endpoint, payload, procKey(4), 201)
				path := fmt.Sprintf("%s/%d", endpoint, pInt(order["id"]))
				order = businessExpect(t, s, "POST", path+"/confirm", Row{"expected_revision": 1}, procKey(5), 200)
				ol := order["lines"].([]any)[0].(map[string]any)
				payload = Row{"invoice_no": "INV-FAIL", "invoiced_on": "2026-10-12", "amount_cents": 339, "allocations": []any{Row{"purchase_order_line_id": ol["id"], "amount_cents": 339}}, "document_version_ids": []any{}}
				endpoint = path + "/supplier-invoices"
				category = "invoice"
				kind = "supplier_invoices"
			}
			// The first attachment can publish. A real conflicting filesystem entry blocks only the second.
			directory := filepath.Join(s.Config.DataDir, "Projects", "PROJ-01", category)
			if e := os.MkdirAll(directory, 0700); e != nil {
				t.Fatal(e)
			}
			blocker := filepath.Join(directory, "2")
			if e := os.WriteFile(blocker, []byte("preexisting user file"), 0600); e != nil {
				t.Fatal(e)
			}
			var body bytes.Buffer
			writer := multipart.NewWriter(&body)
			raw, _ := json.Marshal(payload)
			writer.WriteField("payload", string(raw))
			for _, name := range []string{"first.pdf", "second.pdf"} {
				p, e := writer.CreateFormFile("files", name)
				if e != nil {
					t.Fatal(e)
				}
				p.Write([]byte(name))
			}
			writer.Close()
			r := httptest.NewRequest("POST", endpoint, &body)
			r.Header.Set("Content-Type", writer.FormDataContentType())
			r.Header.Set("Idempotency-Key", procKey(12))
			r.AddCookie(&http.Cookie{Name: "sunyu_session", Value: CreateSession(s.Config.SessionSecret, s.Now())})
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != 500 {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
			for _, table := range []string{kind, "documents", "document_versions"} {
				if n := pScalar(s.DB, "SELECT COUNT(*) FROM "+table); n != 0 {
					t.Fatalf("%s leaked %d", table, n)
				}
			}
			var files []string
			filepath.WalkDir(filepath.Join(s.Config.DataDir, "Projects"), func(path string, d os.DirEntry, e error) error {
				if e != nil {
					return e
				}
				if !d.IsDir() {
					files = append(files, path)
				}
				return nil
			})
			if len(files) != 1 || files[0] != blocker {
				t.Fatalf("attachment cleanup removed user file or left published file: %v", files)
			}
			staged, _ := filepath.Glob(filepath.Join(s.Config.DataDir, "Temp", ".upload-*.tmp"))
			if len(staged) != 0 {
				t.Fatal("staged file leak", staged)
			}
		})
	}
}
func TestProcurementImportRejectsMultipleUploadsAndCleansTemporaryFiles(t *testing.T) {
	s, _, _ := procFixture(t)
	temporary := t.TempDir()
	t.Setenv("TMPDIR", temporary)
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, name := range []string{"first.xlsx", "second.xlsx"} {
		part, e := writer.CreateFormFile("file", name)
		if e != nil {
			t.Fatal(e)
		}
		part.Write(bytes.Repeat([]byte("x"), 1100000))
	}
	writer.Close()
	r := httptest.NewRequest("POST", "/api/projects/PROJ-01/procurement-imports/preview", &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	r.Header.Set("Idempotency-Key", procKey(1))
	r.AddCookie(&http.Cookie{Name: "sunyu_session", Value: CreateSession(s.Config.SessionSecret, s.Now())})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 422 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	entries, e := os.ReadDir(temporary)
	if e != nil || len(entries) != 0 {
		t.Fatalf("multipart temp leak: %v %v", entries, e)
	}
}
