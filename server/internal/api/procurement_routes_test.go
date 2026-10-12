package api

import (
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

// This inventory mirrors every legacy procurement and inventory endpoint.
func TestProcurementRouteCoverage(t *testing.T) {
	s, _, _ := procFixture(t)
	for _, pattern := range []string{
		"GET /api/procurement/import-template.xlsx",
		"GET /api/projects/{project_code}/procurement-lists",
		"POST /api/projects/{project_code}/procurement-lists",
		"GET /api/projects/{project_code}/procurement-lists/{list_id}",
		"PUT /api/projects/{project_code}/procurement-lists/{list_id}",
		"POST /api/projects/{project_code}/procurement-lists/{list_id}/lines",
		"PUT /api/projects/{project_code}/procurement-lists/{list_id}/lines/{line_id}",
		"DELETE /api/projects/{project_code}/procurement-lists/{list_id}/lines/{line_id}",
		"POST /api/projects/{project_code}/procurement-lists/{list_id}/confirm",
		"POST /api/projects/{project_code}/procurement-lists/{list_id}/copy-as-draft",
		"GET /api/projects/{project_code}/purchase-order-number-preview",
		"GET /api/projects/{project_code}/purchase-orders",
		"POST /api/projects/{project_code}/purchase-orders",
		"GET /api/projects/{project_code}/purchase-orders/{order_id}",
		"POST /api/projects/{project_code}/purchase-orders/{order_id}/confirm",
		"POST /api/projects/{project_code}/purchase-orders/{order_id}/goods-receipts",
		"GET /api/projects/{project_code}/procurement-options",
		"GET /api/projects/{project_code}/procurement-overview",
		"POST /api/projects/{project_code}/procurement-imports/preview",
		"POST /api/projects/{project_code}/procurement-imports/{import_id}/confirm",
		"PUT /api/projects/{project_code}/purchase-orders/{order_id}",
		"POST /api/projects/{project_code}/purchase-orders/{order_id}/cancel",
		"POST /api/projects/{project_code}/purchase-orders/{order_id}/supplier-payments",
		"POST /api/projects/{project_code}/supplier-payments/{payment_id}/reverse",
		"POST /api/projects/{project_code}/purchase-orders/{order_id}/supplier-invoices",
		"POST /api/projects/{project_code}/supplier-invoices/{invoice_id}/reverse",
		"POST /api/projects/{project_code}/goods-receipts/{receipt_id}/reverse",
		"POST /api/projects/{project_code}/procurement-lists/{list_id}/quote-exports",
		"GET /api/projects/{project_code}/quote-exports",
		"GET /api/projects/{project_code}/quote-exports/{export_id}/download",
		"GET /api/inventory/items",
		"POST /api/inventory/items",
		"GET /api/inventory/items/{item_id}",
		"PUT /api/inventory/items/{item_id}",
		"GET /api/inventory/items/{item_id}/movements",
		"POST /api/inventory/adjustments",
		"POST /api/inventory/adjustments/{adjustment_id}/reverse",
		"POST /api/projects/{project_code}/inventory-issues",
		"POST /api/projects/{project_code}/inventory-issues/{issue_id}/reverse",
	} {
		parts := strings.SplitN(pattern, " ", 2)
		path := regexp.MustCompile(`\{[^}]+\}`).ReplaceAllString(parts[1], "1")
		_, registered := s.Mux.Handler(httptest.NewRequest(parts[0], path, nil))
		if registered != pattern {
			t.Errorf("%s registered as %s", pattern, registered)
		}
	}
}
