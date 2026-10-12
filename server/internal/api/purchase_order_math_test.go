package api

import (
	"math"
	"testing"
)

func TestProcurementQuantityRejectsMalformedAndZero(t *testing.T) {
	for _, v := range []any{"0", "0.000", "01", "1e2", "1.0001", 1, "1000000000", "-1", " 1", "NaN"} {
		if _, e := procParseQuantity(v, false); e == nil {
			t.Fatalf("accepted %#v", v)
		}
	}
	for input, want := range map[string]int64{"0.001": 1, "1.25": 1250, "999999999.999": 999999999999, "-0.5": -500} {
		got, e := procParseQuantity(input, true)
		if e != nil || got != want {
			t.Fatalf("%s: %d %v", input, got, e)
		}
	}
}
func TestProcurementTaxRoundingAndOverflow(t *testing.T) {
	net, tax, gross, e := procAmounts(5, 1000, 1300)
	if e != nil || net != 5 || tax != 1 || gross != 6 {
		t.Fatalf("%d %d %d %v", net, tax, gross, e)
	}
	_, _, _, e = procAmounts(math.MaxInt64, 1000, 10000)
	if e == nil {
		t.Fatal("gross overflow accepted")
	}
	net, tax, gross, e = procAmounts(1, 500, 0)
	if e != nil || net != 1 || tax != 0 || gross != 1 {
		t.Fatalf("half cent %d %d %d %v", net, tax, gross, e)
	}
}
func TestProcurementCostAllocationConservesLastReceipt(t *testing.T) {
	if v, e := procReceiptCost(113, 3000, 2000, 75, 1000); e != nil || v != 38 {
		t.Fatalf("last receipt loses cents: %d %v", v, e)
	}
	if v, e := procReceiptCost(1, 3000, 0, 0, 1000); e != nil || v != 0 {
		t.Fatalf("fractional receipt: %d %v", v, e)
	}
	if _, e := procReceiptCost(1, 3000, 0, 2, 1000); e == nil {
		t.Fatal("invalid prior receipt accepted")
	}
}
