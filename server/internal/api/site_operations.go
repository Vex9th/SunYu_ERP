package api

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
)

const soReportFields = "location weather work_summary blockers next_plan notes expected_revision"
const soAdvanceFields = "worker_id spent_on vendor_name items notes document_version_ids"
const soAdvanceSelect = `SELECT a.*,w.name worker_name,coalesce(sum(CASE WHEN r.status='active' THEN r.amount_cents ELSE 0 END),0) reimbursed_amount_cents FROM material_advances a JOIN workers w ON w.id=a.worker_id LEFT JOIN advance_reimbursements r ON r.advance_id=a.id`

var soQuantityPattern = regexp.MustCompile(`^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$`)

func registerSite(s *Server) {
	s.Handle("GET /api/projects/{project_code}/site-daily-reports", dDomain("site", soListReports))
	s.Handle("PUT /api/projects/{project_code}/site-daily-reports/{work_date}", dDomain("site", soUpsertReport))
	s.Handle("POST /api/projects/{project_code}/site-daily-reports/{work_date}/confirm", dDomain("site", func(c *Context) any { return soTransitionReport(c, true) }))
	s.Handle("POST /api/projects/{project_code}/site-daily-reports/{work_date}/reopen", dDomain("site", func(c *Context) any { return soTransitionReport(c, false) }))
	s.Handle("GET /api/projects/{project_code}/material-advances", dDomain("site", soListAdvances))
	s.Handle("POST /api/projects/{project_code}/material-advances", dDomain("site", soCreateAdvance))
	s.Handle("GET /api/projects/{project_code}/material-advances/{advance_id}", dDomain("site", func(c *Context) any {
		p := dProject(c, false)
		return soAdvanceResponse(c, soAdvance(c, dI(p["id"]), dID(c, "advance_id")), Str(p["project_code"]), true)
	}))
	s.Handle("PUT /api/projects/{project_code}/material-advances/{advance_id}", dDomain("site", soUpdateAdvance))
	s.Handle("POST /api/projects/{project_code}/material-advances/{advance_id}/reimbursements", dDomain("site", soReimburse))
	s.Handle("POST /api/projects/{project_code}/material-advances/{advance_id}/reimbursements/{reimbursement_id}/void", dDomain("site", soVoidReimbursement))
	s.Handle("POST /api/projects/{project_code}/material-advances/{advance_id}/void", dDomain("site", soVoidAdvance))
}

// Site and delivery idempotency scopes use persistent project IDs, so renamed or
// case-variant project URLs replay the same durable operation after migration.
func dScoped(c *Context, payload Row, status int, resource, suffix string, fn func(*Context, Row) Row) any {
	return dScopedMode(c, payload, status, resource, suffix, "IDEMPOTENCY_CONFLICT", fn)
}
func dlScoped(c *Context, payload Row, status int, resource, suffix string, fn func(*Context, Row) Row) any {
	return dScopedMode(c, payload, status, resource, suffix, "IDEMPOTENCY_KEY_REUSED", fn)
}
func dScopedMode(c *Context, payload Row, status int, resource, suffix string, conflictCode string, fn func(*Context, Row) Row) any {
	key := dKey(c)
	hash := dCompactHash(payload)
	c.Status = status
	return dTx(c, func(tx *Context) any {
		p := dProject(tx, false)
		scope := fmt.Sprintf("POST:/api/projects/%d/%s", dI(p["id"]), suffix)
		if previous := dRow(tx.DB, "SELECT request_sha256,response_json FROM idempotency_requests WHERE scope=? AND idempotency_key=?", scope, key); previous != nil {
			if previous["request_sha256"] != hash {
				if conflictCode == "IDEMPOTENCY_KEY_REUSED" {
					e := E(409, "Idempotency key reused", conflictCode)
					e.Headers = map[string]string{"X-Error-Code": conflictCode}
					panic(dFailure{e})
				}
				dFail(409, "Idempotency key was already used with different content", conflictCode)
			}
			var restored Row
			dec := json.NewDecoder(strings.NewReader(Str(previous["response_json"])))
			dec.UseNumber()
			dCheck(dec.Decode(&restored))
			return restored
		}
		if p["status"] != "active" {
			dFail(409, "Project is archived", "PROJECT_ARCHIVED")
		}
		out := fn(tx, p)
		var resourceID any = out["id"]
		if acceptance, ok := out["acceptance"].(Row); ok {
			resourceID = acceptance["id"]
		}
		encoded := dTry(CanonicalJSON(out))
		dExec(tx.DB, "INSERT INTO idempotency_requests(scope,idempotency_key,request_sha256,response_status,response_json,resource_type,resource_id,created_at) VALUES(?,?,?,?,?,?,?,?)", scope, key, hash, status, string(encoded), resource, resourceID, tx.Timestamp())
		return out
	})
}
func soReportResponse(c *Context, r Row, code string) Row {
	out := dFields(r, "id work_date location weather work_summary blockers next_plan notes status confirmed_at revision created_at updated_at")
	out["project_code"] = code
	out["versions"] = dRows(c.DB, "SELECT id,version_number,work_date,location,weather,work_summary,blockers,next_plan,notes,confirmed_at,created_at FROM site_daily_report_versions WHERE project_id=? AND report_id=? ORDER BY version_number DESC", r["project_id"], r["id"])
	out["events"] = dRows(c.DB, "SELECT id,from_status,to_status,reason,occurred_at,created_at,report_version_id FROM site_daily_report_events WHERE project_id=? AND report_id=? ORDER BY id", r["project_id"], r["id"])
	return out
}
func soListReports(c *Context) any {
	p := dProject(c, false)
	where := " WHERE project_id=?"
	args := []any{p["id"]}
	dates := map[string]string{}
	for _, f := range []string{"from", "to"} {
		if v, ok := dSingleQuery(c, f, "INVALID_REPORT_FILTER"); ok {
			dates[f] = Str(dDate(v, f, "INVALID_REPORT_FILTER", false))
			op := ">="
			if f == "to" {
				op = "<="
			}
			where += " AND work_date" + op + "?"
			args = append(args, v)
		}
	}
	if dates["from"] != "" && dates["to"] != "" && dates["from"] > dates["to"] {
		dInvalid("INVALID_REPORT_FILTER", "from", "must not be after to")
	}
	return dPaged(c, "SELECT * FROM site_daily_reports"+where+" ORDER BY work_date DESC,id DESC", "SELECT count(*) total FROM site_daily_reports"+where, args, func(r Row) Row { return soReportResponse(c, r, Str(p["project_code"])) })
}
func soUpsertReport(c *Context) any {
	code := "INVALID_REPORT_PAYLOAD"
	raw := dBody(c, soReportFields, code)
	p := Row{}
	for _, f := range strings.Fields("location weather work_summary blockers next_plan notes") {
		p[f] = dText(raw[f], f, code, false)
	}
	var rev any
	if raw["expected_revision"] != nil {
		rev = dInteger(raw["expected_revision"], "expected_revision", code, 1)
	}
	date := dDate(c.R.PathValue("work_date"), "work_date", code, false)
	return dTx(c, func(tx *Context) any {
		proj := dProject(tx, true)
		r := dRow(tx.DB, "SELECT * FROM site_daily_reports WHERE project_id=? AND work_date=?", proj["id"], date)
		var id int64
		if r == nil {
			if rev != nil {
				dFail(409, "Resource was modified", "REVISION_CONFLICT")
			}
			id = dInsert(tx.DB, "INSERT INTO site_daily_reports(project_id,work_date,location,weather,work_summary,blockers,next_plan,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", proj["id"], date, p["location"], p["weather"], p["work_summary"], p["blockers"], p["next_plan"], p["notes"], tx.Timestamp(), tx.Timestamp())
		} else {
			id = dI(r["id"])
			dRevision(r, rev)
			if r["status"] != "draft" {
				dFail(409, "Confirmed report must be reopened before editing", "REPORT_CONFIRMED")
			}
			dExec(tx.DB, "UPDATE site_daily_reports SET location=?,weather=?,work_summary=?,blockers=?,next_plan=?,notes=?,revision=revision+1,updated_at=? WHERE id=?", p["location"], p["weather"], p["work_summary"], p["blockers"], p["next_plan"], p["notes"], tx.Timestamp(), id)
		}
		r = dOwned(tx, "site_daily_reports", dI(proj["id"]), id, "REPORT_NOT_FOUND")
		return soReportResponse(tx, r, Str(proj["project_code"]))
	})
}
func soTransitionReport(c *Context, confirm bool) any {
	action, code, fields, from, to := "reopen", "INVALID_REPORT_REOPEN", "reason expected_revision", "confirmed", "draft"
	if confirm {
		action, code, fields, from, to = "confirm", "INVALID_REPORT_CONFIRMATION", "confirmed_at expected_revision", "draft", "confirmed"
	}
	r := dBody(c, fields, code)
	p := Row{"expected_revision": dInteger(r["expected_revision"], "expected_revision", code, 1)}
	if confirm {
		p["confirmed_at"] = dDatetime(r["confirmed_at"], "confirmed_at", code, false)
	} else {
		p["reason"] = dText(r["reason"], "reason", code, true)
	}
	date := Str(dDate(c.R.PathValue("work_date"), "work_date", "INVALID_REPORT_PAYLOAD", false))
	return dScoped(c, p, 200, "site_daily_report_event", "site-daily-reports/"+date+"/"+action, func(tx *Context, proj Row) Row {
		r := dRow(tx.DB, "SELECT * FROM site_daily_reports WHERE project_id=? AND work_date=?", proj["id"], date)
		if r == nil {
			dFail(404, "Daily report not found", "REPORT_NOT_FOUND")
		}
		dRevision(r, p["expected_revision"])
		if r["status"] != from {
			dFail(409, "Daily report has an invalid status", "INVALID_REPORT_STATUS")
		}
		var vid int64
		if confirm {
			n := dRow(tx.DB, "SELECT max(coalesce((SELECT max(version_number) FROM site_daily_report_versions WHERE report_id=?),0),(SELECT count(*) FROM site_daily_report_events WHERE report_id=? AND to_status='confirmed'))+1 n", r["id"], r["id"])
			vid = dInsert(tx.DB, "INSERT INTO site_daily_report_versions(project_id,report_id,version_number,work_date,location,weather,work_summary,blockers,next_plan,notes,confirmed_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", proj["id"], r["id"], n["n"], r["work_date"], r["location"], r["weather"], r["work_summary"], r["blockers"], r["next_plan"], r["notes"], p["confirmed_at"], tx.Timestamp())
		} else {
			v := dRow(tx.DB, "SELECT id FROM site_daily_report_versions WHERE project_id=? AND report_id=? ORDER BY version_number DESC LIMIT 1", proj["id"], r["id"])
			if v == nil {
				dFail(409, "Confirmed report has no immutable version", "REPORT_VERSION_MISSING")
			}
			vid = dI(v["id"])
		}
		dExec(tx.DB, "UPDATE site_daily_reports SET status=?,confirmed_at=?,revision=revision+1,updated_at=? WHERE id=?", to, p["confirmed_at"], tx.Timestamp(), r["id"])
		occurred := p["confirmed_at"]
		if occurred == nil {
			occurred = tx.Timestamp()
		}
		dExec(tx.DB, "INSERT INTO site_daily_report_events(project_id,report_id,from_status,to_status,reason,occurred_at,created_at,report_version_id) VALUES(?,?,?,?,?,?,?,?)", proj["id"], r["id"], from, to, p["reason"], occurred, tx.Timestamp(), vid)
		return soReportResponse(tx, dOwned(tx, "site_daily_reports", dI(proj["id"]), dI(r["id"]), "REPORT_NOT_FOUND"), Str(proj["project_code"]))
	})
}
func soNormalizeAdvance(r Row, updating bool) Row {
	code := "INVALID_ADVANCE_PAYLOAD"
	raw, ok := r["items"].([]any)
	if !ok || len(raw) == 0 {
		dInvalid(code, "items", "must be a non-empty array")
	}
	items := []Row{}
	total := int64(0)
	for i, v := range raw {
		prefix := fmt.Sprintf("items.%d.", i)
		item, ok := v.(map[string]any)
		if !ok {
			dInvalid(code, strings.TrimSuffix(prefix, "."), "has invalid fields")
		}
		dExact(item, "name specification brand quantity unit unit_price_cents line_amount_cents", code)
		if !soQuantityPattern.MatchString(Str(item["quantity"])) {
			dInvalid(code, prefix+"quantity", "must be a positive decimal string")
		}
		q := dDecimalMilli(item["quantity"], prefix+"quantity", code, 0)
		price := dInteger(item["unit_price_cents"], prefix+"unit_price_cents", code, 0)
		amount := dRoundMul(price, q, 1000, code, "items")
		submitted := dInteger(item["line_amount_cents"], prefix+"line_amount_cents", code, 0)
		if submitted != amount {
			dInvalid(code, prefix+"line_amount_cents", "must equal quantity multiplied by unit price")
		}
		if total > math.MaxInt64-amount {
			dInvalid(code, "items", "total is out of range")
		}
		total += amount
		items = append(items, Row{"name": dText(item["name"], prefix+"name", code, true), "specification": dText(item["specification"], prefix+"specification", code, false), "brand": dText(item["brand"], prefix+"brand", code, false), "quantity_milli": q, "unit": dText(item["unit"], prefix+"unit", code, true), "unit_price_cents": price, "line_amount_cents": amount})
	}
	p := Row{"worker_id": dInteger(r["worker_id"], "worker_id", code, 1), "spent_on": dDate(r["spent_on"], "spent_on", code, false), "vendor_name": dText(r["vendor_name"], "vendor_name", code, false), "items": items, "total_amount_cents": total, "notes": dText(r["notes"], "notes", code, false), "document_version_ids": dIDs(r["document_version_ids"], code)}
	if updating {
		p["expected_revision"] = dInteger(r["expected_revision"], "expected_revision", code, 1)
	}
	return p
}
func soAdvance(c *Context, project, id int64) Row {
	r := dRow(c.DB, soAdvanceSelect+" WHERE a.project_id=? AND a.id=? GROUP BY a.id", project, id)
	if r == nil {
		dFail(404, "Material advance not found", "ADVANCE_NOT_FOUND")
	}
	return r
}
func soAdvanceStatus(r Row) string {
	if r["status"] == "voided" {
		return "voided"
	}
	n, total := dI(r["reimbursed_amount_cents"]), dI(r["total_amount_cents"])
	if n == 0 {
		return "unreimbursed"
	}
	if n == total {
		return "reimbursed"
	}
	return "partial"
}
func soAdvanceResponse(c *Context, r Row, code string, detail bool) Row {
	out := dFields(r, "id worker_id worker_name spent_on vendor_name total_amount_cents reimbursed_amount_cents notes void_reason voided_at revision created_at updated_at")
	out["project_code"] = code
	out["status"] = soAdvanceStatus(r)
	out["outstanding_amount_cents"] = dI(r["total_amount_cents"]) - dI(r["reimbursed_amount_cents"])
	ids := []int64{}
	for _, x := range dRows(c.DB, "SELECT document_version_id FROM workforce_document_links WHERE resource_type='material_advance' AND resource_id=? ORDER BY document_version_id", r["id"]) {
		ids = append(ids, dI(x["document_version_id"]))
	}
	out["document_version_ids"] = ids
	if detail {
		items := dRows(c.DB, "SELECT id,line_number,name,specification,brand,quantity_milli,unit,unit_price_cents,line_amount_cents FROM material_advance_items WHERE advance_id=? ORDER BY line_number", r["id"])
		for _, item := range items {
			item["quantity"] = dFraction(item["quantity_milli"])
			delete(item, "quantity_milli")
		}
		out["items"] = items
		out["reimbursements"] = dRows(c.DB, "SELECT id,advance_id,amount_cents,reimbursed_on,payment_method,notes,status,void_reason,voided_at,revision,created_at,updated_at FROM advance_reimbursements WHERE advance_id=? ORDER BY reimbursed_on,id", r["id"])
	}
	return out
}
func soListAdvances(c *Context) any {
	p := dProject(c, false)
	page, size := dPage(c)
	status := dEnumQuery(c, "status", "INVALID_ADVANCE_FILTER", "unreimbursed|partial|reimbursed|voided|all", "all")
	worker := int64(0)
	if v, ok := dSingleQuery(c, "worker_id", "INVALID_ADVANCE_FILTER"); ok {
		worker = dTry(PositiveID(v))
	}
	rows := dRows(c.DB, soAdvanceSelect+" WHERE a.project_id=? GROUP BY a.id ORDER BY a.spent_on DESC,a.id DESC", p["id"])
	filtered := []Row{}
	for _, r := range rows {
		if (worker == 0 || worker == dI(r["worker_id"])) && (status == "all" || status == soAdvanceStatus(r)) {
			filtered = append(filtered, r)
		}
	}
	out := []Row{}
	start := (page - 1) * size
	for i := start; i < int64(len(filtered)) && i < start+size; i++ {
		out = append(out, soAdvanceResponse(c, filtered[i], Str(p["project_code"]), false))
	}
	return Row{"items": out, "total": len(filtered), "page": page, "page_size": size}
}
func soValidate(c *Context, proj, p Row) {
	worker := dRow(c.DB, "SELECT w.id FROM workers w JOIN crew_assignments a ON a.worker_id=w.id WHERE w.id=? AND w.status='active' AND a.project_id=? AND a.status IN('planned','active') AND a.scheduled_start_on<=? AND coalesce(a.scheduled_end_on,'9999-12-31')>=? LIMIT 1", p["worker_id"], proj["id"], p["spent_on"], p["spent_on"])
	if worker == nil {
		dInvalid("INVALID_ADVANCE_PAYLOAD", "worker_id", "must have an active assignment for spent_on")
	}
	for _, id := range p["document_version_ids"].([]int64) {
		if dRow(c.DB, "SELECT v.id FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE v.id=? AND d.project_code=? COLLATE NOCASE AND d.archived_at IS NULL", id, proj["project_code"]) == nil {
			dInvalid("INVALID_ADVANCE_PAYLOAD", "document_version_ids", "must belong to the current project")
		}
	}
}
func soReplace(c *Context, proj Row, id int64, p Row) {
	dExec(c.DB, "DELETE FROM material_advance_items WHERE advance_id=?", id)
	for i, item := range p["items"].([]Row) {
		dExec(c.DB, "INSERT INTO material_advance_items(advance_id,line_number,name,specification,brand,quantity_milli,unit,unit_price_cents,line_amount_cents) VALUES(?,?,?,?,?,?,?,?,?)", id, i+1, item["name"], item["specification"], item["brand"], item["quantity_milli"], item["unit"], item["unit_price_cents"], item["line_amount_cents"])
	}
	dExec(c.DB, "DELETE FROM workforce_document_links WHERE resource_type='material_advance' AND resource_id=?", id)
	for _, doc := range p["document_version_ids"].([]int64) {
		dExec(c.DB, "INSERT INTO workforce_document_links(project_id,resource_type,resource_id,document_version_id,created_at) VALUES(?,'material_advance',?,?,?)", proj["id"], id, doc, c.Timestamp())
	}
}
func soUnreimbursed(r Row) {
	if r["status"] == "voided" {
		dFail(409, "Voided advance cannot be changed", "ADVANCE_VOIDED")
	}
	if dI(r["reimbursed_amount_cents"]) != 0 {
		dFail(409, "Reimbursed advance cannot be changed", "ADVANCE_ALREADY_REIMBURSED")
	}
}
func soCreateAdvance(c *Context) any {
	p := soNormalizeAdvance(dBody(c, soAdvanceFields, "INVALID_ADVANCE_PAYLOAD"), false)
	return dScoped(c, p, 201, "material_advance", "material-advances", func(tx *Context, proj Row) Row {
		soValidate(tx, proj, p)
		id := dInsert(tx.DB, "INSERT INTO material_advances(project_id,worker_id,spent_on,vendor_name,total_amount_cents,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", proj["id"], p["worker_id"], p["spent_on"], p["vendor_name"], p["total_amount_cents"], p["notes"], tx.Timestamp(), tx.Timestamp())
		soReplace(tx, proj, id, p)
		return soAdvanceResponse(tx, soAdvance(tx, dI(proj["id"]), id), Str(proj["project_code"]), true)
	})
}
func soUpdateAdvance(c *Context) any {
	id := dID(c, "advance_id")
	p := soNormalizeAdvance(dBody(c, soAdvanceFields+" expected_revision", "INVALID_ADVANCE_PAYLOAD"), true)
	return dTx(c, func(tx *Context) any {
		proj := dProject(tx, true)
		r := soAdvance(tx, dI(proj["id"]), id)
		dRevision(r, p["expected_revision"])
		soUnreimbursed(r)
		soValidate(tx, proj, p)
		dExec(tx.DB, "UPDATE material_advances SET worker_id=?,spent_on=?,vendor_name=?,total_amount_cents=?,notes=?,revision=revision+1,updated_at=? WHERE id=?", p["worker_id"], p["spent_on"], p["vendor_name"], p["total_amount_cents"], p["notes"], tx.Timestamp(), id)
		soReplace(tx, proj, id, p)
		return soAdvanceResponse(tx, soAdvance(tx, dI(proj["id"]), id), Str(proj["project_code"]), true)
	})
}
func soReimbursementResponse(c *Context, project, advance, id int64) Row {
	r := dRow(c.DB, "SELECT * FROM advance_reimbursements WHERE id=? AND advance_id=?", id, advance)
	if r == nil {
		dFail(404, "Reimbursement not found", "REIMBURSEMENT_NOT_FOUND")
	}
	a := soAdvance(c, project, advance)
	r["advance_status"] = soAdvanceStatus(a)
	r["advance_reimbursed_amount_cents"] = a["reimbursed_amount_cents"]
	r["advance_outstanding_amount_cents"] = dI(a["total_amount_cents"]) - dI(a["reimbursed_amount_cents"])
	r["advance_revision"] = a["revision"]
	return r
}
func soReimburse(c *Context) any {
	id := dID(c, "advance_id")
	code := "INVALID_REIMBURSEMENT_PAYLOAD"
	r := dBody(c, "amount_cents reimbursed_on payment_method notes", code)
	p := Row{"amount_cents": dInteger(r["amount_cents"], "amount_cents", code, 1), "reimbursed_on": dDate(r["reimbursed_on"], "reimbursed_on", code, false), "payment_method": dEnum(r["payment_method"], "payment_method", code, "bank_transfer|cash|other"), "notes": dText(r["notes"], "notes", code, false)}
	return dScoped(c, p, 201, "advance_reimbursement", fmt.Sprintf("material-advances/%d/reimbursements", id), func(tx *Context, proj Row) Row {
		a := soAdvance(tx, dI(proj["id"]), id)
		if a["status"] == "voided" {
			dFail(409, "Voided advance cannot be reimbursed", "ADVANCE_VOIDED")
		}
		if dI(p["amount_cents"]) > dI(a["total_amount_cents"])-dI(a["reimbursed_amount_cents"]) {
			dFail(409, "Reimbursement exceeds advance total", "REIMBURSEMENT_EXCEEDS_TOTAL")
		}
		rid := dInsert(tx.DB, "INSERT INTO advance_reimbursements(advance_id,amount_cents,reimbursed_on,payment_method,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", id, p["amount_cents"], p["reimbursed_on"], p["payment_method"], p["notes"], tx.Timestamp(), tx.Timestamp())
		dExec(tx.DB, "UPDATE material_advances SET revision=revision+1,updated_at=? WHERE id=?", tx.Timestamp(), id)
		return soReimbursementResponse(tx, dI(proj["id"]), id, rid)
	})
}
func soVoidPayload(c *Context, code string) Row {
	r := dBody(c, "reason expected_revision", code)
	return Row{"reason": dText(r["reason"], "reason", code, true), "expected_revision": dInteger(r["expected_revision"], "expected_revision", code, 1)}
}
func soVoidReimbursement(c *Context) any {
	aid, rid := dID(c, "advance_id"), dID(c, "reimbursement_id")
	p := soVoidPayload(c, "INVALID_REIMBURSEMENT_VOID")
	return dScoped(c, p, 200, "advance_reimbursement_void", fmt.Sprintf("material-advances/%d/reimbursements/%d/void", aid, rid), func(tx *Context, proj Row) Row {
		soAdvance(tx, dI(proj["id"]), aid)
		r := dRow(tx.DB, "SELECT * FROM advance_reimbursements WHERE id=? AND advance_id=?", rid, aid)
		if r == nil {
			dFail(404, "Reimbursement not found", "REIMBURSEMENT_NOT_FOUND")
		}
		dRevision(r, p["expected_revision"])
		if r["status"] != "active" {
			dFail(409, "Voided reimbursement cannot be changed", "REIMBURSEMENT_VOIDED")
		}
		dExec(tx.DB, "UPDATE advance_reimbursements SET status='voided',void_reason=?,voided_at=?,revision=revision+1,updated_at=? WHERE id=?", p["reason"], tx.Timestamp(), tx.Timestamp(), rid)
		dExec(tx.DB, "UPDATE material_advances SET revision=revision+1,updated_at=? WHERE id=?", tx.Timestamp(), aid)
		return soReimbursementResponse(tx, dI(proj["id"]), aid, rid)
	})
}
func soVoidAdvance(c *Context) any {
	id := dID(c, "advance_id")
	p := soVoidPayload(c, "INVALID_ADVANCE_VOID")
	return dScoped(c, p, 200, "material_advance_void", fmt.Sprintf("material-advances/%d/void", id), func(tx *Context, proj Row) Row {
		r := soAdvance(tx, dI(proj["id"]), id)
		dRevision(r, p["expected_revision"])
		soUnreimbursed(r)
		dExec(tx.DB, "UPDATE material_advances SET status='voided',void_reason=?,voided_at=?,revision=revision+1,updated_at=? WHERE id=?", p["reason"], tx.Timestamp(), tx.Timestamp(), id)
		return soAdvanceResponse(tx, soAdvance(tx, dI(proj["id"]), id), Str(proj["project_code"]), true)
	})
}
