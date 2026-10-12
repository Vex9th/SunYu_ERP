package api

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

func RegisterDelivery(s *Server) { registerWorkforce(s); registerSite(s); dlRegister(s) }
func dlRegister(s *Server) {
	s.Handle("GET /api/projects/{project_code}/drawing-signoffs", dDomain("delivery", dlListSignoffs))
	s.Handle("PUT /api/projects/{project_code}/drawing-signoffs/{discipline}", dDomain("delivery", dlPutSignoff))
	s.Handle("GET /api/projects/{project_code}/commissioning-sessions", dDomain("delivery", func(c *Context) any {
		return dlList(c, "commissioning_sessions", "commissioning_session", dlCommissionStates, "INVALID_COMMISSIONING_FILTER", "started_at DESC,id DESC")
	}))
	s.Handle("POST /api/projects/{project_code}/commissioning-sessions", dDomain("delivery", dlCreateCommission))
	s.Handle("PUT /api/projects/{project_code}/commissioning-sessions/{session_id}", dDomain("delivery", dlUpdateCommission))
	s.Handle("GET /api/projects/{project_code}/engineering-changes", dDomain("delivery", func(c *Context) any {
		return dlList(c, "engineering_changes", "engineering_change", dlChangeStates, "INVALID_CHANGE_FILTER", "proposed_on DESC,id DESC")
	}))
	s.Handle("POST /api/projects/{project_code}/engineering-changes", dDomain("delivery", dlCreateChange))
	s.Handle("PUT /api/projects/{project_code}/engineering-changes/{change_id}", dDomain("delivery", dlUpdateChange))
	s.Handle("POST /api/projects/{project_code}/engineering-changes/{change_id}/transition", dDomain("delivery", dlTransitionChange))
	s.Handle("GET /api/projects/{project_code}/acceptances", dDomain("delivery", func(c *Context) any {
		return dlList(c, "acceptances", "acceptance", "", "", "scheduled_on DESC,id DESC")
	}))
	s.Handle("POST /api/projects/{project_code}/acceptances", dDomain("delivery", dlCreateAcceptance))
	s.Handle("POST /api/projects/{project_code}/acceptances/{acceptance_id}/reschedule", dDomain("delivery", dlRescheduleAcceptance))
	s.Handle("POST /api/projects/{project_code}/acceptances/{acceptance_id}/cancel", dDomain("delivery", dlCancelAcceptance))
	s.Handle("POST /api/projects/{project_code}/acceptances/{acceptance_id}/complete", dDomain("delivery", dlCompleteAcceptance))
	s.Handle("GET /api/projects/{project_code}/warranty", dDomain("delivery", dlGetWarranty))
	s.Handle("PUT /api/projects/{project_code}/warranty", dDomain("delivery", dlPutWarranty))
	s.Handle("GET /api/projects/{project_code}/invoices", dDomain("delivery", dlListInvoices))
	s.Handle("POST /api/projects/{project_code}/invoices", dDomain("delivery", dlCreateInvoice))
	s.Handle("PUT /api/projects/{project_code}/invoices/{invoice_id}", dDomain("delivery", dlUpdateInvoice))
	s.Handle("POST /api/projects/{project_code}/invoices/{invoice_id}/void", dDomain("delivery", dlVoidInvoice))
	s.Handle("GET /api/projects/{project_code}/after-sales", dDomain("delivery", func(c *Context) any {
		return dlList(c, "after_sales_cases", "after_sales", dlAfterStates, "INVALID_AFTER_SALES_FILTER", "reported_on DESC,id DESC")
	}))
	s.Handle("POST /api/projects/{project_code}/after-sales", dDomain("delivery", dlCreateAfter))
	s.Handle("PUT /api/projects/{project_code}/after-sales/{case_id}", dDomain("delivery", dlUpdateAfter))
	s.Handle("POST /api/projects/{project_code}/after-sales/{case_id}/transition", dDomain("delivery", dlTransitionAfter))
	s.Handle("GET /api/projects/{project_code}/delivery-summary", dDomain("delivery", dlSummary))
}
func dlOwn(c *Context, table string, p Row, id int64) Row {
	r := dRow(c.DB, "SELECT * FROM "+table+" WHERE project_id=? AND id=?", p["id"], id)
	if r == nil {
		dFail(404, "Delivery resource not found", "DELIVERY_RESOURCE_NOT_FOUND")
	}
	return r
}
func dlValidateDocuments(c *Context, p Row, ids []int64) {
	for _, id := range ids {
		if dRow(c.DB, "SELECT v.id FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE v.id=? AND d.project_code=? COLLATE NOCASE AND d.archived_at IS NULL", id, p["project_code"]) == nil {
			dInvalid("INVALID_DOCUMENT_LINK", "document_version_ids", "must belong to the current project")
		}
	}
}
func dlLinks(c *Context, resource string, id int64) []int64 {
	ids := []int64{}
	for _, r := range dRows(c.DB, "SELECT document_version_id FROM workforce_document_links WHERE resource_type=? AND resource_id=? ORDER BY document_version_id", resource, id) {
		ids = append(ids, dI(r["document_version_id"]))
	}
	return ids
}
func dlReplaceLinks(c *Context, p Row, resource string, id int64, ids []int64) {
	dExec(c.DB, "DELETE FROM workforce_document_links WHERE resource_type=? AND resource_id=?", resource, id)
	for _, doc := range ids {
		dExec(c.DB, "INSERT INTO workforce_document_links(project_id,resource_type,resource_id,document_version_id,created_at) VALUES(?,?,?,?,?)", p["id"], resource, id, doc, c.Timestamp())
	}
}
func dlResponse(c *Context, r, p Row, resource string) Row {
	var fields string
	switch resource {
	case "drawing_signoff":
		fields = "discipline status confirmed_on not_required_reason notes"
	case "commissioning_session":
		fields = "started_at ended_at status summary issues next_action notes"
	case "engineering_change":
		fields = "change_number source title description reason contract_delta_cents estimated_cost_delta_cents schedule_delta_days proposed_on status notes"
	case "acceptance":
		fields = "acceptance_type scheduled_on performed_on status notes cancel_reason cancelled_at"
	case "invoice":
		fields = "invoice_type status requested_on recorded_on invoice_number amount_cents counterparty_name notes void_reason"
	case "after_sales":
		fields = "reported_on service_on reason contact_name contact_phone coverage_type is_under_warranty status resolution completed_at notes"
	}
	out := dFields(r, "id "+fields+" revision created_at updated_at")
	out["project_code"] = p["project_code"]
	out["document_version_ids"] = dlLinks(c, resource, dI(r["id"]))
	if resource == "after_sales" {
		out["is_under_warranty"] = dI(r["is_under_warranty"]) != 0
	}
	return out
}
func dlList(c *Context, table, resource, states, code, order string) any {
	p := dProject(c, false)
	where := " WHERE project_id=?"
	args := []any{p["id"]}
	if states != "" {
		status := dEnumQuery(c, "status", code, states+"|all", "all")
		if status != "all" {
			where += " AND status=?"
			args = append(args, status)
		}
	}
	return dPaged(c, "SELECT * FROM "+table+where+" ORDER BY "+order, "SELECT count(*) total FROM "+table+where, args, func(r Row) Row { return dlResponse(c, r, p, resource) })
}
func dlRead(c *Context, fields, code string) (Row, *AttachmentBatch) {
	r, b, e := ReadAttachmentBody(c, code)
	if e != nil && !strings.HasPrefix(c.R.Header.Get("Content-Type"), "multipart/") {
		dInvalid(code, "body", "must be valid JSON")
	}
	dCheck(e)
	defer func() {
		if p := recover(); p != nil {
			_ = b.Close()
			panic(p)
		}
	}()
	dExact(r, fields, code)
	return r, b
}
func dlPublish(c *Context, p Row, b *AttachmentBatch, category, label, identity, title string, preserve int, notes any) []int64 {
	docs := []ManagedDocument{}
	for i, a := range b.Attachments {
		docs = append(docs, ManagedDocument{Title: fmt.Sprintf(title, i+1), ManagedFilename: ManagedFilename([]any{p["project_code"], label, identity, fmt.Sprintf("%02d", i+1)}, a.OriginalFilename, preserve)})
	}
	return dTry(b.Publish(c, Str(p["project_code"]), category, docs, notes, c.Timestamp()))
}
func dlListSignoffs(c *Context) any {
	p := dProject(c, false)
	out := []Row{}
	for _, discipline := range []string{"mechanical", "electrical"} {
		r := dRow(c.DB, "SELECT * FROM drawing_signoffs WHERE project_id=? AND discipline=?", p["id"], discipline)
		if r == nil {
			r = Row{"discipline": discipline, "status": "pending"}
		}
		out = append(out, dlResponse(c, r, p, "drawing_signoff"))
	}
	return out
}
func dlPutSignoff(c *Context) any {
	code := "INVALID_SIGNOFF_PAYLOAD"
	discipline := dEnum(c.R.PathValue("discipline"), "discipline", code, "mechanical|electrical")
	raw, b := dlRead(c, dlSignoffFields, code)
	defer b.Close()
	p := dlSignoffPayload(raw)
	key := ""
	if strings.HasPrefix(c.R.Header.Get("Content-Type"), "multipart/") {
		key = dKey(c)
	}
	hash := dCompactHash(b.HashPayload(p))
	return dTx(c, func(tx *Context) any {
		proj := dProject(tx, false)
		scope := fmt.Sprintf("PUT:/api/projects/%d/drawing-signoffs/%s", dI(proj["id"]), discipline)
		if key != "" {
			prev := dRow(tx.DB, "SELECT request_sha256,response_json FROM idempotency_requests WHERE scope=? AND idempotency_key=?", scope, key)
			if prev != nil {
				if prev["request_sha256"] != hash {
					e := E(409, "Idempotency key reused", "IDEMPOTENCY_KEY_REUSED")
					e.Headers = map[string]string{"X-Error-Code": "IDEMPOTENCY_KEY_REUSED"}
					panic(dFailure{e})
				}
				var out Row
				dec := json.NewDecoder(strings.NewReader(Str(prev["response_json"])))
				dec.UseNumber()
				dCheck(dec.Decode(&out))
				return out
			}
		}
		if proj["status"] != "active" {
			dFail(409, "Project is archived", "PROJECT_ARCHIVED")
		}
		ids := p["document_version_ids"].([]int64)
		dlValidateDocuments(tx, proj, ids)
		cur := dRow(tx.DB, "SELECT * FROM drawing_signoffs WHERE project_id=? AND discipline=?", proj["id"], discipline)
		var id int64
		if cur == nil {
			if p["expected_revision"] != nil {
				dFail(409, "Resource was modified", "REVISION_CONFLICT")
			}
			id = dInsert(tx.DB, "INSERT INTO drawing_signoffs(project_id,discipline,status,confirmed_on,not_required_reason,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", proj["id"], discipline, p["status"], p["confirmed_on"], p["not_required_reason"], p["notes"], tx.Timestamp(), tx.Timestamp())
		} else {
			dRevision(cur, p["expected_revision"])
			id = dI(cur["id"])
			dExec(tx.DB, "UPDATE drawing_signoffs SET status=?,confirmed_on=?,not_required_reason=?,notes=?,revision=revision+1,updated_at=? WHERE id=?", p["status"], p["confirmed_on"], p["not_required_reason"], p["notes"], tx.Timestamp(), id)
		}
		label := "机械会签"
		if discipline == "electrical" {
			label = "电气会签"
		}
		date := Str(p["confirmed_on"])
		if date == "" {
			date = tx.Timestamp()[:10]
		}
		title := label + " 最终图纸 %02d" + fmt.Sprintf("（会签记录 %d）", id)
		ids = append(ids, dlPublish(tx, proj, b, discipline+"_signoff", label, CompactISODate(date), title, 2, p["notes"])...)
		dlReplaceLinks(tx, proj, "drawing_signoff", id, ids)
		out := dlResponse(tx, dlOwn(tx, "drawing_signoffs", proj, id), proj, "drawing_signoff")
		if key != "" {
			dExec(tx.DB, "INSERT INTO idempotency_requests(scope,idempotency_key,request_sha256,response_status,response_json,resource_type,resource_id,created_at) VALUES(?,?,?,200,?,'drawing_signoff',?,?)", scope, key, hash, string(dTry(CanonicalJSON(out))), id, tx.Timestamp())
		}
		return out
	})
}
func dlCreateCommission(c *Context) any {
	raw, b := dlRead(c, dlCommissionFields, "INVALID_COMMISSIONING_PAYLOAD")
	defer b.Close()
	p := dlCommissionPayload(raw, false)
	return dlScoped(c, b.HashPayload(p), 201, "commissioning_session", "commissioning-sessions", func(tx *Context, proj Row) Row {
		ids := p["document_version_ids"].([]int64)
		dlValidateDocuments(tx, proj, ids)
		id := dInsert(tx.DB, "INSERT INTO commissioning_sessions(project_id,started_at,ended_at,status,summary,issues,next_action,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", proj["id"], p["started_at"], p["ended_at"], p["status"], p["summary"], p["issues"], p["next_action"], p["notes"], tx.Timestamp(), tx.Timestamp())
		started := dTry(time.Parse(time.RFC3339Nano, Str(p["started_at"])))
		identity := started.In(time.FixedZone("Asia/Shanghai", 8*3600)).Format("20060102")
		ids = append(ids, dlPublish(tx, proj, b, "commissioning", "调试", identity, "调试资料 "+identity+" 附件 %02d"+fmt.Sprintf("（调试记录 %d）", id), 0, p["notes"])...)
		dlReplaceLinks(tx, proj, "commissioning_session", id, ids)
		return dlResponse(tx, dlOwn(tx, "commissioning_sessions", proj, id), proj, "commissioning_session")
	})
}
func dlUpdateCommission(c *Context) any {
	id := dID(c, "session_id")
	p := dlCommissionPayload(dBody(c, dlCommissionFields+" expected_revision", "INVALID_COMMISSIONING_PAYLOAD"), true)
	return dTx(c, func(tx *Context) any {
		proj := dProject(tx, true)
		cur := dlOwn(tx, "commissioning_sessions", proj, id)
		dRevision(cur, p["expected_revision"])
		ids := p["document_version_ids"].([]int64)
		dlValidateDocuments(tx, proj, ids)
		dExec(tx.DB, "UPDATE commissioning_sessions SET started_at=?,ended_at=?,status=?,summary=?,issues=?,next_action=?,notes=?,revision=revision+1,updated_at=? WHERE id=?", p["started_at"], p["ended_at"], p["status"], p["summary"], p["issues"], p["next_action"], p["notes"], tx.Timestamp(), id)
		dlReplaceLinks(tx, proj, "commissioning_session", id, ids)
		return dlResponse(tx, dlOwn(tx, "commissioning_sessions", proj, id), proj, "commissioning_session")
	})
}
func dlCreateChange(c *Context) any {
	raw, b := dlRead(c, dlChangeFields, "INVALID_CHANGE_PAYLOAD")
	defer b.Close()
	p := dlChangePayload(raw, false)
	return dlScoped(c, b.HashPayload(p), 201, "engineering_change", "engineering-changes", func(tx *Context, proj Row) Row {
		ids := p["document_version_ids"].([]int64)
		dlValidateDocuments(tx, proj, ids)
		number := dI(dRow(tx.DB, "SELECT coalesce(max(change_number),0)+1 n FROM engineering_changes WHERE project_id=?", proj["id"])["n"])
		id := dInsert(tx.DB, "INSERT INTO engineering_changes(project_id,change_number,source,title,description,reason,contract_delta_cents,estimated_cost_delta_cents,schedule_delta_days,proposed_on,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", proj["id"], number, p["source"], p["title"], p["description"], p["reason"], p["contract_delta_cents"], p["estimated_cost_delta_cents"], p["schedule_delta_days"], p["proposed_on"], p["notes"], tx.Timestamp(), tx.Timestamp())
		ids = append(ids, dlPublish(tx, proj, b, "technical_agreement", "工程变更", CompactISODate(Str(p["proposed_on"])), fmt.Sprintf("工程变更 %02d 附件 ", number)+"%02d"+fmt.Sprintf("（变更记录 %d）", id), 0, p["notes"])...)
		dlReplaceLinks(tx, proj, "engineering_change", id, ids)
		return dlResponse(tx, dlOwn(tx, "engineering_changes", proj, id), proj, "engineering_change")
	})
}
func dlUpdateChange(c *Context) any {
	id := dID(c, "change_id")
	p := dlChangePayload(dBody(c, dlChangeFields+" expected_revision", "INVALID_CHANGE_PAYLOAD"), true)
	return dTx(c, func(tx *Context) any {
		proj := dProject(tx, true)
		cur := dlOwn(tx, "engineering_changes", proj, id)
		dRevision(cur, p["expected_revision"])
		if cur["status"] != "proposed" {
			dFail(409, "Only proposed changes can be edited", "CHANGE_LOCKED")
		}
		ids := p["document_version_ids"].([]int64)
		dlValidateDocuments(tx, proj, ids)
		dExec(tx.DB, "UPDATE engineering_changes SET source=?,title=?,description=?,reason=?,contract_delta_cents=?,estimated_cost_delta_cents=?,schedule_delta_days=?,proposed_on=?,notes=?,revision=revision+1,updated_at=? WHERE id=?", p["source"], p["title"], p["description"], p["reason"], p["contract_delta_cents"], p["estimated_cost_delta_cents"], p["schedule_delta_days"], p["proposed_on"], p["notes"], tx.Timestamp(), id)
		dlReplaceLinks(tx, proj, "engineering_change", id, ids)
		return dlResponse(tx, dlOwn(tx, "engineering_changes", proj, id), proj, "engineering_change")
	})
}
func dlTransitionChange(c *Context) any {
	id := dID(c, "change_id")
	code := "INVALID_CHANGE_TRANSITION"
	r := dBody(c, "to_status effective_on reason expected_revision", code)
	p := Row{"to_status": dEnum(r["to_status"], "to_status", code, dlChangeStates), "effective_on": dDate(r["effective_on"], "effective_on", code, false), "reason": dText(r["reason"], "reason", code, true), "expected_revision": dInteger(r["expected_revision"], "expected_revision", code, 1)}
	return dlScoped(c, p, 200, "engineering_change", fmt.Sprintf("engineering-changes/%d/transition", id), func(tx *Context, proj Row) Row {
		cur := dlOwn(tx, "engineering_changes", proj, id)
		dRevision(cur, p["expected_revision"])
		allowed := map[string]string{"proposed": "approved|rejected|cancelled", "approved": "implemented|cancelled"}[Str(cur["status"])]
		if allowed == "" || !strings.Contains("|"+allowed+"|", "|"+Str(p["to_status"])+"|") {
			dFail(409, "Invalid engineering change transition", code)
		}
		dExec(tx.DB, "UPDATE engineering_changes SET status=?,revision=revision+1,updated_at=? WHERE id=?", p["to_status"], tx.Timestamp(), id)
		dlEvent(tx, proj, "engineering_change", id, cur["status"], p["to_status"], p["effective_on"], p["reason"], nil)
		return dlResponse(tx, dlOwn(tx, "engineering_changes", proj, id), proj, "engineering_change")
	})
}
func dlEvent(c *Context, proj Row, resource string, id int64, from, to, effective, reason, resolution any) {
	dExec(c.DB, "INSERT INTO delivery_transition_events(project_id,resource_type,resource_id,from_status,to_status,effective_at,reason,resolution,created_at) VALUES(?,?,?,?,?,?,?,?,?)", proj["id"], resource, id, from, to, effective, reason, resolution, c.Timestamp())
}
