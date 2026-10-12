package api

import "fmt"

const pOrderFields = "order_no supplier_company_id ordered_on expected_delivery_on lines notes document_version_ids"

func pRegisterOrders(s *Server) {
	const base = "/api/projects/{project_code}/purchase-orders"
	pHandle(s, "GET /api/projects/{project_code}/purchase-order-number-preview", false, 200, func(c *Context) any {
		supplier := pSingle(c, "supplier_company_id")
		date := pSingle(c, "ordered_on")
		if supplier == nil {
			pInvalid("Invalid supplier_company_id")
		}
		id, e := PositiveID(*supplier)
		if e != nil {
			pInvalid("Invalid identifier")
		}
		if date == nil {
			pInvalid("Invalid ordered_on")
		}
		d := pDate(*date)
		project := pProject(c, true)
		company := pRequired(pOne(c.DB, "SELECT id,name FROM companies WHERE id=?", id), "Company not found")
		return Row{"order_no": pNextOrderNumber(c.DB, project, company, d)}
	})
	pHandle(s, "GET "+base, false, 200, func(c *Context) any {
		project := pProject(c, false)
		page, size := pPage(c)
		where := "project_id=?"
		args := []any{project["id"]}
		if status := pSingle(c, "status"); status != nil {
			switch *status {
			case "draft", "confirmed", "partially_received", "received", "cancelled":
			default:
				pInvalid("Invalid purchase order status")
			}
			where += " AND status=?"
			args = append(args, *status)
		}
		total := pScalar(c.DB, "SELECT COUNT(*) FROM purchase_orders WHERE "+where, args...)
		rows := pRows(c.DB, "SELECT * FROM purchase_orders WHERE "+where+" ORDER BY ordered_on DESC,id DESC LIMIT ? OFFSET ?", append(args, size, (page-1)*size)...)
		items := []Row{}
		for _, r := range rows {
			items = append(items, pOrderResponse(c.DB, r, project["project_code"]))
		}
		return Row{"items": items, "total": total, "page": page, "page_size": size}
	})
	pHandle(s, "GET "+base+"/{order_id}", false, 200, func(c *Context) any {
		p := pProject(c, false)
		return pOrderResponse(c.DB, pOrder(c, pID(c, "order_id"), p["id"]), p["project_code"])
	})
	s.Handle("POST "+base, func(c *Context) (any, error) {
		c.Status = 201
		payload, batch, err := ReadAttachmentBody(c, "VALIDATION_ERROR")
		if err != nil {
			return nil, err
		}
		defer batch.Close()
		result, err := c.Tx(func(c *Context) (any, error) {
			return pCatch(c, func(c *Context) any {
				n := pNormalizeOrder(payload, true)
				project := pProject(c, false)
				pCanonicalProject(c, project)
				return pIdem(c, batch.HashPayload(n), func(key, hash, stored string) Row {
					pActive(project)
					supplier := pRequired(pOne(c.DB, "SELECT id,name FROM companies WHERE id=?", n["supplier_company_id"]), "Company not found")
					if n["order_no"] == "" {
						n["order_no"] = pNextOrderNumber(c.DB, project, supplier, Str(n["ordered_on"]))
					}
					pValidateOrder(c, project, n)
					at := c.Timestamp()
					id := pInsert(c.DB, pSQL("procurement", "create_purchase_order", 0), project["id"], n["order_no"], n["supplier_company_id"], n["ordered_on"], n["expected_delivery_on"], n["notes"], n["tax_rate_bps"], stored, hash, at, at)
					pInsertOrderLines(c, id, n["lines"].([]Row), at)
					docs := make([]ManagedDocument, 0, len(batch.Attachments))
					for i, a := range batch.Attachments {
						docs = append(docs, ManagedDocument{Title: fmt.Sprintf("采购合同 %s 附件 %02d（采购单记录 %d）", n["order_no"], i+1, id), ManagedFilename: ManagedFilename([]any{project["project_code"], "采购合同", n["order_no"], CompactISODate(Str(n["ordered_on"])), fmt.Sprintf("%02d", i+1)}, a.OriginalFilename, 3)})
					}
					uploaded, e := batch.Publish(c, Str(project["project_code"]), "procurement_contract", docs, n["notes"], at)
					pCheck(e)
					for _, d := range append(n["document_version_ids"].([]int64), uploaded...) {
						pExec(c.DB, pSQL("procurement", "create_purchase_order", 2), id, d)
					}
					return pOrderResponse(c.DB, pOrder(c, id, project["id"]), project["project_code"])
				}, "purchase_order")
			})
		})
		return result, pUnique(err, "Purchase order already exists", "PURCHASE_ORDER_EXISTS")
	})
	s.Handle("PUT "+base+"/{order_id}", func(c *Context) (any, error) {
		result, err := c.Tx(func(c *Context) (any, error) {
			return pCatch(c, func(c *Context) any {
				r := pBody(c, pOrderFields+" expected_revision", "tax_rate_bps")
				revision := pPositive(r["expected_revision"])
				delete(r, "expected_revision")
				n := pNormalizeOrder(r, false)
				project := pProject(c, true)
				id := pID(c, "order_id")
				order := pOrder(c, id, project["id"])
				if order["status"] != "draft" {
					pConflict("Purchase order is not editable", "PURCHASE_ORDER_NOT_EDITABLE")
				}
				pRevision(order, revision)
				if _, ok := r["tax_rate_bps"]; !ok {
					r["tax_rate_bps"] = order["tax_rate_bps"]
					n = pNormalizeOrder(r, false)
				}
				pValidateOrder(c, project, n)
				at := c.Timestamp()
				pExec(c.DB, pSQL("procurement_extensions", "update_purchase_order", 0), n["order_no"], n["supplier_company_id"], n["ordered_on"], n["expected_delivery_on"], n["notes"], n["tax_rate_bps"], at, id, revision)
				pExec(c.DB, pSQL("procurement_extensions", "update_purchase_order", 1), id)
				pExec(c.DB, pSQL("procurement_extensions", "update_purchase_order", 2), id)
				pInsertOrderLines(c, id, n["lines"].([]Row), at)
				for _, d := range n["document_version_ids"].([]int64) {
					pExec(c.DB, pSQL("procurement_extensions", "update_purchase_order", 3), id, d)
				}
				return pOrderResponse(c.DB, pOrder(c, id, project["id"]), project["project_code"])
			})
		})
		return result, pUnique(err, "Purchase order already exists", "PURCHASE_ORDER_EXISTS")
	})
	pHandle(s, "POST "+base+"/{order_id}/confirm", true, 200, func(c *Context) any {
		n := pBody(c, "expected_revision", "")
		n["expected_revision"] = pPositive(n["expected_revision"])
		id := pID(c, "order_id")
		return pIdem(c, n, func(key, hash, stored string) Row {
			project := pProject(c, true)
			order := pOrder(c, id, project["id"])
			if order["confirm_idempotency_key"] == key {
				pSameHash(order["confirm_request_hash"], hash)
				return pOrderResponse(c.DB, order, project["project_code"])
			}
			if order["status"] != "draft" {
				pConflict("Purchase order cannot be confirmed", "PURCHASE_ORDER_NOT_CONFIRMABLE")
			}
			pRevision(order, n["expected_revision"])
			for _, l := range pOrderLines(c.DB, id) {
				prior := pScalar(c.DB, pSQL("procurement", "confirm_purchase_order", 1), l["procurement_line_id"])
				required := pScalar(c.DB, pSQL("procurement", "confirm_purchase_order", 2), l["procurement_line_id"])
				if pAdd(prior, pInt(l["quantity_milli"])) > required && l["overage_reason"] == nil {
					pConflict("Over-ordering requires a reason", "OVER_ORDER_REASON_REQUIRED")
				}
			}
			at := c.Timestamp()
			pExec(c.DB, pSQL("procurement", "confirm_purchase_order", 0), at, stored, hash, at, id)
			return pOrderResponse(c.DB, pOrder(c, id, project["id"]), project["project_code"])
		}, "purchase_order")
	})
	pHandle(s, "POST "+base+"/{order_id}/cancel", true, 200, func(c *Context) any {
		n := pReversalPayload(c)
		p := pProject(c, false)
		pCanonicalProject(c, p)
		id := pID(c, "order_id")
		return pIdem(c, n, func(key, hash, stored string) Row {
			pActive(p)
			order := pOrder(c, id, p["id"])
			if order["status"] != "draft" && order["status"] != "confirmed" {
				pConflict("Purchase order cannot be cancelled", "PURCHASE_ORDER_NOT_CANCELLABLE")
			}
			pRevision(order, n["expected_revision"])
			if pScalar(c.DB, pSQL("procurement_extensions", "_order_has_active_facts", 0), id, id, id) != 0 {
				pConflict("Purchase order has active business records", "PURCHASE_ORDER_HAS_ACTIVE_FACTS")
			}
			at := c.Timestamp()
			pExec(c.DB, pSQL("procurement_extensions", "cancel_purchase_order", 0), at, n["reason"], at, id, n["expected_revision"])
			return pOrderResponse(c.DB, pOrder(c, id, p["id"]), p["project_code"])
		}, "purchase_order")
	})
	pHandle(s, "POST "+base+"/{order_id}/goods-receipts", true, 201, func(c *Context) any {
		n := pNormalizeReceipt(pBody(c, "received_on warehouse_name lines notes", ""))
		id := pID(c, "order_id")
		return pIdem(c, n, func(key, hash, stored string) Row {
			p := pProject(c, true)
			order := pOrder(c, id, p["id"])
			if !pCommitted(order) {
				pConflict("Purchase order cannot receive goods", "PURCHASE_ORDER_NOT_RECEIVABLE")
			}
			at := c.Timestamp()
			receipt := pInsert(c.DB, pSQL("procurement", "create_goods_receipt", 0), id, n["received_on"], n["warehouse_name"], n["notes"], stored, hash, at, at)
			for _, l := range n["lines"].([]Row) {
				line := pOne(c.DB, pSQL("procurement", "create_goods_receipt", 4), l["purchase_order_line_id"], id)
				if line == nil {
					pInvalid("Invalid goods receipt payload")
				}
				q := pInt(l["quantity_milli"])
				if pAdd(pInt(line["received_quantity_milli"]), q) > pInt(line["quantity_milli"]) {
					pConflict("Receipt quantity exceeds ordered quantity", "RECEIPT_QUANTITY_EXCEEDED")
				}
				item := pReceiptItem(c, line, at)
				value := pValue(pInt(line["unit_cost_cents"]), q)
				if order["tax_rate_bps"] != nil {
					received := pScalar(c.DB, pSQL("procurement", "_receipt_line_value", 0), line["id"])
					var e error
					value, e = procReceiptCost(pGross(line), pInt(line["quantity_milli"]), pInt(line["received_quantity_milli"]), received, q)
					pCheck(e)
				}
				afterQ, afterV := pAdd(pInt(item["quantity_milli"]), q), pAdd(pInt(item["inventory_value_cents"]), value)
				movement := pMovement(c, item["id"], p["id"], line["procurement_line_id"], "goods_receipt", q, value, afterQ, afterV, "goods_receipt", receipt, Str(n["received_on"]), nil, at)
				pBalance(c, item["id"], afterQ, afterV, at)
				pExec(c.DB, pSQL("procurement", "create_goods_receipt", 1), receipt, line["id"], item["id"], q, value, movement)
				pExec(c.DB, pSQL("procurement", "create_goods_receipt", 2), q, line["id"])
			}
			pRefreshReceiptStatus(c, id, at)
			return pReceiptResponse(c.DB, pOne(c.DB, "SELECT * FROM goods_receipts WHERE id=?", receipt))
		}, "goods_receipt")
	})
}
func pCommitted(order Row) bool {
	switch order["status"] {
	case "confirmed", "partially_received", "received":
		return true
	}
	return false
}
func pValidateOrder(c *Context, project, n Row) {
	pRequired(pOne(c.DB, "SELECT id FROM companies WHERE id=?", n["supplier_company_id"]), "Company not found")
	pDocumentVersions(c, Str(project["project_code"]), n["document_version_ids"].([]int64))
	for _, l := range n["lines"].([]Row) {
		line := pConfirmedLine(c, l["procurement_line_id"], project["id"])
		if pInt(l["quantity_milli"]) > pInt(line["quantity_milli"]) && l["overage_reason"] == nil {
			pConflict("Over-ordering requires a reason", "OVER_ORDER_REASON_REQUIRED")
		}
	}
}
func pInsertOrderLines(c *Context, id int64, lines []Row, at string) {
	for _, l := range lines {
		pExec(c.DB, pSQL("procurement_extensions", "_insert_order_lines", 0), id, l["procurement_line_id"], l["quantity_milli"], l["unit_cost_cents"], pInt(l["tax_amount_cents"]), l["overage_reason"], at)
	}
}
func pNormalizeReceipt(r Row) Row {
	lines := []Row{}
	seen := map[int64]bool{}
	for _, l := range pLineArray(r["lines"]) {
		pRequireFields(l, "purchase_order_line_id quantity", "")
		id := pPositive(l["purchase_order_line_id"])
		if seen[id] {
			pInvalid("Invalid goods receipt payload")
		}
		seen[id] = true
		lines = append(lines, Row{"purchase_order_line_id": id, "quantity_milli": pQuantity(l["quantity"], false)})
	}
	return Row{"received_on": pDate(r["received_on"]), "warehouse_name": pText(r["warehouse_name"]), "lines": lines, "notes": pOptional(r["notes"])}
}
func pRefreshReceiptStatus(c *Context, id any, at string) {
	totals := pOne(c.DB, "SELECT COALESCE(SUM(quantity_milli),0) AS ordered,COALESCE(SUM(received_quantity_milli),0) AS received FROM purchase_order_lines WHERE purchase_order_id=?", id)
	status := "partially_received"
	if pInt(totals["received"]) == 0 {
		status = "confirmed"
	} else if pInt(totals["received"]) == pInt(totals["ordered"]) {
		status = "received"
	}
	pExec(c.DB, "UPDATE purchase_orders SET status=?,revision=revision+1,updated_at=? WHERE id=?", status, at, id)
}
func pReversalPayload(c *Context) Row {
	r := pBody(c, "reason expected_revision", "")
	return Row{"reason": pText(r["reason"]), "expected_revision": pPositive(r["expected_revision"])}
}
