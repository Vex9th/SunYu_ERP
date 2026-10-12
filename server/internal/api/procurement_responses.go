package api

func pLineFacts(db DBTX, id any) Row {
	r := pOne(db, pSQL("procurement", "_line_facts", 0), id)
	total := int64(0)
	for _, l := range pRows(db, pSQL("procurement", "_line_facts", 1), id) {
		total = pAdd(total, pGross(l))
	}
	r["ordered_amount_cents"] = total
	return r
}
func pLineResponse(db DBTX, r Row, revision any) Row {
	f := pLineFacts(db, r["id"])
	required, ordered, received, used := pInt(r["quantity_milli"]), pInt(f["ordered_quantity_milli"]), pInt(f["received_quantity_milli"]), pInt(f["used_quantity_milli"])
	amount, paid, invoiced := pInt(f["ordered_amount_cents"]), pInt(f["paid_amount_cents"]), pInt(f["invoiced_amount_cents"])
	out := pFields(r, "id procurement_list_id inventory_item_id sequence_no category name specification brand model unit unit_cost_cents quoted_unit_price_cents revision created_at updated_at")
	out["quantity"] = procFormatQuantity(required)
	out["cost_total_cents"] = pValue(pInt(r["unit_cost_cents"]), required)
	out["quoted_total_cents"] = pValue(pInt(r["quoted_unit_price_cents"]), required)
	out["ordered_quantity"] = procFormatQuantity(ordered)
	out["ordered_amount_cents"] = amount
	out["paid_amount_cents"] = paid
	out["invoiced_amount_cents"] = invoiced
	out["received_quantity"] = procFormatQuantity(received)
	out["issued_quantity"] = procFormatQuantity(used)
	out["order_status"] = pQuantityStatus(ordered, required, "not_ordered", "ordered", "over_ordered")
	out["payment_status"] = pAmountStatus(paid, amount, "unpaid", "paid")
	out["receipt_status"] = pQuantityStatus(received, ordered, "not_received", "received", "received")
	out["invoice_status"] = pAmountStatus(invoiced, amount, "not_invoiced", "invoiced")
	out["usage_status"] = pQuantityStatus(used, required, "unused", "used", "used")
	if revision != nil {
		out["list_revision"] = revision
	}
	return out
}
func pListSummary(r Row, code any) Row {
	out := pFields(r, "id name notes status revision line_count confirmed_at created_at updated_at")
	out["project_code"] = code
	return out
}
func pListDetail(db DBTX, r Row, code any) Row {
	out := pListSummary(r, code)
	lines := []Row{}
	cost, quote := int64(0), int64(0)
	for _, l := range pListLines(db, r["id"]) {
		v := pLineResponse(db, l, r["revision"])
		lines = append(lines, v)
		cost = pAdd(cost, pInt(v["cost_total_cents"]))
		quote = pAdd(quote, pInt(v["quoted_total_cents"]))
	}
	out["lines"] = lines
	out["line_count"] = len(lines)
	out["cost_total_cents"] = cost
	out["quoted_total_cents"] = quote
	return out
}
func pPaymentResponse(db DBTX, r Row) Row {
	out := pFields(r, "id purchase_order_id paid_on amount_cents payment_method reference_no notes status reversal_reason reversed_at revision created_at updated_at")
	out["allocations"] = pRows(db, pSQL("procurement", "_payment_response", 0), r["id"])
	return out
}
func pInvoiceResponse(db DBTX, r Row) Row {
	out := pFields(r, "id purchase_order_id invoice_no invoiced_on amount_cents status reversal_reason reversed_at revision created_at updated_at")
	out["allocations"] = pRows(db, pSQL("procurement", "_invoice_response", 0), r["id"])
	ids := []int64{}
	for _, d := range pRows(db, pSQL("procurement", "_invoice_response", 1), r["id"]) {
		ids = append(ids, pInt(d["document_version_id"]))
	}
	out["document_version_ids"] = ids
	return out
}
func pReceiptResponse(db DBTX, r Row) Row {
	out := pFields(r, "id purchase_order_id received_on warehouse_name notes status reversal_reason reversed_at revision created_at updated_at")
	lines := []Row{}
	for _, l := range pRows(db, pSQL("procurement", "_receipt_response", 0), r["id"]) {
		v := pFields(l, "id purchase_order_line_id inventory_item_id material_name material_model unit value_cents movement_id")
		v["quantity"] = procFormatQuantity(pInt(l["quantity_milli"]))
		lines = append(lines, v)
	}
	out["lines"] = lines
	return out
}
func pOrderResponse(db DBTX, r Row, code any) Row {
	out := pFields(r, "id order_no supplier_company_id ordered_on expected_delivery_on notes status cancelled_at cancel_reason tax_rate_bps revision created_at updated_at")
	out["project_code"] = code
	supplier := pOne(db, "SELECT name FROM companies WHERE id=?", r["supplier_company_id"])
	out["supplier_company_name"] = supplier["name"]
	ids := []int64{}
	for _, d := range pRows(db, pSQL("procurement", "_order_response", 1), r["id"]) {
		ids = append(ids, pInt(d["document_version_id"]))
	}
	out["document_version_ids"] = ids
	lines := []Row{}
	net, tax, paid, invoiced, received := int64(0), int64(0), int64(0), int64(0), int64(0)
	for _, l := range pOrderLines(db, r["id"]) {
		n := pValue(pInt(l["unit_cost_cents"]), pInt(l["quantity_milli"]))
		t := pInt(l["tax_amount_cents"])
		net = pAdd(net, n)
		tax = pAdd(tax, t)
		v := pFields(l, "id purchase_order_id procurement_line_id unit_cost_cents tax_amount_cents overage_reason")
		v["quantity"] = procFormatQuantity(pInt(l["quantity_milli"]))
		v["received_quantity"] = procFormatQuantity(pInt(l["received_quantity_milli"]))
		v["net_amount_cents"] = n
		v["line_amount_cents"] = pAdd(n, t)
		lines = append(lines, v)
	}
	payments, invoices, receipts := []Row{}, []Row{}, []Row{}
	for _, p := range pRows(db, pSQL("procurement", "_order_response", 2), r["id"]) {
		payments = append(payments, pPaymentResponse(db, p))
		if p["status"] == "active" {
			paid = pAdd(paid, pInt(p["amount_cents"]))
		}
	}
	for _, p := range pRows(db, pSQL("procurement", "_order_response", 3), r["id"]) {
		invoices = append(invoices, pInvoiceResponse(db, p))
		if p["status"] == "active" {
			invoiced = pAdd(invoiced, pInt(p["amount_cents"]))
		}
	}
	for _, p := range pRows(db, pSQL("procurement", "_order_response", 4), r["id"]) {
		response := pReceiptResponse(db, p)
		receipts = append(receipts, response)
		if p["status"] == "active" {
			for _, l := range response["lines"].([]Row) {
				received = pAdd(received, pInt(l["value_cents"]))
			}
		}
	}
	out["lines"] = lines
	out["net_amount_cents"] = net
	out["tax_amount_cents"] = tax
	out["ordered_amount_cents"] = pAdd(net, tax)
	out["paid_amount_cents"] = paid
	out["invoiced_amount_cents"] = invoiced
	out["received_amount_cents"] = received
	out["supplier_payments"] = payments
	out["supplier_invoices"] = invoices
	out["goods_receipts"] = receipts
	return out
}
