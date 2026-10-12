package api

import (
	"encoding/json"
	"testing"
)

func TestDeliveryWarrantyMonthEnd(t *testing.T) {
	for _, tc := range []struct {
		start  string
		months int64
		want   string
	}{{"2024-01-31", 1, "2024-02-29"}, {"2023-01-31", 1, "2023-02-28"}, {"2024-02-29", 12, "2025-02-28"}} {
		if got := dlAddMonths(tc.start, tc.months); got != tc.want {
			t.Fatalf("%s+%d = %s", tc.start, tc.months, got)
		}
	}
}
func TestAdvanceAmountRejectsSilentClientMismatch(t *testing.T) {
	r := Row{"worker_id": json.Number("1"), "spent_on": "2026-10-12", "vendor_name": nil, "notes": nil, "document_version_ids": []any{}, "items": []any{Row{"name": "材料", "specification": nil, "brand": nil, "quantity": "0.500", "unit": "件", "unit_price_cents": json.Number("101"), "line_amount_cents": json.Number("50")}}}
	_, err := dWrap(func(*Context) any { return soNormalizeAdvance(r, false) })(nil)
	if err == nil {
		t.Fatal("half-cent must round to 51 and reject 50")
	}
}
func TestDeliverySignoffRejectsContradictoryStatus(t *testing.T) {
	r := Row{"status": "confirmed", "confirmed_on": nil, "not_required_reason": nil, "notes": nil, "document_version_ids": []any{}, "expected_revision": nil}
	_, err := dWrap(func(*Context) any { return dlSignoffPayload(r) })(nil)
	if err == nil {
		t.Fatal("confirmed signoff requires date")
	}
}
