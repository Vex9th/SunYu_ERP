package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
	"time"
)

// Golden results were calculated by the unchanged Python v1.3.1 implementation
// using only synthetic companies, contracts, invoices and supplier transactions.
func TestBusinessPython131GoldenLedgerDashboards(t *testing.T) {
	s := businessTestServer(t)
	seed, e := os.ReadFile("testdata/business_seed.sql")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.DB.Exec(string(seed)); e != nil {
		t.Fatal(e)
	}
	b, e := os.ReadFile("testdata/business_python_131.json")
	if e != nil {
		t.Fatal(e)
	}
	var golden map[string]any
	if e = json.Unmarshal(b, &golden); e != nil {
		t.Fatal(e)
	}
	compare := func(label string, actual, expected any) {
		t.Helper()
		encoded, e := json.Marshal(actual)
		if e != nil {
			t.Fatal(e)
		}
		var normalized any
		json.Unmarshal(encoded, &normalized)
		if !reflect.DeepEqual(normalized, expected) {
			t.Errorf("%s differs from Python 1.3.1\nGo: %s\nPython: %v", label, encoded, expected)
		}
	}
	for id, expected := range golden["ledgers"].(map[string]any) {
		actual := businessExpect(t, s, "GET", "/api/companies/"+id+"/ledger", nil, "", 200)
		compare("ledger "+id, actual, expected)
	}
	actual := businessExpect(t, s, "GET", "/api/dashboard", nil, "", 200)
	compare("global dashboard", actual, golden["global"])
	for code, expected := range golden["projects"].(map[string]any) {
		dashboard := businessExpect(t, s, "GET", "/api/projects/"+code+"/dashboard", nil, "", 200)
		for field, want := range expected.(map[string]any) {
			compare(fmt.Sprintf("project %s %s", code, field), dashboard[field], want)
		}
	}
}
func TestBusinessRoundingAndTermSemantics(t *testing.T) {
	if _, e := businessLineGross(9223372036854775807, 1000, 1); e == nil {
		t.Fatal("overflow must not wrap")
	}
	if got, err := businessLineGross(101, 500, 7); err != nil || got != 58 {
		t.Fatalf("gross: %d", got)
	}
	if got := businessBasisPoints(-1, 6); got != int64(-1667) {
		t.Fatalf("negative margin rounding: %v", got)
	}
	if businessBasisPoints(99, 0) != nil {
		t.Fatal("zero denominator must return null")
	}
	term := businessTermResponse(nil, 40, "2026-10-12", "final")
	if term["status"] != "unplanned" || term["is_overdue"] != false || term["term_fulfillment_basis_points"] != nil {
		t.Fatal(term)
	}
}

func TestBusinessLedgerReadSnapshotAllowsConcurrentPayment(t *testing.T) {
	s := businessTestServer(t)
	seed, e := os.ReadFile("testdata/business_seed.sql")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.DB.Exec(string(seed)); e != nil {
		t.Fatal(e)
	}
	c := &Context{S: s, DB: s.DB, R: httptest.NewRequest("GET", "/api/companies/1/ledger", nil), W: httptest.NewRecorder()}
	var before Row
	_, e = c.ReadTx(func(tx *Context) (any, error) {
		var err error
		before, err = businessCompanyLedger(tx.DB, 1)
		if err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, err = s.DB.ExecContext(ctx, "UPDATE supplier_payments SET amount_cents=amount_cents+77 WHERE id=1")
		if err != nil {
			return nil, fmt.Errorf("read snapshot blocked independent payment: %w", err)
		}
		again, err := businessCompanyLedger(tx.DB, 1)
		if err != nil {
			return nil, err
		}
		if !reflect.DeepEqual(before, again) {
			return nil, fmt.Errorf("ledger mixed old and new facts within one snapshot")
		}
		return again, nil
	})
	if e != nil {
		t.Fatal(e)
	}
	after, e := businessCompanyLedger(s.DB, 1)
	if e != nil {
		t.Fatal(e)
	}
	paid := func(r Row) int64 { return businessInt(r["supplier"].(Row)["summary"].(Row)["paid_amount_cents"]) }
	if paid(after)-paid(before) != 77 {
		t.Fatal("new read did not observe committed payment", before, after)
	}
}
