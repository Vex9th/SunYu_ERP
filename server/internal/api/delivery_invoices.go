package api

import (
	"fmt"
	"golang.org/x/text/cases"
	"strings"
	"time"
)

func dlInvoiceNumber(c *Context, number any, exclude int64) {
	if number == nil {
		return
	}
	fold := cases.Fold()
	normalized := fold.String(strings.TrimSpace(Str(number)))
	for _, r := range dRows(c.DB, "SELECT id,invoice_number FROM project_invoices WHERE status<>'void' AND invoice_number IS NOT NULL") {
		if dI(r["id"]) != exclude && fold.String(strings.TrimSpace(Str(r["invoice_number"]))) == normalized {
			e := E(409, "Invoice number is already used by another active record", "INVOICE_NUMBER_CONFLICT")
			e.FieldErrors = Row{"invoice_number": "must be unique among non-voided invoices"}
			panic(dFailure{e})
		}
	}
}
func dlListInvoices(c *Context) any {
	p := dProject(c, false)
	where := " WHERE project_id=?"
	args := []any{p["id"]}
	for _, x := range []struct{ name, allowed string }{{"invoice_type", dlInvoiceTypes + "|all"}, {"status", "planned|requested|recorded|void|all"}} {
		v := dEnumQuery(c, x.name, "INVALID_INVOICE_FILTER", x.allowed, "all")
		if v != "all" {
			where += " AND " + x.name + "=?"
			args = append(args, v)
		}
	}
	return dPaged(c, "SELECT * FROM project_invoices"+where+" ORDER BY id DESC", "SELECT count(*) total FROM project_invoices"+where, args, func(r Row) Row { return dlResponse(c, r, p, "invoice") })
}
func dlCreateInvoice(c *Context) any {
	r, b := dlRead(c, dlInvoiceFields, "INVALID_INVOICE_PAYLOAD")
	defer b.Close()
	p := dlInvoicePayload(r, false)
	return dlScoped(c, b.HashPayload(p), 201, "invoice", "invoices", func(tx *Context, proj Row) Row {
		dlInvoiceNumber(tx, p["invoice_number"], 0)
		ids := p["document_version_ids"].([]int64)
		dlValidateDocuments(tx, proj, ids)
		id := dInsert(tx.DB, "INSERT INTO project_invoices(project_id,invoice_type,status,requested_on,recorded_on,invoice_number,amount_cents,counterparty_name,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", proj["id"], p["invoice_type"], p["status"], p["requested_on"], p["recorded_on"], p["invoice_number"], p["amount_cents"], p["counterparty_name"], p["notes"], tx.Timestamp(), tx.Timestamp())
		identity := Str(p["invoice_number"])
		if identity == "" {
			date := Str(p["recorded_on"])
			if date == "" {
				date = Str(p["requested_on"])
			}
			if date == "" {
				date = tx.S.Now().In(time.FixedZone("Asia/Shanghai", 8*3600)).Format("2006-01-02")
			}
			identity = CompactISODate(date)
		}
		ids = append(ids, dlPublish(tx, proj, b, "invoice", "销项发票", identity, "销项发票 "+identity+" 附件 %02d"+fmt.Sprintf("（发票记录 %d）", id), 0, p["notes"])...)
		dlReplaceLinks(tx, proj, "invoice", id, ids)
		return dlResponse(tx, dlOwn(tx, "project_invoices", proj, id), proj, "invoice")
	})
}
func dlUpdateInvoice(c *Context) any {
	id := dID(c, "invoice_id")
	code := "INVALID_INVOICE_PAYLOAD"
	raw := dBody(c, dlInvoiceFields+" expected_revision", code)
	deferred := raw["status"] == "recorded" && (raw["recorded_on"] == nil || raw["invoice_number"] == nil || raw["amount_cents"] == nil)
	var p Row
	rev := dInteger(raw["expected_revision"], "expected_revision", code, 1)
	if !deferred {
		p = dlInvoicePayload(raw, true)
	}
	return dTx(c, func(tx *Context) any {
		proj := dProject(tx, true)
		cur := dlOwn(tx, "project_invoices", proj, id)
		dRevision(cur, rev)
		if cur["status"] == "void" {
			dFail(409, "Voided invoice cannot be edited", "INVOICE_VOID")
		}
		if cur["status"] == "recorded" && deferred {
			dFail(409, "Recorded invoice must be voided before formal fields can change", "INVOICE_RECORDED")
		}
		if p == nil {
			p = dlInvoicePayload(raw, true)
		}
		if cur["status"] == "recorded" {
			for _, f := range []string{"status", "recorded_on", "invoice_number", "amount_cents"} {
				if !dEqual(cur[f], p[f]) {
					dFail(409, "Recorded invoice must be voided before formal fields can change", "INVOICE_RECORDED")
				}
			}
		}
		dlInvoiceNumber(tx, p["invoice_number"], id)
		ids := p["document_version_ids"].([]int64)
		dlValidateDocuments(tx, proj, ids)
		dExec(tx.DB, "UPDATE project_invoices SET invoice_type=?,status=?,requested_on=?,recorded_on=?,invoice_number=?,amount_cents=?,counterparty_name=?,notes=?,revision=revision+1,updated_at=? WHERE id=?", p["invoice_type"], p["status"], p["requested_on"], p["recorded_on"], p["invoice_number"], p["amount_cents"], p["counterparty_name"], p["notes"], tx.Timestamp(), id)
		dlReplaceLinks(tx, proj, "invoice", id, ids)
		return dlResponse(tx, dlOwn(tx, "project_invoices", proj, id), proj, "invoice")
	})
}
func dlVoidInvoice(c *Context) any {
	id := dID(c, "invoice_id")
	p := soVoidPayload(c, "INVALID_INVOICE_VOID")
	return dlScoped(c, p, 200, "invoice", fmt.Sprintf("invoices/%d/void", id), func(tx *Context, proj Row) Row {
		cur := dlOwn(tx, "project_invoices", proj, id)
		dRevision(cur, p["expected_revision"])
		if cur["status"] == "void" {
			dFail(409, "Invoice is already void", "INVOICE_VOID")
		}
		dExec(tx.DB, "UPDATE project_invoices SET status='void',void_reason=?,revision=revision+1,updated_at=? WHERE id=?", p["reason"], tx.Timestamp(), id)
		return dlResponse(tx, dlOwn(tx, "project_invoices", proj, id), proj, "invoice")
	})
}
func dlCoverage(c *Context, proj, p Row) int64 {
	under := dRow(c.DB, "SELECT id FROM warranties WHERE project_id=? AND starts_on<=? AND ends_on>=?", proj["id"], p["reported_on"], p["reported_on"]) != nil
	if p["coverage_type"] == "warranty" && !under {
		e := E(409, "Warranty coverage does not match the reported date", "WARRANTY_COVERAGE_MISMATCH")
		e.FieldErrors = Row{"coverage_type": "cannot be warranty when the reported date is outside warranty"}
		panic(dFailure{e})
	}
	if under {
		return 1
	}
	return 0
}
func dlCreateAfter(c *Context) any {
	p := dlAfterPayload(dBody(c, dlAfterFields, "INVALID_AFTER_SALES_PAYLOAD"), false)
	return dlScoped(c, p, 201, "after_sales", "after-sales", func(tx *Context, proj Row) Row {
		under := dlCoverage(tx, proj, p)
		id := dInsert(tx.DB, "INSERT INTO after_sales_cases(project_id,reported_on,service_on,reason,contact_name,contact_phone,coverage_type,notes,is_under_warranty,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", proj["id"], p["reported_on"], p["service_on"], p["reason"], p["contact_name"], p["contact_phone"], p["coverage_type"], p["notes"], under, tx.Timestamp(), tx.Timestamp())
		return dlResponse(tx, dlOwn(tx, "after_sales_cases", proj, id), proj, "after_sales")
	})
}
func dlUpdateAfter(c *Context) any {
	id := dID(c, "case_id")
	p := dlAfterPayload(dBody(c, dlAfterFields+" expected_revision", "INVALID_AFTER_SALES_PAYLOAD"), true)
	return dTx(c, func(tx *Context) any {
		proj := dProject(tx, true)
		cur := dlOwn(tx, "after_sales_cases", proj, id)
		dRevision(cur, p["expected_revision"])
		if cur["status"] == "completed" || cur["status"] == "cancelled" {
			dFail(409, "Closed after-sales case cannot be edited", "AFTER_SALES_CLOSED")
		}
		under := dlCoverage(tx, proj, p)
		dExec(tx.DB, "UPDATE after_sales_cases SET reported_on=?,service_on=?,reason=?,contact_name=?,contact_phone=?,coverage_type=?,notes=?,is_under_warranty=?,revision=revision+1,updated_at=? WHERE id=?", p["reported_on"], p["service_on"], p["reason"], p["contact_name"], p["contact_phone"], p["coverage_type"], p["notes"], under, tx.Timestamp(), id)
		return dlResponse(tx, dlOwn(tx, "after_sales_cases", proj, id), proj, "after_sales")
	})
}
func dlTransitionAfter(c *Context) any {
	id := dID(c, "case_id")
	code := "INVALID_AFTER_SALES_TRANSITION"
	r := dBody(c, "to_status effective_at resolution reason expected_revision", code)
	p := Row{"to_status": dEnum(r["to_status"], "to_status", code, dlAfterStates), "effective_at": dDatetime(r["effective_at"], "effective_at", code, false), "resolution": dText(r["resolution"], "resolution", code, false), "reason": dText(r["reason"], "reason", code, false), "expected_revision": dInteger(r["expected_revision"], "expected_revision", code, 1)}
	if p["to_status"] == "completed" && p["resolution"] == nil {
		dInvalid(code, "resolution", "is required when completing a case")
	}
	if p["to_status"] == "cancelled" && p["reason"] == nil {
		dInvalid(code, "reason", "is required when cancelling a case")
	}
	return dlScoped(c, p, 200, "after_sales", fmt.Sprintf("after-sales/%d/transition", id), func(tx *Context, proj Row) Row {
		cur := dlOwn(tx, "after_sales_cases", proj, id)
		dRevision(cur, p["expected_revision"])
		allowed := map[string]string{"open": "in_progress|completed|cancelled", "in_progress": "completed|cancelled"}[Str(cur["status"])]
		if allowed == "" || !strings.Contains("|"+allowed+"|", "|"+Str(p["to_status"])+"|") {
			dFail(409, "Invalid after-sales transition", code)
		}
		var complete any
		if p["to_status"] == "completed" {
			complete = p["effective_at"]
		}
		dExec(tx.DB, "UPDATE after_sales_cases SET status=?,resolution=?,completed_at=?,revision=revision+1,updated_at=? WHERE id=?", p["to_status"], p["resolution"], complete, tx.Timestamp(), id)
		dlEvent(tx, proj, "after_sales", id, cur["status"], p["to_status"], p["effective_at"], p["reason"], p["resolution"])
		return dlResponse(tx, dlOwn(tx, "after_sales_cases", proj, id), proj, "after_sales")
	})
}
func dlSummary(c *Context) any {
	p := dProject(c, false)
	id := p["id"]
	term := dRow(c.DB, "SELECT due_on,planned_amount_cents FROM payment_terms WHERE project_id=? AND milestone='final'", id)
	received := dI(dRow(c.DB, "SELECT coalesce(sum(amount_cents),0) amount FROM receipts WHERE project_id=? AND milestone='final' AND status='active'", id)["amount"])
	var due any
	planned := int64(0)
	if term != nil {
		planned = dI(term["planned_amount_cents"])
		due = term["due_on"]
	}
	invoices := dRow(c.DB, "SELECT count(*) count,coalesce(sum(CASE WHEN status='recorded' THEN amount_cents ELSE 0 END),0) recorded_amount_cents FROM project_invoices WHERE project_id=? AND status<>'void'", id)
	after := dRow(c.DB, "SELECT count(*) count,coalesce(sum(CASE WHEN status IN('open','in_progress') THEN 1 ELSE 0 END),0) open_count FROM after_sales_cases WHERE project_id=?", id)
	labor := dRow(c.DB, "SELECT count(*) count,coalesce(sum(cost_cents),0) cost FROM labor_entries WHERE project_id=? AND status='active'", id)
	reports := dRow(c.DB, "SELECT count(*) count,coalesce(sum(CASE WHEN status='confirmed' THEN 1 ELSE 0 END),0) confirmed,max(work_date) latest_work_date FROM site_daily_reports WHERE project_id=?", id)
	material := dRow(c.DB, "SELECT coalesce(sum(total_amount_cents),0) amount FROM material_advances WHERE project_id=? AND status='active'", id)
	commissions := Row{}
	for _, r := range dRows(c.DB, "SELECT status,count(*) count FROM commissioning_sessions WHERE project_id=? GROUP BY status", id) {
		commissions[Str(r["status"])] = r["count"]
	}
	var acceptance, warranty any
	if r := dRow(c.DB, "SELECT * FROM acceptances WHERE project_id=? ORDER BY scheduled_on DESC,id DESC LIMIT 1", id); r != nil {
		acceptance = dlResponse(c, r, p, "acceptance")
	}
	todos := []string{}
	if planned > received {
		todos = append(todos, "final_payment_outstanding")
	}
	if r := dRow(c.DB, "SELECT * FROM warranties WHERE project_id=?", id); r != nil {
		w := dlWarrantyResponse(c, r)
		warranty = w
		if w["status"] == "expiring" {
			todos = append(todos, "warranty_expiring")
		}
	}
	if dI(after["open_count"]) > 0 {
		todos = append(todos, "after_sales_open")
	}
	outstanding := planned - received
	if outstanding < 0 {
		outstanding = 0
	}
	return Row{"project_code": p["project_code"], "construction": Row{"labor_entry_count": labor["count"], "labor_cost_cents": labor["cost"], "daily_report_count": reports["count"], "confirmed_daily_report_count": reports["confirmed"], "latest_work_date": reports["latest_work_date"], "material_cost_cents": material["amount"]}, "commissioning": commissions, "latest_acceptance": acceptance, "warranty": warranty, "final_payment": Row{"due_on": due, "planned_amount_cents": planned, "received_amount_cents": received, "outstanding_amount_cents": outstanding}, "invoices": invoices, "after_sales": after, "todos": todos}
}
