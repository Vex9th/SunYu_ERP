package api

import (
	"crypto/sha256"
	"fmt"
	"math"
	"strings"
)

const pItemFields = "brand name model specification unit notes"

func pRegisterInventory(s *Server) {
	pHandle(s, "GET /api/inventory/items", false, 200, func(c *Context) any {
		page, size := pPage(c)
		clauses := []string{}
		args := []any{}
		if query := pSingle(c, "query"); query != nil {
			q := "%" + strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(*query) + "%"
			clauses = append(clauses, `(name LIKE ? ESCAPE '\' COLLATE NOCASE OR brand LIKE ? ESCAPE '\' COLLATE NOCASE OR model LIKE ? ESCAPE '\' COLLATE NOCASE)`)
			args = append(args, q, q, q)
		}
		status := "all"
		if v := pSingle(c, "status"); v != nil && *v != "" {
			status = *v
		}
		switch status {
		case "all":
		case "in_stock":
			clauses = append(clauses, "quantity_milli>0")
		case "out_of_stock":
			clauses = append(clauses, "quantity_milli=0")
		default:
			pInvalid("Invalid inventory status")
		}
		where := ""
		if len(clauses) > 0 {
			where = " WHERE " + strings.Join(clauses, " AND ")
		}
		total := pScalar(c.DB, "SELECT COUNT(*) FROM inventory_items"+where, args...)
		items := []Row{}
		for _, r := range pRows(c.DB, "SELECT * FROM inventory_items"+where+" ORDER BY name COLLATE NOCASE,brand COLLATE NOCASE,model COLLATE NOCASE,id LIMIT ? OFFSET ?", append(args, size, (page-1)*size)...) {
			items = append(items, pItemResponse(r))
		}
		return Row{"items": items, "total": total, "page": page, "page_size": size}
	})
	pHandle(s, "POST /api/inventory/items", true, 201, func(c *Context) any {
		r := pBody(c, pItemFields+" opening_quantity opening_unit_cost_cents", "")
		n := pNormalizeItem(r)
		q := int64(0)
		if r["opening_quantity"] != "0" {
			q = pQuantity(r["opening_quantity"], false)
		}
		var unit any
		if q > 0 || r["opening_unit_cost_cents"] != nil {
			unit = pMoney(r["opening_unit_cost_cents"])
		}
		pValue(pInt(unit), q)
		n["opening_quantity_milli"] = q
		n["opening_unit_cost_cents"] = unit
		return pIdem(c, n, func(key, hash, stored string) Row {
			at := c.Timestamp()
			value := pValue(pInt(unit), q)
			id := pInsert(c.DB, pSQL("inventory", "create_inventory_item", 0), n["brand"], n["name"], n["model"], n["specification"], n["unit"], n["notes"], q, value, stored, hash, at, at)
			if q > 0 {
				pMovement(c, id, nil, nil, "opening", q, value, q, value, "inventory_item", id, at[:10], "Opening balance", at)
			}
			return pItemResponse(pItem(c, id))
		}, "inventory_item")
	})
	pHandle(s, "GET /api/inventory/items/{item_id}", false, 200, func(c *Context) any {
		id := pID(c, "item_id")
		out := pItemResponse(pItem(c, id))
		movements := []Row{}
		for _, m := range pRows(c.DB, pSQL("inventory", "get_inventory_item", 0), id) {
			movements = append(movements, pMovementResponse(m))
		}
		out["movements"] = movements
		return out
	})
	pHandle(s, "PUT /api/inventory/items/{item_id}", true, 200, func(c *Context) any {
		r := pBody(c, pItemFields+" expected_revision", "")
		n := pNormalizeItem(r)
		id := pID(c, "item_id")
		pRevision(pItem(c, id), r["expected_revision"])
		pExec(c.DB, pSQL("inventory", "update_inventory_item", 0), n["brand"], n["name"], n["model"], n["specification"], n["unit"], n["notes"], c.Timestamp(), id, r["expected_revision"])
		return pItemResponse(pItem(c, id))
	})
	pHandle(s, "GET /api/inventory/items/{item_id}/movements", false, 200, func(c *Context) any {
		id := pID(c, "item_id")
		pItem(c, id)
		page, size := pPage(c)
		items := []Row{}
		for _, m := range pRows(c.DB, pSQL("inventory", "list_inventory_movements", 0), id, size, (page-1)*size) {
			items = append(items, pMovementResponse(m))
		}
		return Row{"items": items, "total": pScalar(c.DB, pSQL("inventory", "list_inventory_movements", 1), id), "page": page, "page_size": size}
	})
	pHandle(s, "POST /api/inventory/adjustments", true, 201, func(c *Context) any {
		r := pBody(c, "item_id quantity_delta unit_cost_cents reason occurred_on", "")
		q := pQuantity(r["quantity_delta"], true)
		var unit any
		if q > 0 {
			unit = pMoney(r["unit_cost_cents"])
			pValue(pInt(unit), q)
		} else if r["unit_cost_cents"] != nil {
			pInvalid("Invalid inventory payload")
		}
		n := Row{"item_id": pPositive(r["item_id"]), "quantity_delta_milli": q, "unit_cost_cents": unit, "reason": pText(r["reason"]), "occurred_on": pDate(r["occurred_on"])}
		return pIdem(c, n, func(key, hash, stored string) Row {
			if replay := pOne(c.DB, "SELECT * FROM inventory_adjustments WHERE idempotency_key=?", key); replay != nil {
				pSameHash(replay["request_hash"], hash)
				return pAdjustmentResponse(c.DB, replay)
			}
			item := pItem(c, n["item_id"])
			currentQ, currentV := pInt(item["quantity_milli"]), pInt(item["inventory_value_cents"])
			afterQ := pAdd(currentQ, q)
			if afterQ < 0 {
				pConflict("Insufficient inventory", "INSUFFICIENT_INVENTORY")
			}
			delta := int64(0)
			if q > 0 {
				delta = pValue(pInt(unit), q)
			} else if -q == currentQ {
				delta = -currentV
			} else {
				delta = -pRound(currentV, -q, currentQ)
			}
			afterV := pAdd(currentV, delta)
			if afterQ == 0 {
				afterV = 0
				delta = -currentV
			}
			at := c.Timestamp()
			id := pInsert(c.DB, pSQL("inventory", "create_inventory_adjustment", 0), n["item_id"], q, unit, delta, n["occurred_on"], n["reason"], key, hash, at)
			movement := pMovement(c, n["item_id"], nil, nil, "adjustment", q, delta, afterQ, afterV, "inventory_adjustment", id, Str(n["occurred_on"]), n["reason"], at)
			pExec(c.DB, pSQL("inventory", "create_inventory_adjustment", 1), movement, id)
			pBalance(c, n["item_id"], afterQ, afterV, at)
			return pAdjustmentResponse(c.DB, pOne(c.DB, "SELECT * FROM inventory_adjustments WHERE id=?", id))
		}, "inventory_adjustment")
	})
	pHandle(s, "POST /api/inventory/adjustments/{adjustment_id}/reverse", true, 200, func(c *Context) any {
		n := pReversalPayload(c)
		id := pID(c, "adjustment_id")
		return pIdem(c, n, func(key, hash, stored string) Row {
			adjustment := pRequired(pOne(c.DB, "SELECT * FROM inventory_adjustments WHERE id=?", id), "Inventory adjustment not found")
			if adjustment["status"] != "active" {
				pConflict("Inventory adjustment is already reversed", "INVENTORY_ADJUSTMENT_ALREADY_REVERSED")
			}
			pRevision(adjustment, n["expected_revision"])
			item := pItem(c, adjustment["inventory_item_id"])
			dq, dv := -pInt(adjustment["quantity_delta_milli"]), -pInt(adjustment["value_delta_cents"])
			q := pInventoryAdd(pInt(item["quantity_milli"]), dq, "INVENTORY_ADJUSTMENT_REVERSAL_OVERFLOW")
			v := pInventoryAdd(pInt(item["inventory_value_cents"]), dv, "INVENTORY_ADJUSTMENT_REVERSAL_OVERFLOW")
			if q < 0 || v < 0 {
				pConflict("Inventory is insufficient to reverse this adjustment", "INVENTORY_ADJUSTMENT_REVERSAL_INSUFFICIENT_INVENTORY")
			}
			if q == 0 && v != 0 {
				pConflict("Inventory adjustment reversal exceeds storage capacity", "INVENTORY_ADJUSTMENT_REVERSAL_OVERFLOW")
			}
			at := c.Timestamp()
			movement := pMovement(c, item["id"], nil, nil, "reversal", dq, dv, q, v, "inventory_adjustment_reversal", id, at[:10], n["reason"], at)
			pExec(c.DB, pSQL("inventory", "reverse_inventory_adjustment", 0), n["reason"], at, movement, id, n["expected_revision"])
			pBalance(c, item["id"], q, v, at)
			return pAdjustmentResponse(c.DB, pOne(c.DB, "SELECT * FROM inventory_adjustments WHERE id=?", id))
		}, "inventory_adjustment")
	})
	pHandle(s, "POST /api/projects/{project_code}/inventory-issues", true, 201, func(c *Context) any {
		n := pNormalizeIssue(pBody(c, "issued_on worker_id lines notes", ""))
		return pIdem(c, n, func(key, hash, stored string) Row {
			project := pProject(c, true)
			if n["worker_id"] != nil {
				pRequired(pOne(c.DB, "SELECT id FROM workers WHERE id=?", n["worker_id"]), "Worker not found")
			}
			at := c.Timestamp()
			id := pInsert(c.DB, pSQL("inventory", "create_project_issue", 0), project["id"], n["issued_on"], n["worker_id"], n["notes"], stored, hash, at, at)
			total := int64(0)
			for _, line := range n["lines"].([]Row) {
				total = pAdd(total, pIssueLine(c, id, project["id"], line, Str(n["issued_on"]), at))
			}
			pExec(c.DB, pSQL("inventory", "create_project_issue", 1), total, id)
			return pIssueResponse(c.DB, pOne(c.DB, "SELECT * FROM inventory_issues WHERE id=?", id))
		}, "inventory_issue")
	})
	pHandle(s, "POST /api/projects/{project_code}/inventory-issues/{issue_id}/reverse", true, 200, func(c *Context) any {
		n := pReversalPayload(c)
		id := pID(c, "issue_id")
		return pIdem(c, n, func(key, hash, stored string) Row {
			project := pProject(c, true)
			issue := pRequired(pOne(c.DB, "SELECT * FROM inventory_issues WHERE id=? AND project_id=?", id, project["id"]), "Inventory issue not found")
			if issue["status"] != "active" {
				pConflict("Inventory issue is already reversed", "INVENTORY_ISSUE_ALREADY_REVERSED")
			}
			pRevision(issue, n["expected_revision"])
			at := c.Timestamp()
			for _, line := range pRows(c.DB, pSQL("inventory", "_reverse_issue_inventory", 0), id) {
				item := pItem(c, line["inventory_item_id"])
				q, v := pInventoryAdd(pInt(item["quantity_milli"]), pInt(line["quantity_milli"]), "INVENTORY_ISSUE_REVERSAL_OVERFLOW"), pInventoryAdd(pInt(item["inventory_value_cents"]), pInt(line["cost_cents"]), "INVENTORY_ISSUE_REVERSAL_OVERFLOW")
				pMovement(c, item["id"], project["id"], line["procurement_line_id"], "reversal", pInt(line["quantity_milli"]), pInt(line["cost_cents"]), q, v, "inventory_issue_reversal", id, at[:10], n["reason"], at)
				pBalance(c, item["id"], q, v, at)
			}
			pExec(c.DB, pSQL("inventory", "reverse_project_issue", 0), at, id, n["expected_revision"])
			return pIssueResponse(c.DB, pOne(c.DB, "SELECT * FROM inventory_issues WHERE id=?", id))
		}, "inventory_issue")
	})
}
func pInventoryAdd(a, b int64, code string) int64 {
	if b > 0 && a > math.MaxInt64-b || b < 0 && a < math.MinInt64-b {
		pConflict("Inventory reversal exceeds storage capacity", code)
	}
	return a + b
}
func pNormalizeItem(r Row) Row {
	return Row{"brand": pOptional(r["brand"]), "name": pText(r["name"]), "model": pOptional(r["model"]), "specification": pOptional(r["specification"]), "unit": pText(r["unit"]), "notes": pOptional(r["notes"])}
}
func pItem(c *Context, id any) Row {
	return pRequired(pOne(c.DB, "SELECT * FROM inventory_items WHERE id=?", id), "Inventory item not found")
}
func pMovement(c *Context, item, project, line any, kind string, dq, dv, q, v int64, source string, id any, date string, reason any, at string) int64 {
	return pInsert(c.DB, pSQL("inventory", "_insert_movement", 0), item, project, line, kind, dq, dv, q, v, source, id, date, reason, at)
}
func pBalance(c *Context, id any, q, v int64, at string) {
	if pExec(c.DB, pSQL("inventory", "_update_balance", 0), q, v, at, id) != 1 {
		pCheck(fmt.Errorf("inventory balance update failed"))
	}
}
func pItemResponse(r Row) Row {
	out := pFields(r, "id brand name model specification unit inventory_value_cents notes revision created_at updated_at")
	q := pInt(r["quantity_milli"])
	out["quantity"] = procFormatQuantity(q)
	average := int64(0)
	if q > 0 {
		average = pRound(pInt(r["inventory_value_cents"]), 1000, q)
	}
	out["average_unit_cost_cents"] = average
	return out
}
func pMovementResponse(r Row) Row {
	out := pFields(r, "id inventory_item_id project_id procurement_line_id movement_type value_delta_cents value_after_cents source_type source_id occurred_on reason created_at project_code issue_status issue_revision adjustment_status adjustment_revision")
	out["quantity_delta"] = procFormatQuantity(pInt(r["quantity_delta_milli"]))
	out["quantity_after"] = procFormatQuantity(pInt(r["quantity_after_milli"]))
	return out
}
func pAdjustmentResponse(db DBTX, r Row) Row {
	out := pFields(r, "id inventory_item_id unit_cost_cents value_delta_cents occurred_on reason status revision reversal_reason reversed_at created_at")
	out["quantity_delta"] = procFormatQuantity(pInt(r["quantity_delta_milli"]))
	out["movement"] = pMovementResponse(pOne(db, "SELECT * FROM inventory_movements WHERE id=?", r["movement_id"]))
	out["reversal_movement"] = nil
	if r["reversal_movement_id"] != nil {
		out["reversal_movement"] = pMovementResponse(pOne(db, "SELECT * FROM inventory_movements WHERE id=?", r["reversal_movement_id"]))
	}
	return out
}
func pIssueResponse(db DBTX, r Row) Row {
	out := pFields(r, "id project_id issued_on worker_id notes status total_cost_cents revision created_at updated_at")
	lines := []Row{}
	for _, l := range pRows(db, pSQL("inventory", "_issue_response", 0), r["id"]) {
		v := pFields(l, "id inventory_item_id procurement_line_id cost_cents movement_id")
		v["quantity"] = procFormatQuantity(pInt(l["quantity_milli"]))
		lines = append(lines, v)
	}
	out["lines"] = lines
	return out
}
func pReceiptItem(c *Context, line Row, at string) Row {
	if line["inventory_item_id"] != nil {
		item := pItem(c, line["inventory_item_id"])
		if pSameIdentity(item, line) {
			return item
		}
	}
	matches := pRows(c.DB, pSQL("inventory", "ensure_receipt_inventory_item", 2), line["name"], line["unit"], line["brand"], line["model"], line["specification"])
	var item Row
	if len(matches) == 1 {
		item = matches[0]
	} else {
		stable := fmt.Sprintf("procurement-line-%d", pInt(line["procurement_line_id"]))
		hash := fmt.Sprintf("%x", sha256.Sum256([]byte(stable)))
		id := pInsert(c.DB, pSQL("inventory", "ensure_receipt_inventory_item", 1), line["brand"], line["name"], line["model"], line["specification"], line["unit"], stable, hash, at, at)
		item = pItem(c, id)
	}
	pExec(c.DB, pSQL("inventory", "ensure_receipt_inventory_item", 0), item["id"], line["procurement_line_id"])
	return item
}
func pNormalizeIssue(r Row) Row {
	lines := []Row{}
	seen := map[string]bool{}
	for _, l := range pLineArray(r["lines"]) {
		pRequireFields(l, "inventory_item_id procurement_line_id quantity", "")
		item := pPositive(l["inventory_item_id"])
		var line any
		if l["procurement_line_id"] != nil {
			line = pPositive(l["procurement_line_id"])
		}
		identity := fmt.Sprintf("%d:%v", item, line)
		if seen[identity] {
			pInvalid("Invalid inventory issue payload")
		}
		seen[identity] = true
		lines = append(lines, Row{"inventory_item_id": item, "procurement_line_id": line, "quantity_milli": pQuantity(l["quantity"], false)})
	}
	var worker any
	if r["worker_id"] != nil {
		worker = pPositive(r["worker_id"])
	}
	return Row{"issued_on": pDate(r["issued_on"]), "worker_id": worker, "lines": lines, "notes": pOptional(r["notes"])}
}
func pIssueLine(c *Context, id int64, project any, line Row, date, at string) int64 {
	item := pItem(c, line["inventory_item_id"])
	q := pInt(line["quantity_milli"])
	currentQ, currentV := pInt(item["quantity_milli"]), pInt(item["inventory_value_cents"])
	if q > currentQ {
		pConflict("Insufficient inventory", "INSUFFICIENT_INVENTORY")
	}
	if line["procurement_line_id"] != nil {
		proc := pOne(c.DB, pSQL("inventory", "_post_issue_line", 1), line["procurement_line_id"], project)
		if proc == nil || pInt(proc["inventory_item_id"]) != pInt(item["id"]) {
			pInvalid("Invalid inventory issue payload")
		}
		used := pScalar(c.DB, pSQL("inventory", "_post_issue_line", 2), line["procurement_line_id"])
		if pAdd(used, q) > pInt(proc["quantity_milli"]) {
			pConflict("Issue quantity exceeds procurement requirement", "PROCUREMENT_USAGE_EXCEEDED")
		}
	}
	cost := currentV
	if q != currentQ {
		cost = pRound(currentV, q, currentQ)
	}
	afterQ, afterV := currentQ-q, currentV-cost
	if afterQ == 0 {
		afterV = 0
		cost = currentV
	}
	movement := pMovement(c, item["id"], project, line["procurement_line_id"], "project_issue", -q, -cost, afterQ, afterV, "inventory_issue", id, date, nil, at)
	pExec(c.DB, pSQL("inventory", "_post_issue_line", 0), id, item["id"], line["procurement_line_id"], q, cost, movement)
	pBalance(c, item["id"], afterQ, afterV, at)
	return cost
}
