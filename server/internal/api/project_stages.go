package api

import (
	"fmt"
	"github.com/google/uuid"
	"strings"
	"time"
)

var businessStageCodes = []string{"planning", "site_survey", "quotation", "technical_agreement", "contract", "advance_payment", "mechanical_design", "electrical_design", "procurement", "staffing", "mechanical_signoff", "electrical_signoff", "construction", "progress_payment", "commissioning", "acceptance", "final_payment", "closeout"}
var businessStageFields = []string{"stage_code", "status", "status_reason", "planned_start_on", "planned_end_on", "started_at", "blocked_at", "completed_at", "notes", "revision"}
var businessStageTransitions = map[string][]string{"pending": {"in_progress", "skipped"}, "in_progress": {"blocked", "completed", "skipped"}, "blocked": {"in_progress", "skipped"}, "completed": {"in_progress"}, "skipped": {"in_progress"}}

func businessStageList(db DBTX, id any) ([]Row, error) {
	rows, e := All(db, "SELECT stage_code,sequence,status,status_reason,planned_start_on,planned_end_on,started_at,blocked_at,completed_at,notes,revision FROM project_stages WHERE project_id=? ORDER BY sequence", id)
	if e != nil {
		return nil, e
	}
	if len(rows) != len(businessStageCodes) {
		return nil, fmt.Errorf("project stage catalog is incomplete")
	}
	out := []Row{}
	for i, r := range rows {
		if r["stage_code"] != businessStageCodes[i] || businessInt(r["sequence"]) != int64(i+1) {
			return nil, fmt.Errorf("project stage catalog is incomplete")
		}
		out = append(out, Fields(r, businessStageFields...))
	}
	return out, nil
}
func businessDate(v any, optional bool, detail string) (any, error) {
	if v == nil && optional {
		return nil, nil
	}
	s, ok := v.(string)
	if !ok || len(s) != 10 {
		return nil, E(422, detail, "VALIDATION_ERROR")
	}
	t, e := time.Parse("2006-01-02", s)
	if e != nil || t.Format("2006-01-02") != s {
		return nil, E(422, detail, "VALIDATION_ERROR")
	}
	return s, nil
}
func businessTimestamp(v any, detail string) (string, error) {
	s, ok := v.(string)
	if !ok {
		return "", E(422, detail, "VALIDATION_ERROR")
	}
	s = strings.Replace(s, " ", "T", 1)
	t, e := time.Parse(time.RFC3339Nano, s)
	if e != nil {
		return "", E(422, detail, "VALIDATION_ERROR")
	}
	t = t.UTC()
	format := "2006-01-02T15:04:05"
	if t.Nanosecond() != 0 {
		format += ".000000"
	}
	return t.Format(format) + "+00:00", nil
}
func businessStageError(code, field string) error {
	e := E(422, strings.ReplaceAll(strings.ToLower(code), "_", " "), code)
	switch code {
	case "INVALID_STAGE_CODE":
		e.Detail = "Invalid stage code"
	case "INVALID_PROJECT_CODE":
		e.Detail = "Invalid project code"
	}
	e.FieldErrors = Row{field: []string{"is invalid"}}
	return e
}
func businessStageProject(c *Context, active bool) (Row, error) {
	key, e := ProjectIdentity(c.R.PathValue("project_code"))
	if e != nil {
		return nil, businessStageError("INVALID_PROJECT_CODE", "project_code")
	}
	p, e := businessProject(c.DB, key, false)
	if e != nil {
		if a, ok := e.(*APIError); ok && a.Status == 404 {
			return nil, E(404, "Project not found", "PROJECT_NOT_FOUND")
		}
		return nil, e
	}
	if active && p["status"] == "archived" {
		return nil, E(409, "Project is archived", "PROJECT_ARCHIVED")
	}
	return p, nil
}
func registerProjectStages(s *Server) {
	businessHandle(s, "GET /api/projects/{project_code}/stages", func(c *Context) (any, error) {
		p, e := businessStageProject(c, false)
		if e != nil {
			return nil, e
		}
		return businessStageList(c.DB, p["id"])
	})
	businessHandle(s, "PUT /api/projects/{project_code}/stages/{stage_code}", func(c *Context) (any, error) {
		stage := c.R.PathValue("stage_code")
		if !businessIn(stage, businessStageCodes...) {
			return nil, businessStageError("INVALID_STAGE_CODE", "stage_code")
		}
		p, e := c.Body()
		if e != nil {
			return nil, e
		}
		detail := "Invalid stage payload"
		if !businessExact(p, "planned_start_on", "planned_end_on", "notes", "expected_revision") {
			return nil, E(422, detail, "VALIDATION_ERROR")
		}
		for _, f := range []string{"planned_start_on", "planned_end_on"} {
			p[f], e = businessDate(p[f], true, detail)
			if e != nil {
				return nil, e
			}
		}
		if p["planned_start_on"] != nil && p["planned_end_on"] != nil && Str(p["planned_start_on"]) > Str(p["planned_end_on"]) {
			return nil, E(422, detail, "VALIDATION_ERROR")
		}
		p["notes"], e = businessText(p["notes"], false, detail)
		if e != nil {
			return nil, E(422, detail, "VALIDATION_ERROR")
		}
		p["expected_revision"], e = businessPositive(p["expected_revision"], detail)
		if e != nil {
			return nil, e
		}
		return c.Tx(func(t *Context) (any, error) {
			project, e := businessStageProject(t, true)
			if e != nil {
				return nil, e
			}
			r, e := One(t.DB, "SELECT * FROM project_stages WHERE project_id=? AND stage_code=?", project["id"], stage)
			if e != nil {
				return nil, e
			}
			if r == nil {
				return nil, fmt.Errorf("project stage is missing")
			}
			if e = businessRevision(r, p["expected_revision"]); e != nil {
				return nil, e
			}
			_, e = t.DB.Exec("UPDATE project_stages SET planned_start_on=?,planned_end_on=?,notes=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?", p["planned_start_on"], p["planned_end_on"], p["notes"], t.Timestamp(), r["id"], p["expected_revision"])
			if e != nil {
				return nil, e
			}
			r, e = One(t.DB, "SELECT * FROM project_stages WHERE id=?", r["id"])
			return Fields(r, businessStageFields...), e
		})
	})
	businessHandle(s, "POST /api/projects/{project_code}/stages/{stage_code}/transition", func(c *Context) (any, error) {
		stage := c.R.PathValue("stage_code")
		if !businessIn(stage, businessStageCodes...) {
			return nil, businessStageError("INVALID_STAGE_CODE", "stage_code")
		}
		keys := c.R.Header.Values("Idempotency-Key")
		if len(keys) != 1 {
			e := E(422, "Invalid Idempotency-Key", "INVALID_IDEMPOTENCY_KEY")
			e.FieldErrors = Row{"Idempotency-Key": []string{"must occur once"}}
			return nil, e
		}
		uid, e := uuid.Parse(keys[0])
		if e != nil {
			a := E(422, "Invalid Idempotency-Key", "INVALID_IDEMPOTENCY_KEY")
			a.FieldErrors = Row{"Idempotency-Key": []string{"must be a UUID"}}
			return nil, a
		}
		key := uid.String()
		p, e := c.Body()
		if e != nil {
			return nil, e
		}
		detail := "Invalid stage transition"
		if !businessExact(p, "to_status", "occurred_at", "reason", "expected_revision") || !businessIn(Str(p["to_status"]), "pending", "in_progress", "blocked", "completed", "skipped") {
			return nil, E(422, detail, "VALIDATION_ERROR")
		}
		p["occurred_at"], e = businessTimestamp(p["occurred_at"], detail)
		if e != nil {
			return nil, e
		}
		p["reason"], e = businessText(p["reason"], false, detail)
		if e != nil {
			return nil, E(422, detail, "VALIDATION_ERROR")
		}
		p["expected_revision"], e = businessPositive(p["expected_revision"], detail)
		if e != nil {
			return nil, e
		}
		hash, e := businessCompactHash(p)
		if e != nil {
			return nil, e
		}
		return c.Tx(func(t *Context) (any, error) {
			previous, e := RestoreIdempotent(t.DB, t.R, key, hash)
			if previous != nil || e != nil {
				return previous, e
			}
			project, e := businessStageProject(t, true)
			if e != nil {
				return nil, e
			}
			r, e := One(t.DB, "SELECT * FROM project_stages WHERE project_id=? AND stage_code=?", project["id"], stage)
			if e != nil {
				return nil, e
			}
			if r == nil {
				return nil, fmt.Errorf("project stage is missing")
			}
			if e = businessRevision(r, p["expected_revision"]); e != nil {
				return nil, e
			}
			from, to := Str(r["status"]), Str(p["to_status"])
			if !businessIn(to, businessStageTransitions[from]...) {
				return nil, E(409, detail, "INVALID_STAGE_TRANSITION")
			}
			if (businessIn(to, "blocked", "skipped") || (to == "in_progress" && businessIn(from, "blocked", "completed", "skipped"))) && p["reason"] == nil {
				a := E(422, detail, "INVALID_STAGE_TRANSITION")
				a.FieldErrors = Row{"reason": []string{"Reason is required"}}
				return nil, a
			}
			started := r["started_at"]
			var blocked, completed any
			if to == "in_progress" && started == nil {
				started = p["occurred_at"]
			}
			if to == "blocked" {
				blocked = p["occurred_at"]
			}
			if businessIn(to, "completed", "skipped") {
				completed = p["occurred_at"]
			}
			at := t.Timestamp()
			revision := businessInt(p["expected_revision"]) + 1
			_, e = t.DB.Exec("UPDATE project_stages SET status=?,status_reason=?,started_at=?,blocked_at=?,completed_at=?,revision=?,updated_at=? WHERE id=? AND revision=?", to, p["reason"], started, blocked, completed, revision, at, r["id"], p["expected_revision"])
			if e != nil {
				return nil, e
			}
			_, e = t.DB.Exec("INSERT INTO project_stage_events(project_stage_id,from_status,to_status,reason,occurred_at,resulting_revision,created_at) VALUES(?,?,?,?,?,?,?)", r["id"], from, to, p["reason"], p["occurred_at"], revision, at)
			if e != nil {
				return nil, e
			}
			out, e := One(t.DB, "SELECT * FROM project_stages WHERE id=?", r["id"])
			if e != nil {
				return nil, e
			}
			out = Fields(out, businessStageFields...)
			e = SaveIdempotent(t.DB, t.R, key, hash, out, 200, "project_stage_transition", businessInt(r["id"]), at)
			return out, e
		})
	})
}
