package api

import "fmt"

func dlCreateAcceptance(c *Context) any {
	code := "INVALID_ACCEPTANCE_PAYLOAD"
	r := dBody(c, "acceptance_type scheduled_on notes", code)
	p := Row{"acceptance_type": dEnum(r["acceptance_type"], "acceptance_type", code, "pre_acceptance|final|reinspection"), "scheduled_on": dDate(r["scheduled_on"], "scheduled_on", code, false), "notes": dText(r["notes"], "notes", code, false)}
	return dlScoped(c, p, 201, "acceptance", "acceptances", func(tx *Context, proj Row) Row {
		id := dInsert(tx.DB, "INSERT INTO acceptances(project_id,acceptance_type,scheduled_on,notes,created_at,updated_at) VALUES(?,?,?,?,?,?)", proj["id"], p["acceptance_type"], p["scheduled_on"], p["notes"], tx.Timestamp(), tx.Timestamp())
		return dlResponse(tx, dlOwn(tx, "acceptances", proj, id), proj, "acceptance")
	})
}
func dlRescheduleAcceptance(c *Context) any {
	id := dID(c, "acceptance_id")
	code := "INVALID_ACCEPTANCE_RESCHEDULE"
	r := dBody(c, "acceptance_type scheduled_on notes reason expected_revision", code)
	p := Row{"acceptance_type": dEnum(r["acceptance_type"], "acceptance_type", code, "pre_acceptance|final|reinspection"), "scheduled_on": dDate(r["scheduled_on"], "scheduled_on", code, false), "notes": dText(r["notes"], "notes", code, false), "reason": dText(r["reason"], "reason", code, true), "expected_revision": dInteger(r["expected_revision"], "expected_revision", code, 1)}
	return dlScoped(c, p, 200, "acceptance_reschedule", fmt.Sprintf("acceptances/%d/reschedule", id), func(tx *Context, proj Row) Row {
		cur := dlOwn(tx, "acceptances", proj, id)
		dRevision(cur, p["expected_revision"])
		if cur["status"] != "scheduled" {
			dFail(409, "Only scheduled acceptance can be rescheduled", "ACCEPTANCE_LOCKED")
		}
		dExec(tx.DB, "UPDATE acceptances SET acceptance_type=?,scheduled_on=?,notes=?,revision=revision+1,updated_at=? WHERE id=?", p["acceptance_type"], p["scheduled_on"], p["notes"], tx.Timestamp(), id)
		dExec(tx.DB, "INSERT INTO acceptance_reschedule_events(project_id,acceptance_id,previous_acceptance_type,acceptance_type,previous_scheduled_on,scheduled_on,previous_notes,notes,reason,expected_revision,resulting_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", proj["id"], id, cur["acceptance_type"], p["acceptance_type"], cur["scheduled_on"], p["scheduled_on"], cur["notes"], p["notes"], p["reason"], p["expected_revision"], dI(p["expected_revision"])+1, tx.Timestamp())
		return dlResponse(tx, dlOwn(tx, "acceptances", proj, id), proj, "acceptance")
	})
}
func dlCancelAcceptance(c *Context) any {
	id := dID(c, "acceptance_id")
	code := "INVALID_ACCEPTANCE_CANCELLATION"
	r := dBody(c, "cancelled_on reason expected_revision", code)
	p := Row{"cancelled_on": dDate(r["cancelled_on"], "cancelled_on", code, false), "reason": dText(r["reason"], "reason", code, true), "expected_revision": dInteger(r["expected_revision"], "expected_revision", code, 1)}
	return dlScoped(c, p, 200, "acceptance_cancellation", fmt.Sprintf("acceptances/%d/cancel", id), func(tx *Context, proj Row) Row {
		cur := dlOwn(tx, "acceptances", proj, id)
		dRevision(cur, p["expected_revision"])
		if cur["status"] != "scheduled" {
			dFail(409, "Only scheduled acceptance can be cancelled", "ACCEPTANCE_LOCKED")
		}
		dExec(tx.DB, "UPDATE acceptances SET performed_on=?,status='cancelled',cancel_reason=?,cancelled_at=?,revision=revision+1,updated_at=? WHERE id=?", p["cancelled_on"], p["reason"], p["cancelled_on"], tx.Timestamp(), id)
		dExec(tx.DB, "INSERT INTO acceptance_transition_events(project_id,acceptance_id,from_status,to_status,effective_on,reason,created_at) VALUES(?,?,?,'cancelled',?,?,?)", proj["id"], id, cur["status"], p["cancelled_on"], p["reason"], tx.Timestamp())
		return dlResponse(tx, dlOwn(tx, "acceptances", proj, id), proj, "acceptance")
	})
}
func dlInsertWarranty(c *Context, proj Row, acceptance any, p Row) Row {
	id := dInsert(c.DB, "INSERT INTO warranties(project_id,acceptance_id,starts_on,duration_months,ends_on,renewal_price_cents,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)", proj["id"], acceptance, p["starts_on"], p["duration_months"], dlAddMonths(Str(p["starts_on"]), dI(p["duration_months"])), p["renewal_price_cents"], p["notes"], c.Timestamp(), c.Timestamp())
	return dRow(c.DB, "SELECT * FROM warranties WHERE id=?", id)
}
func dlCompleteAcceptance(c *Context) any {
	id := dID(c, "acceptance_id")
	code := "INVALID_ACCEPTANCE_COMPLETION"
	r, b := dlRead(c, dlAcceptanceFields, code)
	defer b.Close()
	p := Row{"performed_on": dDate(r["performed_on"], "performed_on", code, false), "result": dEnum(r["result"], "result", code, "passed|passed_with_punch|failed|cancelled"), "notes": dText(r["notes"], "notes", code, false), "document_version_ids": dIDs(r["document_version_ids"], code), "warranty": nil, "expected_revision": dInteger(r["expected_revision"], "expected_revision", code, 1)}
	if r["warranty"] != nil {
		p["warranty"] = dlWarrantyPayload(r["warranty"], code, false)
	}
	return dlScoped(c, b.HashPayload(p), 200, "acceptance", fmt.Sprintf("acceptances/%d/complete", id), func(tx *Context, proj Row) Row {
		cur := dlOwn(tx, "acceptances", proj, id)
		dRevision(cur, p["expected_revision"])
		if cur["status"] != "scheduled" {
			dFail(409, "Acceptance is already completed", "ACCEPTANCE_COMPLETED")
		}
		passed := cur["acceptance_type"] == "final" && (p["result"] == "passed" || p["result"] == "passed_with_punch")
		if passed != (p["warranty"] != nil) {
			dInvalid(code, "warranty", "is required exactly when final acceptance passes")
		}
		ids := p["document_version_ids"].([]int64)
		dlValidateDocuments(tx, proj, ids)
		dExec(tx.DB, "UPDATE acceptances SET performed_on=?,status=?,notes=?,revision=revision+1,updated_at=? WHERE id=?", p["performed_on"], p["result"], p["notes"], tx.Timestamp(), id)
		var warranty any
		if p["warranty"] != nil {
			if dRow(tx.DB, "SELECT id FROM warranties WHERE project_id=?", proj["id"]) != nil {
				dFail(409, "Project already has a warranty", "WARRANTY_EXISTS")
			}
			warranty = dlWarrantyResponse(tx, dlInsertWarranty(tx, proj, id, p["warranty"].(Row)))
		}
		date := Str(p["performed_on"])
		ids = append(ids, dlPublish(tx, proj, b, "acceptance", "验收", CompactISODate(date), "验收资料 "+date+" 附件 %02d"+fmt.Sprintf("（验收记录 %d）", id), 2, p["notes"])...)
		dlReplaceLinks(tx, proj, "acceptance", id, ids)
		return Row{"acceptance": dlResponse(tx, dlOwn(tx, "acceptances", proj, id), proj, "acceptance"), "warranty": warranty}
	})
}
func dlGetWarranty(c *Context) any {
	p := dProject(c, false)
	r := dRow(c.DB, "SELECT * FROM warranties WHERE project_id=?", p["id"])
	if r == nil {
		return nil
	}
	return dlWarrantyResponse(c, r)
}
func dlPutWarranty(c *Context) any {
	code := "INVALID_WARRANTY_PAYLOAD"
	p := dlWarrantyPayload(dBody(c, "starts_on duration_months renewal_price_cents notes expected_revision", code), code, true)
	return dTx(c, func(tx *Context) any {
		proj := dProject(tx, true)
		r := dRow(tx.DB, "SELECT * FROM warranties WHERE project_id=?", proj["id"])
		if r == nil {
			if p["expected_revision"] != nil {
				dFail(409, "Resource was modified", "REVISION_CONFLICT")
			}
			a := dRow(tx.DB, "SELECT * FROM acceptances WHERE project_id=? AND acceptance_type='final' AND status IN('passed','passed_with_punch') ORDER BY performed_on DESC,id DESC LIMIT 1", proj["id"])
			if a == nil {
				dFail(409, "Passed final acceptance is required", "ACCEPTANCE_REQUIRED")
			}
			r = dlInsertWarranty(tx, proj, a["id"], p)
		} else {
			dRevision(r, p["expected_revision"])
			dExec(tx.DB, "UPDATE warranties SET starts_on=?,duration_months=?,ends_on=?,renewal_price_cents=?,notes=?,revision=revision+1,updated_at=? WHERE id=?", p["starts_on"], p["duration_months"], dlAddMonths(Str(p["starts_on"]), dI(p["duration_months"])), p["renewal_price_cents"], p["notes"], tx.Timestamp(), r["id"])
			r = dRow(tx.DB, "SELECT * FROM warranties WHERE id=?", r["id"])
		}
		return dlWarrantyResponse(tx, r)
	})
}
