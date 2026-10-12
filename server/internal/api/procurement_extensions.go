package api

import (
	"fmt"
	"strings"
)

func pRegisterExtensions(s *Server) {
	pHandle(s, "POST /api/projects/{project_code}/purchase-orders/{order_id}/supplier-payments", true, 201, func(c *Context) any {
		r := pBody(c, "paid_on amount_cents payment_method reference_no allocations notes", "")
		allocations, amount := pAllocations(r)
		n := Row{"paid_on": pDate(r["paid_on"]), "amount_cents": amount, "payment_method": pText(r["payment_method"]), "reference_no": pOptional(r["reference_no"]), "allocations": allocations, "notes": pOptional(r["notes"])}
		p := pProject(c, false)
		pCanonicalProject(c, p)
		id := pID(c, "order_id")
		return pIdem(c, n, func(key, hash, stored string) Row {
			pActive(p)
			pPayableOrder(c, id, p["id"])
			pValidateAllocation(c, id, allocations, "payment")
			at := c.Timestamp()
			payment := pInsert(c.DB, pSQL("procurement_extensions", "create_supplier_payment", 0), id, n["paid_on"], amount, n["payment_method"], n["reference_no"], n["notes"], stored, hash, at, at)
			for _, a := range allocations {
				pExec(c.DB, pSQL("procurement_extensions", "create_supplier_payment", 1), payment, a["purchase_order_line_id"], a["amount_cents"])
			}
			return pPaymentResponse(c.DB, pOne(c.DB, "SELECT * FROM supplier_payments WHERE id=?", payment))
		}, "supplier_payment")
	})
	s.Handle("POST /api/projects/{project_code}/purchase-orders/{order_id}/supplier-invoices", func(c *Context) (any, error) {
		c.Status = 201
		r, batch, err := ReadAttachmentBody(c, "VALIDATION_ERROR")
		if err != nil {
			return nil, err
		}
		defer batch.Close()
		result, err := c.Tx(func(c *Context) (any, error) {
			return pCatch(c, func(c *Context) any {
				pRequireFields(r, "invoice_no invoiced_on amount_cents allocations document_version_ids", "")
				allocations, amount := pAllocations(r)
				n := Row{"invoice_no": pText(r["invoice_no"]), "invoiced_on": pDate(r["invoiced_on"]), "amount_cents": amount, "allocations": allocations, "document_version_ids": pIDs(r["document_version_ids"])}
				p := pProject(c, false)
				pCanonicalProject(c, p)
				id := pID(c, "order_id")
				return pIdem(c, batch.HashPayload(n), func(key, hash, stored string) Row {
					pActive(p)
					pPayableOrder(c, id, p["id"])
					pDocumentVersions(c, Str(p["project_code"]), n["document_version_ids"].([]int64))
					pValidateAllocation(c, id, allocations, "invoice")
					at := c.Timestamp()
					invoice := pInsert(c.DB, pSQL("procurement_extensions", "create_supplier_invoice", 0), id, n["invoice_no"], n["invoiced_on"], amount, stored, hash, at, at)
					for _, a := range allocations {
						pExec(c.DB, pSQL("procurement_extensions", "create_supplier_invoice", 1), invoice, a["purchase_order_line_id"], a["amount_cents"])
					}
					docs := []ManagedDocument{}
					for i, a := range batch.Attachments {
						docs = append(docs, ManagedDocument{Title: fmt.Sprintf("进项发票 %s 附件 %02d（发票记录 %d）", n["invoice_no"], i+1, invoice), ManagedFilename: ManagedFilename([]any{p["project_code"], "进项发票", n["invoice_no"], fmt.Sprintf("%02d", i+1)}, a.OriginalFilename, 2)})
					}
					uploaded, e := batch.Publish(c, Str(p["project_code"]), "invoice", docs, nil, at)
					pCheck(e)
					for _, d := range append(n["document_version_ids"].([]int64), uploaded...) {
						pExec(c.DB, pSQL("procurement_extensions", "create_supplier_invoice", 2), invoice, d)
					}
					return pInvoiceResponse(c.DB, pOne(c.DB, "SELECT * FROM supplier_invoices WHERE id=?", invoice))
				}, "supplier_invoice")
			})
		})
		return result, pUnique(err, "Supplier invoice already exists", "SUPPLIER_INVOICE_EXISTS")
	})
	pRegisterPaymentReversal(s, false)
	pRegisterPaymentReversal(s, true)
	pHandle(s, "POST /api/projects/{project_code}/goods-receipts/{receipt_id}/reverse", true, 200, func(c *Context) any {
		n := pReversalPayload(c)
		p := pProject(c, false)
		pCanonicalProject(c, p)
		id := pID(c, "receipt_id")
		return pIdem(c, n, func(key, hash, stored string) Row {
			pActive(p)
			receipt := pRequired(pOne(c.DB, pSQL("procurement_extensions", "_receipt_row", 0), id, p["id"]), "Goods receipt not found")
			if receipt["status"] != "active" {
				pConflict("Goods receipt is already reversed", "GOODS_RECEIPT_ALREADY_REVERSED")
			}
			pRevision(receipt, n["expected_revision"])
			at := c.Timestamp()
			for _, line := range pRows(c.DB, pSQL("procurement_extensions", "_reverse_receipt_inventory", 3), id) {
				item := pItem(c, line["inventory_item_id"])
				q, v := pInt(item["quantity_milli"])-pInt(line["quantity_milli"]), pInt(item["inventory_value_cents"])-pInt(line["value_cents"])
				if q < 0 || v < 0 || q == 0 && v != 0 {
					pConflict("Receipt reversal would make inventory negative", "RECEIPT_REVERSAL_INSUFFICIENT_INVENTORY")
				}
				pMovement(c, item["id"], p["id"], line["procurement_line_id"], "reversal", -pInt(line["quantity_milli"]), -pInt(line["value_cents"]), q, v, "goods_receipt_reversal", id, at[:10], n["reason"], at)
				pExec(c.DB, pSQL("procurement_extensions", "_reverse_receipt_inventory", 1), q, v, at, item["id"], item["revision"])
				if pExec(c.DB, pSQL("procurement_extensions", "_reverse_receipt_inventory", 2), line["quantity_milli"], line["purchase_order_line_id"], line["quantity_milli"]) != 1 {
					pCheck(fmt.Errorf("purchase order receipt balance is invalid"))
				}
			}
			pExec(c.DB, pSQL("procurement_extensions", "reverse_goods_receipt", 0), n["reason"], at, at, id, n["expected_revision"])
			pRefreshReceiptStatus(c, receipt["purchase_order_id"], at)
			return pReceiptResponse(c.DB, pOne(c.DB, "SELECT * FROM goods_receipts WHERE id=?", id))
		}, "goods_receipt")
	})
}
func pRegisterPaymentReversal(s *Server, invoice bool) {
	kind, plural, idField, detail := "payment", "supplier-payments", "payment_id", "Supplier payment"
	response := pPaymentResponse
	if invoice {
		kind, plural, idField, detail = "invoice", "supplier-invoices", "invoice_id", "Supplier invoice"
		response = pInvoiceResponse
	}
	pHandle(s, "POST /api/projects/{project_code}/"+plural+"/{"+idField+"}/reverse", true, 200, func(c *Context) any {
		n := pReversalPayload(c)
		p := pProject(c, false)
		pCanonicalProject(c, p)
		id := pID(c, idField)
		return pIdem(c, n, func(key, hash, stored string) Row {
			pActive(p)
			r := pRequired(pOne(c.DB, pSQL("procurement_extensions", "_"+kind+"_row", 0), id, p["id"]), detail+" not found")
			if r["status"] != "active" {
				pConflict(detail+" is already reversed", "SUPPLIER_"+strings.ToUpper(kind)+"_ALREADY_REVERSED")
			}
			pRevision(r, n["expected_revision"])
			at := c.Timestamp()
			pExec(c.DB, pSQL("procurement_extensions", "reverse_supplier_"+kind, 0), n["reason"], at, at, id, n["expected_revision"])
			return response(c.DB, pOne(c.DB, pSQL("procurement_extensions", "_"+kind+"_row", 0), id, p["id"]))
		}, "supplier_"+kind)
	})
}
func pAllocations(r Row) ([]Row, int64) {
	amount := pMoney(r["amount_cents"])
	if amount == 0 {
		pInvalid("Invalid supplier allocation")
	}
	seen := map[int64]bool{}
	out := []Row{}
	sum := int64(0)
	for _, a := range pLineArray(r["allocations"]) {
		pRequireFields(a, "purchase_order_line_id amount_cents", "")
		id := pPositive(a["purchase_order_line_id"])
		v := pMoney(a["amount_cents"])
		if seen[id] || v == 0 {
			pInvalid("Invalid supplier allocation")
		}
		seen[id] = true
		sum = pAdd(sum, v)
		out = append(out, Row{"purchase_order_line_id": id, "amount_cents": v})
	}
	if sum != amount {
		pInvalid("Invalid supplier allocation")
	}
	return out, amount
}
func pPayableOrder(c *Context, id, project any) Row {
	r := pOrder(c, id, project)
	if !pCommitted(r) {
		pConflict("Purchase order is not payable", "PURCHASE_ORDER_NOT_PAYABLE")
	}
	return r
}
func pValidateAllocation(c *Context, id any, allocations []Row, kind string) {
	if kind != "payment" && kind != "invoice" {
		panic("invalid allocation fact")
	}
	for _, a := range allocations {
		line := pOne(c.DB, "SELECT * FROM purchase_order_lines WHERE id=? AND purchase_order_id=?", a["purchase_order_line_id"], id)
		if line == nil {
			pInvalid("Invalid supplier " + kind + " payload")
		}
		q := fmt.Sprintf(`SELECT COALESCE(SUM(allocations.amount_cents),0) FROM supplier_%s_allocations allocations JOIN supplier_%ss facts ON facts.id=allocations.supplier_%s_id WHERE allocations.purchase_order_line_id=? AND facts.status='active'`, kind, kind, kind)
		used := pScalar(c.DB, q, a["purchase_order_line_id"])
		if pAdd(used, pInt(a["amount_cents"])) > pGross(line) {
			pConflict("Supplier "+kind+" exceeds the purchase order", strings.ToUpper(kind)+"_AMOUNT_EXCEEDED")
		}
	}
}
