package api

import (
	"fmt"
	"testing"
)

func TestBusinessProjectsUnicodeCloseRestoreAndEvents(t *testing.T) {
	s := businessTestServer(t)
	company := businessTestCompany(t, s, "客户")
	p := businessTestProject(t, s, company, "Straße")
	businessExpect(t, s, "POST", "/api/projects", Row{"project_code": "STRASSE", "company_id": company["id"], "name": "同项目", "description": nil}, "", 409)
	url := "/api/projects/STRASSE"
	detail := businessExpect(t, s, "GET", url, nil, "", 200)
	if detail["project_code"] != "Straße" {
		t.Fatal(detail)
	}
	businessExpect(t, s, "POST", url+"/archive", nil, "", 410)
	blocked := businessExpect(t, s, "POST", url+"/close", Row{"closure_type": "completed", "reason": "完工", "expected_revision": 1}, "673cefa1-e9a8-4efc-901f-d2b54d7c0ef0", 409)
	if blocked["error_code"] != "PROJECT_COMPLETION_BLOCKED" {
		t.Fatal(blocked)
	}
	dashboard := businessExpect(t, s, "GET", url+"/dashboard", nil, "", 200)
	if dashboard["completion_check"].(map[string]any)["ready"] != false {
		t.Fatal(dashboard)
	}
	key := "709af675-b08e-44d1-b345-c10df00ac605"
	payload := Row{"closure_type": "cancelled", "reason": "客户取消", "expected_revision": 1}
	closed := businessExpect(t, s, "POST", url+"/close", payload, key, 200)
	if closed["status"] != "archived" || businessInt(closed["revision"]) != 2 {
		t.Fatal(closed)
	}
	businessExpect(t, s, "POST", url+"/close", payload, key, 200)
	restoreKey := "cff9f382-bdae-4896-b4a6-4a6d62748221"
	restore := Row{"reason": "重启项目", "expected_revision": 2}
	out := businessExpect(t, s, "POST", url+"/restore", restore, restoreKey, 200)
	businessExpect(t, s, "POST", url+"/restore", restore, restoreKey, 200)
	if out["closure_type"] != nil || out["status"] != "active" || businessInt(out["revision"]) != 3 {
		t.Fatal(out)
	}
	events, e := All(s.DB, "SELECT * FROM project_restore_events WHERE project_id=?", p["id"])
	if e != nil || len(events) != 1 || events[0]["from_closure_type"] != "cancelled" {
		t.Fatalf("events=%v error=%v", events, e)
	}
	businessExpect(t, s, "PUT", url, Row{"company_id": company["id"], "name": "stale", "description": nil, "expected_revision": 1}, "", 409)
}
func TestBusinessProjectStageTransitionsAreAtomic(t *testing.T) {
	s := businessTestServer(t)
	company := businessTestCompany(t, s, "甲方")
	project := businessTestProject(t, s, company, "STAGE-1")
	url := "/api/projects/STAGE-1/stages/planning"
	payload := Row{"to_status": "in_progress", "occurred_at": "2026-10-12T17:00:00+08:00", "reason": nil, "expected_revision": 1}
	key := "757f4c13-5d41-48ba-8d41-54a2ef2bd3a1"
	out := businessExpect(t, s, "POST", url+"/transition", payload, key, 200)
	if out["started_at"] != "2026-10-12T09:00:00+00:00" {
		t.Fatal(out)
	}
	businessExpect(t, s, "POST", url+"/transition", payload, key, 200)
	payload["to_status"] = "blocked"
	payload["expected_revision"] = 2
	businessExpect(t, s, "POST", url+"/transition", payload, key, 409)
	missing := businessExpect(t, s, "POST", url+"/transition", payload, "f1aa4a85-059d-4271-9ff5-99f514f80cb9", 422)
	if missing["error_code"] != "INVALID_STAGE_TRANSITION" {
		t.Fatal(missing)
	}
	payload["reason"] = "等待材料"
	out = businessExpect(t, s, "POST", url+"/transition", payload, "f1aa4a85-059d-4271-9ff5-99f514f80cb9", 200)
	if out["blocked_at"] == nil || businessInt(out["revision"]) != 3 {
		t.Fatal(out)
	}
	count, e := One(s.DB, "SELECT COUNT(*) AS n FROM project_stage_events e JOIN project_stages s ON s.id=e.project_stage_id WHERE s.project_id=?", project["id"])
	if e != nil || businessInt(count["n"]) != 2 {
		t.Fatalf("count=%v %v", count, e)
	}
	bad := businessExpect(t, s, "PUT", url, Row{"planned_start_on": "2026-10-13", "planned_end_on": "2026-10-12", "notes": nil, "expected_revision": 3}, "", 422)
	if bad["error_code"] != "INVALID_STAGE_PAYLOAD" {
		t.Fatal(bad)
	}
	for i, status := range []string{"in_progress", "completed", "in_progress", "skipped"} {
		payload = Row{"to_status": status, "occurred_at": "2026-10-12T10:00:00Z", "reason": "调整", "expected_revision": 3 + i}
		businessExpect(t, s, "POST", url+"/transition", payload, fmt.Sprintf("00000000-0000-0000-0000-%012d", i+1), 200)
	}
}

func TestBusinessProjectCloseCommitFailureRollsBackStateAndIdempotency(t *testing.T) {
	s := businessTestServer(t)
	company := businessTestCompany(t, s, "事务客户")
	project := businessTestProject(t, s, company, "ROLLBACK-1")
	businessTestExec(t, s, "CREATE TABLE commit_guard(parent_id INTEGER REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED)")
	businessTestExec(t, s, "CREATE TRIGGER reject_project_commit AFTER UPDATE ON projects BEGIN INSERT INTO commit_guard(parent_id) VALUES(999999); END")
	key := "7f86c4a5-612d-4168-aa10-7790db77fd33"
	payload := Row{"closure_type": "cancelled", "reason": "取消", "expected_revision": 1}
	failed := businessExpect(t, s, "POST", "/api/projects/ROLLBACK-1/close", payload, key, 500)
	if failed["detail"] != "Project operation failed" {
		t.Fatal("transaction failure leaked internal details", failed)
	}
	stored, e := One(s.DB, "SELECT status,revision FROM projects WHERE id=?", project["id"])
	if e != nil || stored["status"] != "active" || businessInt(stored["revision"]) != 1 {
		t.Fatal("failed commit changed project", stored, e)
	}
	guard, e := One(s.DB, "SELECT COUNT(*) AS n FROM commit_guard")
	if e != nil || businessInt(guard["n"]) != 0 {
		t.Fatal("failed commit retained auxiliary writes", guard, e)
	}
	businessTestExec(t, s, "DROP TRIGGER reject_project_commit")
	closed := businessExpect(t, s, "POST", "/api/projects/ROLLBACK-1/close", payload, key, 200)
	if closed["status"] != "archived" || businessInt(closed["revision"]) != 2 {
		t.Fatal("failed transaction retained an idempotency response", closed)
	}
}
