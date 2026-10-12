package api

import (
	"encoding/json"
	"testing"
)

func TestWorkforceCostRetainsHistoricalSnapshot(t *testing.T) {
	entry := Row{"attendance_status": "present", "day_fraction_milli": int64(500)}
	assignment := Row{"id": int64(1), "worker_id": int64(2), "pay_basis": "daily", "rate_cents": int64(30001)}
	old := Row{"pay_basis": "daily", "rate_cents": int64(20001)}
	got, err := dWrap(func(*Context) any { return wLaborValues(entry, assignment, old, "INVALID_LABOR_PAYLOAD", "body") })(nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.(Row)["cost_cents"] != int64(10001) {
		t.Fatalf("snapshot/rounding: %v", got)
	}
}
func TestWorkforceInvalidQuantityAndOverflow(t *testing.T) {
	for _, tc := range []struct{ entry, assignment Row }{
		{Row{"attendance_status": "present", "work_minutes": int64(1440)}, Row{"pay_basis": "hourly", "rate_cents": int64(9223372036854775807)}},
		{Row{"attendance_status": "absent", "day_fraction_milli": int64(1000)}, Row{"pay_basis": "daily", "rate_cents": int64(1)}},
	} {
		_, err := dWrap(func(*Context) any { return wLaborValues(tc.entry, tc.assignment, nil, "INVALID_LABOR_PAYLOAD", "body") })(nil)
		if err == nil {
			t.Fatal("invalid labor accepted")
		}
	}
}
func TestWorkforceRejectsFractionalRevision(t *testing.T) {
	_, err := dWrap(func(*Context) any {
		return dInteger(json.Number("1.0"), "expected_revision", "INVALID_LABOR_PAYLOAD", 1)
	})(nil)
	if err == nil {
		t.Fatal("floating-point revision accepted")
	}
}
