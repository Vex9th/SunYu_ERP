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
	"sync"
	"testing"
)

func businessContractPayload(company Row, code, number string, amount int64) Row {
	return Row{"contract_no": number, "title": "合同 " + number, "customer_company_id": company["id"], "signed_on": "2026-10-01", "total_amount_cents": amount, "final_delivery_on": "2026-10-20", "allocations": []any{Row{"project_code": code, "amount_cents": amount}}, "notes": nil, "document_version_ids": []any{}}
}
func businessTestContract(t *testing.T, s *Server, company Row, code, number string, amount int64) Row {
	t.Helper()
	p := businessContractPayload(company, code, number, amount)
	r := businessExpect(t, s, "POST", "/api/projects/"+code+"/contracts", p, "", 201)
	return businessExpect(t, s, "POST", fmt.Sprintf("/api/projects/%s/contracts/%d/transition", code, businessInt(r["id"])), Row{"to_status": "signed", "occurred_at": "2026-10-01T00:00:00Z", "reason": nil, "expected_revision": 1}, "", 200)
}
func businessReceiptPayload(n int64) Row {
	return Row{"contract_allocation_id": nil, "milestone": "advance", "received_on": "2026-10-12", "amount_cents": n, "payment_method": "bank_transfer", "reference_no": nil, "notes": nil}
}
func TestBusinessContractReceiptCapacityLocksAndVoid(t *testing.T) {
	s := businessTestServer(t)
	customer := businessTestCompany(t, s, "客户")
	businessTestProject(t, s, customer, "PAY-1")
	url := "/api/projects/PAY-1"
	noContract := businessExpect(t, s, "POST", url+"/receipts", businessReceiptPayload(1), "c7edb0c3-608b-41e8-a392-f9728f5e7f51", 409)
	if noContract["error_code"] != "RECEIPT_CONTRACT_REQUIRED" {
		t.Fatal(noContract)
	}
	contract := businessTestContract(t, s, customer, "PAY-1", "C1", 10000)
	p := businessContractPayload(customer, "PAY-1", "C1", 10000)
	p["expected_revision"] = 2
	p["total_amount_cents"] = 20000
	out := businessExpect(t, s, "PUT", fmt.Sprintf("%s/contracts/%d", url, businessInt(contract["id"])), p, "", 409)
	if out["error_code"] != "CONTRACT_AMOUNT_LOCKED" {
		t.Fatal(out)
	}
	p["total_amount_cents"] = 10000
	p["title"] = "不允许修改"
	out = businessExpect(t, s, "PUT", fmt.Sprintf("%s/contracts/%d", url, businessInt(contract["id"])), p, "", 409)
	if out["error_code"] != "CONTRACT_FORMAL_FIELDS_LOCKED" {
		t.Fatal(out)
	}
	p["title"] = "合同 C1"
	p["notes"] = "可改备注"
	businessExpect(t, s, "PUT", fmt.Sprintf("%s/contracts/%d", url, businessInt(contract["id"])), p, "", 200)
	receipt := businessExpect(t, s, "POST", url+"/receipts", businessReceiptPayload(6000), "51108e41-a275-4347-bd07-015a36fc4b44", 201)
	businessExpect(t, s, "POST", url+"/receipts", businessReceiptPayload(6000), "51108e41-a275-4347-bd07-015a36fc4b44", 201)
	tooMuch := businessExpect(t, s, "POST", url+"/receipts", businessReceiptPayload(5000), "91372580-6b75-48fd-babc-780fa89530d1", 409)
	if tooMuch["error_code"] != "RECEIPT_ALLOCATION_EXCEEDED" {
		t.Fatal(tooMuch)
	}
	term := businessExpect(t, s, "PUT", url+"/payment-terms/advance", Row{"due_on": "2026-10-01", "planned_amount_cents": 10000, "notes": nil, "expected_revision": nil}, "", 200)
	if term["is_overdue"] != true || businessInt(term["received_amount_cents"]) != 6000 {
		t.Fatal(term)
	}
	ledger := businessExpect(t, s, "GET", fmt.Sprintf("/api/companies/%d/ledger", businessInt(customer["id"])), nil, "", 200)
	summary := ledger["customer"].(map[string]any)["summary"].(map[string]any)
	if businessInt(summary["allocated_received_amount_cents"]) != 6000 || businessInt(summary["unreceived_amount_cents"]) != 4000 {
		t.Fatal(summary)
	}
	receiptURL := fmt.Sprintf("%s/receipts/%d", url, businessInt(receipt["id"]))
	businessExpect(t, s, "POST", receiptURL+"/void", Row{"voided_on": "2026-10-11", "reason": "错账", "expected_revision": 1}, "", 422)
	businessExpect(t, s, "POST", receiptURL+"/void", Row{"voided_on": "2026-10-12", "reason": "错账", "expected_revision": 1}, "", 200)
	businessExpect(t, s, "POST", url+"/receipts", businessReceiptPayload(10000), "b53bd349-c1b3-478b-bc5f-72c491d922c8", 201)
	overview := businessExpect(t, s, "GET", url+"/payments", nil, "", 200)
	if businessInt(overview["received_amount_cents"]) != 10000 || businessInt(overview["outstanding_receivable_cents"]) != 0 {
		t.Fatal(overview)
	}
	businessExpect(t, s, "PUT", receiptURL, Row{"reference_no": "x", "notes": nil, "expected_revision": 2}, "", 409)
}
func TestBusinessConcurrentReceiptsCannotOverpay(t *testing.T) {
	s := businessTestServer(t)
	customer := businessTestCompany(t, s, "客户并发")
	businessTestProject(t, s, customer, "CONC-1")
	businessTestContract(t, s, customer, "CONC-1", "C-CONC", 100)
	var wg sync.WaitGroup
	results := make(chan int, 2)
	for i := 0; i < 2; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, _ := businessRequest(t, s, "POST", "/api/projects/CONC-1/receipts", businessReceiptPayload(70), fmt.Sprintf("00000000-0000-0000-0000-%012d", i+100))
			results <- status
		}()
	}
	wg.Wait()
	close(results)
	counts := map[int]int{}
	for status := range results {
		counts[status]++
	}
	if counts[201] != 1 || counts[409] != 1 {
		t.Fatal(counts)
	}
}
func TestBusinessQuoteDocumentsAndSingleAcceptance(t *testing.T) {
	s := businessTestServer(t)
	customer := businessTestCompany(t, s, "报价客户")
	businessTestProject(t, s, customer, "QUOTE-1")
	p := Row{"quote_date": "2026-10-12", "amount_cents": 12345, "valid_until": nil, "notes": nil, "document_version_ids": []any{}}
	var id int64
	for i := 0; i < 2; i++ {
		r := businessExpect(t, s, "POST", "/api/projects/QUOTE-1/quotes", p, "", 201)
		id = businessInt(r["id"])
		if businessInt(r["version_number"]) != int64(i+1) {
			t.Fatal(r)
		}
		base := fmt.Sprintf("/api/projects/QUOTE-1/quotes/%d", id)
		businessExpect(t, s, "POST", base+"/transition", Row{"to_status": "sent", "occurred_at": "2026-10-12T00:00:00Z", "reason": nil, "expected_revision": 1}, "", 200)
		expected := 200
		if i == 1 {
			expected = 409
		}
		out := businessExpect(t, s, "POST", base+"/transition", Row{"to_status": "accepted", "occurred_at": "2026-10-12T00:00:00Z", "reason": nil, "expected_revision": 2}, "", expected)
		if i == 1 && out["error_code"] != "ACCEPTED_QUOTE_EXISTS" {
			t.Fatal(out)
		}
	}
	p["document_version_ids"] = []any{9999}
	businessExpect(t, s, "POST", "/api/projects/QUOTE-1/quotes", p, "", 422)
	p["document_version_ids"] = []any{}
	body := new(bytes.Buffer)
	writer := multipart.NewWriter(body)
	payload, _ := json.Marshal(p)
	writer.WriteField("payload", string(payload))
	file, _ := writer.CreateFormFile("files", "报价.pdf")
	file.Write([]byte("%PDF-test business attachment"))
	writer.Close()
	req := httptest.NewRequest("POST", "/api/projects/QUOTE-1/quotes", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Idempotency-Key", "32d3d882-09d8-4ab4-84da-70b29a31151f")
	req.AddCookie(&http.Cookie{Name: "sunyu_session", Value: CreateSession(s.Config.SessionSecret, s.Now())})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	if w.Code != 201 {
		t.Fatalf("multipart %d: %s", w.Code, w.Body.String())
	}
	var out Row
	json.Unmarshal(w.Body.Bytes(), &out)
	ids := out["document_version_ids"].([]any)
	if len(ids) != 1 {
		t.Fatal(out)
	}
	row, e := One(s.DB, "SELECT stored_relative_path FROM document_versions WHERE id=?", ids[0])
	if e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(s.Config.DataDir, Str(row["stored_relative_path"]))
	data, e := os.ReadFile(path)
	if e != nil || string(data) != "%PDF-test business attachment" {
		t.Fatalf("%s data=%s err=%v", path, data, e)
	}
}
