package api

import (
	"golang.org/x/text/unicode/norm"
	"strings"
	"time"
)

var businessProjectFields = []string{"id", "project_code", "company_id", "company_name", "name", "description", "status", "closure_type", "archive_reason", "archived_at", "revision", "created_at", "updated_at"}

const businessProjectQuery = `SELECT p.id,p.project_code,p.company_id,c.name AS company_name,p.name,p.description,p.status,p.closure_type,p.archive_reason,p.archived_at,p.revision,p.created_at,p.updated_at FROM projects p JOIN companies c ON c.id=p.company_id`

func businessProject(db DBTX, key string, active bool) (Row, error) {
	r, e := One(db, businessProjectQuery+" WHERE p.project_code_key=?", key)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, businessMissing("Project")
	}
	if active && r["status"] != "active" {
		return nil, E(409, "Project is archived", "PROJECT_ARCHIVED")
	}
	return r, nil
}
func businessProjectKey(c *Context) (string, error) {
	key, e := ProjectIdentity(c.R.PathValue("project_code"))
	if e != nil {
		return "", E(422, "Invalid project code", "VALIDATION_ERROR")
	}
	return key, nil
}
func businessToday(c *Context) string {
	return c.S.Now().In(time.FixedZone("Asia/Shanghai", 8*3600)).Format("2006-01-02")
}
func registerProjects(s *Server) {
	businessHandle(s, "GET /api/projects", func(c *Context) (any, error) {
		values, ok := c.R.URL.Query()["status"]
		status := "active"
		if ok {
			if len(values) != 1 || !businessIn(values[0], "active", "archived", "all") {
				return nil, E(422, "Invalid project status", "")
			}
			status = values[0]
		}
		q := `SELECT p.id,p.project_code,p.company_id,p.name,p.description,p.status,p.archive_reason,p.archived_at,p.created_at,p.updated_at,c.name AS company_name FROM projects p JOIN companies c ON c.id=p.company_id`
		args := []any{}
		if status != "all" {
			q += " WHERE p.status=?"
			args = append(args, status)
		}
		return All(c.DB, q+" ORDER BY p.created_at DESC,p.id DESC", args...)
	})
	businessHandle(s, "POST /api/projects", func(c *Context) (any, error) {
		p, e := c.Body()
		if e != nil {
			return nil, e
		}
		if !businessExact(p, "project_code", "company_id", "name", "description") {
			return nil, E(422, "Invalid project payload", "")
		}
		code := norm.NFC.String(strings.TrimSpace(Str(p["project_code"])))
		key, e := ProjectIdentity(code)
		if e != nil {
			return nil, E(422, "Invalid project payload", "")
		}
		id, e := businessPositive(p["company_id"], "Invalid project payload")
		if e != nil {
			return nil, E(422, "Invalid project payload", "")
		}
		name, e := businessText(p["name"], true, "Invalid project payload")
		if e != nil {
			return nil, e
		}
		desc, e := businessText(p["description"], false, "Invalid project payload")
		if e != nil {
			return nil, e
		}
		c.Status = 201
		return c.Tx(func(t *Context) (any, error) {
			at := t.Timestamp()
			pid, e := Insert(t.DB, "INSERT INTO projects(project_code,project_code_key,company_id,name,description,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", code, key, id, name, desc, at, at)
			if e != nil {
				if strings.Contains(e.Error(), "UNIQUE") {
					return nil, E(409, "Project code already exists", "")
				}
				if strings.Contains(e.Error(), "FOREIGN KEY") {
					return nil, E(404, "Company not found", "")
				}
				return nil, e
			}
			return One(t.DB, "SELECT id,project_code,company_id,name,description,status,archive_reason,archived_at,created_at,updated_at FROM projects WHERE id=?", pid)
		})
	})
	businessHandle(s, "POST /api/projects/{project_code}/archive", func(c *Context) (any, error) {
		return nil, E(410, "Project archive endpoint is retired; use project close", "PROJECT_ARCHIVE_RETIRED")
	})
	businessHandle(s, "GET /api/projects/{project_code}", func(c *Context) (any, error) {
		key, e := businessProjectKey(c)
		if e != nil {
			return nil, e
		}
		return businessProject(c.DB, key, false)
	})
	businessHandle(s, "PUT /api/projects/{project_code}", func(c *Context) (any, error) {
		key, e := businessProjectKey(c)
		if e != nil {
			return nil, e
		}
		p, e := c.Body()
		if e != nil {
			return nil, e
		}
		if !businessExact(p, "company_id", "name", "description", "expected_revision") {
			return nil, E(422, "Invalid project payload", "VALIDATION_ERROR")
		}
		for _, f := range []string{"company_id", "expected_revision"} {
			p[f], e = businessPositive(p[f], "Invalid project payload")
			if e != nil {
				return nil, e
			}
		}
		for _, f := range []string{"name", "description"} {
			p[f], e = businessText(p[f], f == "name", "Invalid project payload")
			if e != nil {
				return nil, E(422, "Invalid project payload", "VALIDATION_ERROR")
			}
		}
		return c.Tx(func(t *Context) (any, error) {
			r, e := businessProject(t.DB, key, true)
			if e != nil {
				return nil, e
			}
			if e = businessRevision(r, p["expected_revision"]); e != nil {
				return nil, e
			}
			company, e := One(t.DB, "SELECT id FROM companies WHERE id=?", p["company_id"])
			if e != nil {
				return nil, e
			}
			if company == nil {
				return nil, businessMissing("Company")
			}
			_, e = t.DB.Exec("UPDATE projects SET company_id=?,name=?,description=?,revision=revision+1,updated_at=? WHERE project_code_key=? AND revision=?", p["company_id"], p["name"], p["description"], t.Timestamp(), key, p["expected_revision"])
			if e != nil {
				return nil, e
			}
			return businessProject(t.DB, key, false)
		})
	})
	for _, action := range []string{"close", "restore"} {
		action := action
		businessHandle(s, "POST /api/projects/{project_code}/"+action, func(c *Context) (any, error) {
			key, e := businessProjectKey(c)
			if e != nil {
				return nil, e
			}
			idem, e := businessIdempotencyKey(c.R, true)
			if e != nil {
				return nil, e
			}
			p, e := c.Body()
			if e != nil {
				return nil, e
			}
			fields := []string{"reason", "expected_revision"}
			if action == "close" {
				fields = append(fields, "closure_type")
			}
			detail := "Invalid project " + action + " payload"
			if !businessExact(p, fields...) {
				return nil, E(422, detail, "VALIDATION_ERROR")
			}
			p["reason"], e = businessText(p["reason"], true, detail)
			if e != nil {
				return nil, E(422, detail, "VALIDATION_ERROR")
			}
			p["expected_revision"], e = businessPositive(p["expected_revision"], detail)
			if e != nil {
				return nil, e
			}
			if action == "close" && !businessIn(Str(p["closure_type"]), "cancelled", "completed") {
				return nil, E(422, detail, "VALIDATION_ERROR")
			}
			hash, e := businessCompactHash(p)
			if e != nil {
				return nil, e
			}
			return c.Tx(func(t *Context) (any, error) {
				t = businessScopedRequest(t, "/api/projects/"+key+"/"+action)
				old, e := RestoreIdempotent(t.DB, t.R, idem, hash)
				if old != nil || e != nil {
					return old, e
				}
				r, e := businessProject(t.DB, key, false)
				if e != nil {
					return nil, e
				}
				if action == "close" && r["status"] != "active" {
					return nil, E(409, "Project is already closed", "PROJECT_ALREADY_CLOSED")
				}
				if action == "restore" && r["status"] != "archived" {
					return nil, E(409, "Project is already active", "PROJECT_ALREADY_ACTIVE")
				}
				if e = businessRevision(r, p["expected_revision"]); e != nil {
					return nil, e
				}
				at := t.Timestamp()
				resource := "project"
				if action == "close" {
					if p["closure_type"] == "completed" {
						op, e := businessOperating(t, r, businessToday(t), true)
						if e != nil {
							return nil, e
						}
						check, e := businessCompletion(t.DB, r, op)
						if e != nil {
							return nil, e
						}
						if check["ready"] != true {
							return nil, businessCompletionError(check)
						}
					}
					_, e = t.DB.Exec("UPDATE projects SET status='archived',closure_type=?,archive_reason=?,archived_at=?,revision=revision+1,updated_at=? WHERE project_code_key=? AND revision=?", p["closure_type"], p["reason"], at, at, key, p["expected_revision"])
				} else {
					resource = "project_restore"
					_, e = t.DB.Exec("UPDATE projects SET status='active',closure_type=NULL,archive_reason=NULL,archived_at=NULL,revision=revision+1,updated_at=? WHERE project_code_key=? AND revision=?", at, key, p["expected_revision"])
					if e == nil {
						_, e = t.DB.Exec("INSERT INTO project_restore_events(project_id,from_closure_type,from_archive_reason,from_archived_at,restore_reason,expected_revision,resulting_revision,created_at) VALUES(?,?,?,?,?,?,?,?)", r["id"], r["closure_type"], r["archive_reason"], r["archived_at"], p["reason"], p["expected_revision"], businessInt(p["expected_revision"])+1, at)
					}
				}
				if e != nil {
					return nil, e
				}
				out, e := businessProject(t.DB, key, false)
				if e == nil {
					e = SaveIdempotent(t.DB, t.R, idem, hash, out, 200, resource, businessInt(r["id"]), at)
				}
				return out, e
			})
		})
	}
	businessHandle(s, "GET /api/projects/{project_code}/dashboard", businessProjectDashboard)
}
func businessIn(s string, values ...string) bool {
	for _, v := range values {
		if s == v {
			return true
		}
	}
	return false
}
func businessCompletion(db DBTX, p, operating Row) (Row, error) {
	stages := operating["stages"].([]Row)
	ready := len(stages) > 0
	for _, stage := range stages {
		if !businessIn(Str(stage["status"]), "completed", "skipped") {
			ready = false
		}
	}
	final, e := One(db, "SELECT status FROM acceptances WHERE project_id=? AND acceptance_type='final' ORDER BY COALESCE(performed_on,scheduled_on,'') DESC,id DESC LIMIT 1", p["id"])
	if e != nil {
		return nil, e
	}
	finalReady := final != nil && businessIn(Str(final["status"]), "passed", "passed_with_punch")
	out, e := One(db, `SELECT COALESCE(SUM(CASE WHEN received_amount>=contract_amount THEN 0 ELSE contract_amount-received_amount END),0) AS amount FROM(SELECT a.id,a.amount_cents AS contract_amount,COALESCE(SUM(r.amount_cents),0) AS received_amount FROM contract_project_allocations a JOIN contracts c ON c.id=a.contract_id LEFT JOIN receipts r ON r.contract_allocation_id=a.id AND r.status='active' WHERE a.project_id=? AND c.status IN ('signed','completed') GROUP BY a.id,a.amount_cents)`, p["id"])
	if e != nil {
		return nil, e
	}
	received := businessInt(operating["receivables"].(Row)["outstanding_receivable_cents"]) == 0 && businessInt(out["amount"]) == 0
	blockers := []string{}
	if !ready {
		blockers = append(blockers, "PROJECT_STAGES_INCOMPLETE")
	}
	if !finalReady {
		blockers = append(blockers, "FINAL_ACCEPTANCE_NOT_PASSED")
	}
	if !received {
		blockers = append(blockers, "RECEIVABLES_OUTSTANDING")
	}
	return Row{"stages_ready": ready, "final_acceptance_ready": finalReady, "receivables_ready": received, "ready": len(blockers) == 0, "blockers": blockers}, nil
}
func businessCompletionError(r Row) error {
	e := E(409, "Project completion requirements are not met", "PROJECT_COMPLETION_BLOCKED")
	e.FieldErrors = Row{}
	if r["stages_ready"] != true {
		e.FieldErrors["stages"] = "所有项目阶段必须为已完成或已跳过"
	}
	if r["final_acceptance_ready"] != true {
		e.FieldErrors["final_acceptance"] = "必须存在结果为通过或带整改通过的最终验收"
	}
	if r["receivables_ready"] != true {
		e.FieldErrors["receivables"] = "项目未收款必须为 0"
	}
	return e
}
func businessProjectDashboard(c *Context) (any, error) {
	key, e := businessProjectKey(c)
	if e != nil {
		return nil, e
	}
	return c.ReadTx(func(t *Context) (any, error) {
		p, e := businessProject(t.DB, key, false)
		if e != nil {
			return nil, e
		}
		r, e := businessOperating(t, p, businessToday(t), true)
		if e != nil {
			return nil, e
		}
		r["project"] = p
		r["company"], e = One(t.DB, "SELECT id,name,taxpayer_id,registered_address,registered_phone,bank_name,bank_account,notes,created_at,updated_at FROM companies WHERE id=?", p["company_id"])
		if e != nil {
			return nil, e
		}
		r["contacts"], e = All(t.DB, "SELECT id,company_id,name,phone,email,position,notes,created_at,updated_at FROM contacts WHERE company_id=? ORDER BY id", p["company_id"])
		if e != nil {
			return nil, e
		}
		totals, e := One(t.DB, "SELECT COUNT(DISTINCT d.id) AS document_count,COUNT(v.id) AS version_count FROM documents d LEFT JOIN document_versions v ON v.document_id=d.id WHERE d.project_code=? COLLATE NOCASE", p["project_code"])
		if e != nil {
			return nil, e
		}
		totals["categories"], e = All(t.DB, "SELECT d.category,COUNT(DISTINCT d.id) AS document_count,COUNT(v.id) AS version_count FROM documents d LEFT JOIN document_versions v ON v.document_id=d.id WHERE d.project_code=? COLLATE NOCASE GROUP BY d.category ORDER BY d.category COLLATE NOCASE,d.category", p["project_code"])
		if e != nil {
			return nil, e
		}
		r["documents"] = totals
		r["completion_check"], e = businessCompletion(t.DB, p, r)
		return r, e
	})
}
