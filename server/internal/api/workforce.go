package api

import (
	"fmt"
	"strings"
)

const wWorkerFields = "name phone notes"
const wAssignmentFields = "worker_id role scheduled_start_on scheduled_end_on pay_basis rate_cents notes"
const wLaborFields = "assignment_id work_date attendance_status day_fraction work_minutes work_summary notes"
const wAssignmentSelect = `SELECT a.id,p.project_code,a.worker_id,w.name AS worker_name,w.phone AS worker_phone,a.role,a.scheduled_start_on,a.scheduled_end_on,a.pay_basis,a.rate_cents,a.notes,a.status,a.revision,a.created_at,a.updated_at FROM crew_assignments a JOIN projects p ON p.id=a.project_id JOIN workers w ON w.id=a.worker_id`
const wLaborSelect = `SELECT e.*,p.project_code,w.name AS worker_name FROM labor_entries e JOIN projects p ON p.id=e.project_id JOIN workers w ON w.id=e.worker_id`

func registerWorkforce(s *Server) {
	s.Handle("GET /api/workers", dDomain("workforce", wListWorkers))
	s.Handle("POST /api/workers", dDomain("workforce", wCreateWorker))
	s.Handle("GET /api/workers/{worker_id}", dDomain("workforce", func(c *Context) any { return wWorker(c, dID(c, "worker_id")) }))
	s.Handle("PUT /api/workers/{worker_id}", dDomain("workforce", wUpdateWorker))
	s.Handle("POST /api/workers/{worker_id}/deactivate", dDomain("workforce", wDeactivate))
	s.Handle("POST /api/workers/{worker_id}/reactivate", dDomain("workforce", wReactivate))
	s.Handle("GET /api/projects/{project_code}/crew-assignments", dDomain("workforce", wListAssignments))
	s.Handle("POST /api/projects/{project_code}/crew-assignments", dDomain("workforce", wCreateAssignment))
	s.Handle("PUT /api/projects/{project_code}/crew-assignments/{assignment_id}", dDomain("workforce", wUpdateAssignment))
	s.Handle("POST /api/projects/{project_code}/crew-assignments/{assignment_id}/transition", dDomain("workforce", wTransition))
	s.Handle("GET /api/projects/{project_code}/labor-entries", dDomain("workforce", wListLabor))
	s.Handle("POST /api/projects/{project_code}/labor-entries", dDomain("workforce", wCreateLabor))
	s.Handle("PUT /api/projects/{project_code}/labor-entries/{entry_id}", dDomain("workforce", wUpdateLabor))
	s.Handle("POST /api/projects/{project_code}/labor-entries/{entry_id}/void", dDomain("workforce", wVoidLabor))
	s.Handle("POST /api/projects/{project_code}/labor-entries/batch", dDomain("workforce", wBatch))
}
func wWorker(c *Context, id int64) Row {
	r := dRow(c.DB, "SELECT * FROM workers WHERE id=?", id)
	if r == nil {
		dFail(404, "Worker not found", "WORKER_NOT_FOUND")
	}
	return dFields(r, "id name phone notes status inactive_on inactive_reason revision created_at updated_at")
}
func wNormalizeWorker(r Row) Row {
	return Row{"name": dText(r["name"], "name", "INVALID_WORKER_PAYLOAD", true), "phone": dText(r["phone"], "phone", "INVALID_WORKER_PAYLOAD", false), "notes": dText(r["notes"], "notes", "INVALID_WORKER_PAYLOAD", false)}
}
func wListWorkers(c *Context) any {
	status := dEnumQuery(c, "status", "INVALID_WORKER_FILTER", "active|inactive|all", "active")
	where := " WHERE 1=1"
	args := []any{}
	if status != "all" {
		where += " AND status=?"
		args = append(args, status)
	}
	if q, ok := dSingleQuery(c, "query", "INVALID_QUERY"); ok {
		v := dText(q, "query", "INVALID_QUERY", false)
		if v != nil {
			where += " AND (instr(name,?)>0 OR instr(coalesce(phone,''),?)>0)"
			args = append(args, v, v)
		}
	}
	return dPaged(c, "SELECT * FROM workers"+where+" ORDER BY name COLLATE NOCASE,id", "SELECT COUNT(*) total FROM workers"+where, args, nil)
}
func wCreateWorker(c *Context) any {
	p := wNormalizeWorker(dBody(c, wWorkerFields, "INVALID_WORKER_PAYLOAD"))
	return dIdempotent(c, p, 201, "workforce", func(tx *Context) any {
		id := dInsert(tx.DB, "INSERT INTO workers(name,phone,notes,created_at,updated_at) VALUES(?,?,?,?,?)", p["name"], p["phone"], p["notes"], tx.Timestamp(), tx.Timestamp())
		return wWorker(tx, id)
	})
}
func wUpdateWorker(c *Context) any {
	id := dID(c, "worker_id")
	raw := dBody(c, wWorkerFields+" expected_revision", "INVALID_WORKER_PAYLOAD")
	p := wNormalizeWorker(raw)
	rev := dInteger(raw["expected_revision"], "expected_revision", "INVALID_WORKER_PAYLOAD", 1)
	return dTx(c, func(tx *Context) any {
		r := wWorker(tx, id)
		dRevision(r, rev)
		dExec(tx.DB, "UPDATE workers SET name=?,phone=?,notes=?,revision=revision+1,updated_at=? WHERE id=?", p["name"], p["phone"], p["notes"], tx.Timestamp(), id)
		return wWorker(tx, id)
	})
}
func wDeactivate(c *Context) any {
	id := dID(c, "worker_id")
	code := "INVALID_DEACTIVATION_PAYLOAD"
	r := dBody(c, "effective_on reason expected_revision", code)
	p := Row{"effective_on": dDate(r["effective_on"], "effective_on", code, false), "reason": dText(r["reason"], "reason", code, true), "expected_revision": dInteger(r["expected_revision"], "expected_revision", code, 1)}
	return dIdempotent(c, p, 200, "workforce", func(tx *Context) any {
		cur := wWorker(tx, id)
		if cur["status"] == "inactive" {
			return cur
		}
		dRevision(cur, p["expected_revision"])
		dExec(tx.DB, "UPDATE workers SET status='inactive',inactive_on=?,inactive_reason=?,revision=revision+1,updated_at=? WHERE id=?", p["effective_on"], p["reason"], tx.Timestamp(), id)
		return wWorker(tx, id)
	})
}
func wReactivate(c *Context) any {
	id := dID(c, "worker_id")
	code := "INVALID_REACTIVATION_PAYLOAD"
	r := dBody(c, "expected_revision", code)
	p := Row{"expected_revision": dInteger(r["expected_revision"], "expected_revision", code, 1)}
	return dIdempotent(c, p, 200, "workforce", func(tx *Context) any {
		cur := wWorker(tx, id)
		dRevision(cur, p["expected_revision"])
		if cur["status"] == "active" {
			return cur
		}
		dExec(tx.DB, "UPDATE workers SET status='active',inactive_on=NULL,inactive_reason=NULL,revision=revision+1,updated_at=? WHERE id=?", tx.Timestamp(), id)
		return wWorker(tx, id)
	})
}
func wNormalizeAssignment(r Row) Row {
	code := "INVALID_ASSIGNMENT_PAYLOAD"
	p := Row{"worker_id": dInteger(r["worker_id"], "worker_id", code, 1), "role": dText(r["role"], "role", code, true), "scheduled_start_on": dDate(r["scheduled_start_on"], "scheduled_start_on", code, false), "scheduled_end_on": dDate(r["scheduled_end_on"], "scheduled_end_on", code, true), "pay_basis": dEnum(r["pay_basis"], "pay_basis", code, "daily|hourly"), "rate_cents": dInteger(r["rate_cents"], "rate_cents", code, 0), "notes": dText(r["notes"], "notes", code, false)}
	if p["scheduled_end_on"] != nil && Str(p["scheduled_end_on"]) < Str(p["scheduled_start_on"]) {
		dInvalid(code, "scheduled_end_on", "must not be before scheduled_start_on")
	}
	return p
}
func wAssignment(c *Context, project, id int64) Row {
	r := dRow(c.DB, wAssignmentSelect+" WHERE a.id=? AND a.project_id=?", id, project)
	if r == nil {
		dFail(404, "Crew assignment not found", "ASSIGNMENT_NOT_FOUND")
	}
	return r
}
func wSchedule(c *Context, p Row, exclude int64) {
	end := p["scheduled_end_on"]
	if end == nil {
		end = "9999-12-31"
	}
	r := dRow(c.DB, `SELECT a.id FROM crew_assignments a JOIN projects p ON p.id=a.project_id WHERE a.worker_id=? AND p.status='active' AND a.status IN('planned','active') AND a.scheduled_start_on<=? AND coalesce(a.scheduled_end_on,'9999-12-31')>=? AND a.id<>? LIMIT 1`, p["worker_id"], end, p["scheduled_start_on"], exclude)
	if r != nil {
		dFail(409, "Worker already has an overlapping crew assignment", "CREW_ASSIGNMENT_OVERLAP")
	}
}
func wActiveWorker(r Row) {
	if r["status"] != "active" {
		dFail(409, "Inactive worker cannot receive a new assignment", "WORKER_INACTIVE")
	}
}
func wListAssignments(c *Context) any {
	p := dProject(c, false)
	status := dEnumQuery(c, "status", "INVALID_ASSIGNMENT_FILTER", "planned|active|completed|cancelled|all", "all")
	where := " WHERE a.project_id=?"
	args := []any{p["id"]}
	if status != "all" {
		where += " AND a.status=?"
		args = append(args, status)
	}
	return dPaged(c, wAssignmentSelect+where+" ORDER BY a.scheduled_start_on,a.id", "SELECT count(*) total FROM crew_assignments a"+where, args, nil)
}
func wCreateAssignment(c *Context) any {
	p := wNormalizeAssignment(dBody(c, wAssignmentFields, "INVALID_ASSIGNMENT_PAYLOAD"))
	return dIdempotent(c, p, 201, "workforce", func(tx *Context) any {
		proj := dProject(tx, true)
		wActiveWorker(wWorker(tx, dI(p["worker_id"])))
		wSchedule(tx, p, 0)
		id := dInsert(tx.DB, "INSERT INTO crew_assignments(project_id,worker_id,role,scheduled_start_on,scheduled_end_on,pay_basis,rate_cents,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", proj["id"], p["worker_id"], p["role"], p["scheduled_start_on"], p["scheduled_end_on"], p["pay_basis"], p["rate_cents"], p["notes"], tx.Timestamp(), tx.Timestamp())
		return wAssignment(tx, dI(proj["id"]), id)
	})
}
func wUpdateAssignment(c *Context) any {
	id := dID(c, "assignment_id")
	raw := dBody(c, wAssignmentFields+" expected_revision", "INVALID_ASSIGNMENT_PAYLOAD")
	p := wNormalizeAssignment(raw)
	rev := dInteger(raw["expected_revision"], "expected_revision", "INVALID_ASSIGNMENT_PAYLOAD", 1)
	return dTx(c, func(tx *Context) any {
		proj := dProject(tx, true)
		cur := wAssignment(tx, dI(proj["id"]), id)
		dRevision(cur, rev)
		if cur["status"] != "planned" && cur["status"] != "active" {
			dFail(409, "Completed or cancelled crew assignment cannot be edited", "ASSIGNMENT_TERMINAL")
		}
		w := wWorker(tx, dI(p["worker_id"]))
		if !dEqual(cur["worker_id"], w["id"]) {
			wActiveWorker(w)
		}
		wSchedule(tx, p, id)
		dExec(tx.DB, "UPDATE crew_assignments SET worker_id=?,role=?,scheduled_start_on=?,scheduled_end_on=?,pay_basis=?,rate_cents=?,notes=?,revision=revision+1,updated_at=? WHERE id=? AND project_id=?", p["worker_id"], p["role"], p["scheduled_start_on"], p["scheduled_end_on"], p["pay_basis"], p["rate_cents"], p["notes"], tx.Timestamp(), id, proj["id"])
		return wAssignment(tx, dI(proj["id"]), id)
	})
}
func wTransition(c *Context) any {
	id := dID(c, "assignment_id")
	code := "INVALID_ASSIGNMENT_TRANSITION"
	r := dBody(c, "to_status effective_at reason expected_revision", code)
	p := Row{"to_status": dEnum(r["to_status"], "to_status", code, "planned|active|completed|cancelled"), "effective_at": dDatetime(r["effective_at"], "effective_at", code, false), "reason": dText(r["reason"], "reason", code, false), "expected_revision": dInteger(r["expected_revision"], "expected_revision", code, 1)}
	if Str(p["effective_at"]) > c.Timestamp() {
		dInvalid(code, "effective_at", "must not be in the future")
	}
	if p["to_status"] == "cancelled" && p["reason"] == nil {
		dInvalid(code, "reason", "is required when cancelling an assignment")
	}
	return dIdempotent(c, p, 200, "workforce", func(tx *Context) any {
		proj := dProject(tx, true)
		cur := wAssignment(tx, dI(proj["id"]), id)
		dRevision(cur, p["expected_revision"])
		allowed := map[string]string{"planned": "active|completed|cancelled", "active": "completed|cancelled"}[Str(cur["status"])]
		if allowed == "" || !strings.Contains("|"+allowed+"|", "|"+Str(p["to_status"])+"|") {
			dFail(409, "Crew assignment transition is not allowed", code)
		}
		dExec(tx.DB, "UPDATE crew_assignments SET status=?,revision=revision+1,updated_at=? WHERE id=?", p["to_status"], tx.Timestamp(), id)
		dExec(tx.DB, "INSERT INTO crew_assignment_transition_events(project_id,assignment_id,from_status,to_status,effective_at,reason,created_at) VALUES(?,?,?,?,?,?,?)", proj["id"], id, cur["status"], p["to_status"], p["effective_at"], p["reason"], tx.Timestamp())
		return wAssignment(tx, dI(proj["id"]), id)
	})
}
func wLaborResponse(r Row) Row {
	out := dFields(r, "id project_code assignment_id worker_id worker_name replaces_entry_id work_date attendance_status work_minutes pay_basis rate_cents cost_cents work_summary notes status void_reason voided_at revision created_at updated_at")
	out["day_fraction"] = dFraction(r["day_fraction_milli"])
	return out
}
func wLabor(c *Context, project, id int64) Row {
	r := dRow(c.DB, wLaborSelect+" WHERE e.id=? AND e.project_id=?", id, project)
	if r == nil {
		dFail(404, "Labor entry not found", "LABOR_ENTRY_NOT_FOUND")
	}
	return r
}
func wLaborAssignment(c *Context, project, id int64) Row {
	r := dRow(c.DB, "SELECT a.*,w.status worker_status,w.inactive_on FROM crew_assignments a JOIN workers w ON w.id=a.worker_id WHERE a.id=? AND a.project_id=?", id, project)
	if r == nil {
		dFail(404, "Crew assignment not found", "ASSIGNMENT_NOT_FOUND")
	}
	if r["status"] == "cancelled" {
		dFail(409, "Cancelled assignment cannot receive labor entries", "ASSIGNMENT_CANCELLED")
	}
	return r
}
func wAvailable(a Row, date string) {
	if a["worker_status"] == "inactive" && a["inactive_on"] != nil && Str(a["inactive_on"]) <= date {
		dFail(409, "Inactive worker cannot receive a new labor entry", "WORKER_INACTIVE")
	}
}
func wSlot(c *Context, project int64, a Row, date string, exclude int64) {
	if dRow(c.DB, "SELECT id FROM labor_entries WHERE assignment_id=? AND work_date=? AND status='active' AND id<>?", a["id"], date, exclude) != nil {
		dFail(409, "Crew assignment already has a labor entry for this date", "ASSIGNMENT_LABOR_ENTRY_EXISTS")
	}
	if dRow(c.DB, "SELECT id FROM labor_entries WHERE project_id=? AND worker_id=? AND work_date=? AND status='active' AND id<>?", project, a["worker_id"], date, exclude) != nil {
		dFail(409, "Worker already has a labor entry for this project and date", "WORKER_LABOR_ENTRY_EXISTS")
	}
}
func wNormalizeLabor(r Row, code, prefix string, revision bool) Row {
	field := func(s string) string { return prefix + s }
	p := Row{"assignment_id": dInteger(r["assignment_id"], field("assignment_id"), code, 1), "attendance_status": dEnum(r["attendance_status"], field("attendance_status"), code, "present|absent|leave"), "work_summary": dText(r["work_summary"], field("work_summary"), code, false), "notes": dText(r["notes"], field("notes"), code, false), "day_fraction": nil, "day_fraction_milli": nil, "work_minutes": nil}
	if r["day_fraction"] != nil {
		n := dDecimalMilli(r["day_fraction"], field("day_fraction"), code, 1000)
		p["day_fraction_milli"] = n
		p["day_fraction"] = dFraction(n)
	}
	if r["work_minutes"] != nil {
		n := dInteger(r["work_minutes"], field("work_minutes"), code, 1)
		if n > 1440 {
			dInvalid(code, field("work_minutes"), "is out of range")
		}
		p["work_minutes"] = n
	}
	if revision {
		p["expected_revision"] = nil
		if r["expected_revision"] != nil {
			p["expected_revision"] = dInteger(r["expected_revision"], field("expected_revision"), code, 1)
		}
	}
	if _, ok := r["work_date"]; ok {
		p["work_date"] = dDate(r["work_date"], "work_date", code, false)
	}
	return p
}
func wLaborValues(e, a, old Row, code, field string) Row {
	snap := a
	if old != nil {
		snap = old
	}
	basis := Str(snap["pay_basis"])
	rate := dI(snap["rate_cents"])
	cost := int64(0)
	switch e["attendance_status"] {
	case "present":
		if basis == "daily" {
			if e["day_fraction_milli"] == nil || e["work_minutes"] != nil {
				dInvalid(code, field, "daily work requires day_fraction only")
			}
			cost = dRoundMul(rate, dI(e["day_fraction_milli"]), 1000, code, field)
		} else {
			if e["work_minutes"] == nil || e["day_fraction_milli"] != nil {
				dInvalid(code, field, "hourly work requires work_minutes only")
			}
			cost = dRoundMul(rate, dI(e["work_minutes"]), 60, code, field)
		}
	case "absent", "leave":
		if e["day_fraction_milli"] != nil || e["work_minutes"] != nil {
			dInvalid(code, field, "absence or leave cannot contain paid quantity")
		}
	default:
		dInvalid(code, "attendance_status", "is incompatible with assignment pay basis")
	}
	v := dFields(e, "attendance_status day_fraction_milli work_minutes work_summary notes")
	v["assignment_id"] = a["id"]
	v["worker_id"] = a["worker_id"]
	v["pay_basis"] = basis
	v["rate_cents"] = rate
	v["cost_cents"] = cost
	return v
}
func wInsertLabor(c *Context, project int64, date string, v Row, replaced any) int64 {
	return dInsert(c.DB, `INSERT INTO labor_entries(project_id,assignment_id,worker_id,replaces_entry_id,work_date,attendance_status,day_fraction_milli,work_minutes,pay_basis,rate_cents,cost_cents,work_summary,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, project, v["assignment_id"], v["worker_id"], replaced, date, v["attendance_status"], v["day_fraction_milli"], v["work_minutes"], v["pay_basis"], v["rate_cents"], v["cost_cents"], v["work_summary"], v["notes"], c.Timestamp(), c.Timestamp())
}
func wWriteLabor(c *Context, id int64, date string, v Row) {
	dExec(c.DB, `UPDATE labor_entries SET assignment_id=?,worker_id=?,work_date=?,attendance_status=?,day_fraction_milli=?,work_minutes=?,pay_basis=?,rate_cents=?,cost_cents=?,work_summary=?,notes=?,revision=revision+1,updated_at=? WHERE id=?`, v["assignment_id"], v["worker_id"], date, v["attendance_status"], v["day_fraction_milli"], v["work_minutes"], v["pay_basis"], v["rate_cents"], v["cost_cents"], v["work_summary"], v["notes"], c.Timestamp(), id)
}
func wListLabor(c *Context) any {
	p := dProject(c, false)
	where := " WHERE e.project_id=?"
	args := []any{p["id"]}
	dates := map[string]string{}
	for _, f := range []string{"from", "to"} {
		if v, ok := dSingleQuery(c, f, "INVALID_LABOR_FILTER"); ok {
			dates[f] = Str(dDate(v, f, "INVALID_LABOR_FILTER", false))
			op := ">="
			if f == "to" {
				op = "<="
			}
			where += " AND e.work_date" + op + "?"
			args = append(args, v)
		}
	}
	if dates["from"] != "" && dates["to"] != "" && dates["from"] > dates["to"] {
		dInvalid("INVALID_LABOR_FILTER", "from", "must not be after to")
	}
	if v, ok := dSingleQuery(c, "worker_id", "INVALID_LABOR_FILTER"); ok {
		where += " AND e.worker_id=?"
		args = append(args, dTry(PositiveID(v)))
	}
	return dPaged(c, wLaborSelect+where+" ORDER BY e.work_date DESC,e.id DESC", "SELECT count(*) total FROM labor_entries e"+where, args, wLaborResponse)
}
func wCreateLabor(c *Context) any {
	p := wNormalizeLabor(dBody(c, wLaborFields, "INVALID_LABOR_PAYLOAD"), "INVALID_LABOR_PAYLOAD", "", false)
	return dIdempotent(c, p, 201, "workforce", func(tx *Context) any {
		proj := dProject(tx, true)
		pid := dI(proj["id"])
		a := wLaborAssignment(tx, pid, dI(p["assignment_id"]))
		date := Str(p["work_date"])
		wAvailable(a, date)
		wSlot(tx, pid, a, date, 0)
		old := dRow(tx.DB, "SELECT * FROM labor_entries WHERE project_id=? AND worker_id=? AND work_date=? AND status='voided' ORDER BY id DESC LIMIT 1", pid, a["worker_id"], date)
		v := wLaborValues(p, a, old, "INVALID_LABOR_PAYLOAD", "body")
		var replaces any
		if old != nil {
			replaces = old["id"]
		}
		id := wInsertLabor(tx, pid, date, v, replaces)
		return wLaborResponse(wLabor(tx, pid, id))
	})
}
func wUpdateLabor(c *Context) any {
	id := dID(c, "entry_id")
	p := wNormalizeLabor(dBody(c, wLaborFields+" expected_revision", "INVALID_LABOR_PAYLOAD"), "INVALID_LABOR_PAYLOAD", "", true)
	dInteger(p["expected_revision"], "expected_revision", "INVALID_LABOR_PAYLOAD", 1)
	return dTx(c, func(tx *Context) any {
		proj := dProject(tx, false)
		pid := dI(proj["id"])
		cur := wLabor(tx, pid, id)
		wActiveLabor(cur)
		dRevision(cur, p["expected_revision"])
		a := wLaborAssignment(tx, pid, dI(p["assignment_id"]))
		date := Str(p["work_date"])
		if cur["replaces_entry_id"] != nil && (!dEqual(cur["assignment_id"], a["id"]) || !dEqual(cur["worker_id"], a["worker_id"]) || cur["work_date"] != date) {
			dFail(409, "Replacement labor identity cannot be changed; void and create a new record", "LABOR_REPLACEMENT_IDENTITY_IMMUTABLE")
		}
		wAvailable(a, date)
		wSlot(tx, pid, a, date, id)
		var snap Row
		if dEqual(cur["assignment_id"], a["id"]) {
			snap = cur
		}
		wWriteLabor(tx, id, date, wLaborValues(p, a, snap, "INVALID_LABOR_PAYLOAD", "body"))
		return wLaborResponse(wLabor(tx, pid, id))
	})
}
func wActiveLabor(r Row) {
	if r["status"] != "active" {
		dFail(409, "Voided labor entry cannot be changed", "LABOR_ENTRY_VOIDED")
	}
}
func wVoidLabor(c *Context) any {
	id := dID(c, "entry_id")
	code := "INVALID_LABOR_VOID_PAYLOAD"
	r := dBody(c, "reason expected_revision", code)
	p := Row{"reason": dText(r["reason"], "reason", code, true), "expected_revision": dInteger(r["expected_revision"], "expected_revision", code, 1)}
	return dIdempotent(c, p, 200, "workforce", func(tx *Context) any {
		proj := dProject(tx, false)
		pid := dI(proj["id"])
		cur := wLabor(tx, pid, id)
		wActiveLabor(cur)
		dRevision(cur, p["expected_revision"])
		dExec(tx.DB, "UPDATE labor_entries SET status='voided',void_reason=?,voided_at=?,revision=revision+1,updated_at=? WHERE id=?", p["reason"], tx.Timestamp(), tx.Timestamp(), id)
		return wLaborResponse(wLabor(tx, pid, id))
	})
}
func wBatchRevision(old, e Row) bool {
	if e["expected_revision"] == nil {
		same := old["status"] == "active"
		for _, f := range strings.Fields("attendance_status day_fraction_milli work_minutes work_summary notes") {
			same = same && dEqual(old[f], e[f])
		}
		if same {
			return false
		}
		dRevision(old, int64(0))
	}
	dRevision(old, e["expected_revision"])
	return true
}
func wBatch(c *Context) any {
	code := "INVALID_LABOR_BATCH_PAYLOAD"
	raw := dBody(c, "work_date entries", code)
	date := Str(dDate(raw["work_date"], "work_date", code, false))
	entries, ok := raw["entries"].([]any)
	if !ok || len(entries) == 0 {
		dInvalid(code, "entries", "must be a non-empty array")
	}
	items := []Row{}
	seen := map[int64]bool{}
	for i, v := range entries {
		r, ok := v.(map[string]any)
		if !ok {
			dInvalid(code, fmt.Sprintf("entries.%d", i), "has invalid fields")
		}
		dExact(r, "assignment_id attendance_status day_fraction work_minutes work_summary notes expected_revision", code)
		e := wNormalizeLabor(r, code, fmt.Sprintf("entries.%d.", i), true)
		id := dI(e["assignment_id"])
		if seen[id] {
			dInvalid(code, fmt.Sprintf("entries.%d.assignment_id", i), "is duplicated in this batch")
		}
		seen[id] = true
		items = append(items, e)
	}
	p := Row{"work_date": date, "entries": items}
	return dIdempotent(c, p, 200, "workforce", func(tx *Context) any {
		proj := dProject(tx, false)
		pid := dI(proj["id"])
		type prepared struct{ e, a, old, replaced Row }
		preparedItems := []prepared{}
		workers := map[int64]bool{}
		for i, e := range items {
			a := wLaborAssignment(tx, pid, dI(e["assignment_id"]))
			worker := dI(a["worker_id"])
			if workers[worker] {
				dInvalid("DUPLICATE_WORKER_IN_LABOR_BATCH", fmt.Sprintf("entries.%d.assignment_id", i), "worker already occurs in this batch")
			}
			workers[worker] = true
			old := dRow(tx.DB, "SELECT * FROM labor_entries WHERE assignment_id=? AND work_date=? AND status='active' ORDER BY id DESC LIMIT 1", a["id"], date)
			var replaced Row
			if old == nil {
				replaced = dRow(tx.DB, "SELECT * FROM labor_entries WHERE project_id=? AND worker_id=? AND work_date=? AND status='voided' ORDER BY id DESC LIMIT 1", pid, worker, date)
			}
			other := dRow(tx.DB, "SELECT id FROM labor_entries WHERE project_id=? AND worker_id=? AND work_date=? AND status='active' ORDER BY id DESC LIMIT 1", pid, worker, date)
			if other != nil && (old == nil || !dEqual(other["id"], old["id"])) {
				dFail(409, "Worker already has a labor entry for this project and date", "WORKER_LABOR_ENTRY_EXISTS")
			}
			preparedItems = append(preparedItems, prepared{e, a, old, replaced})
		}
		out := []Row{}
		for _, x := range preparedItems {
			if x.old == nil && proj["status"] == "archived" {
				dFail(409, "Archived project cannot accept new labor entries", "PROJECT_ARCHIVED")
			}
			if x.old == nil && x.replaced == nil {
				wAvailable(x.a, date)
			}
			snap := x.old
			if snap == nil {
				snap = x.replaced
			}
			v := wLaborValues(x.e, x.a, snap, code, "entries")
			var id int64
			if x.old == nil {
				var replace any
				if x.replaced != nil {
					wBatchRevision(x.replaced, x.e)
					replace = x.replaced["id"]
				}
				id = wInsertLabor(tx, pid, date, v, replace)
			} else {
				id = dI(x.old["id"])
				wActiveLabor(x.old)
				if wBatchRevision(x.old, x.e) {
					wWriteLabor(tx, id, date, v)
				}
			}
			out = append(out, wLaborResponse(wLabor(tx, pid, id)))
		}
		return Row{"work_date": date, "items": out}
	})
}
