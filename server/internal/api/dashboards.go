package api

import (
	"sort"
	"strings"
	"time"
)

func registerDashboards(s *Server) {
	businessHandle(s, "GET /api/dashboard", func(c *Context) (any, error) {
		return c.ReadTx(func(t *Context) (any, error) {
			rows, e := All(t.DB, businessProjectQuery+" WHERE p.status='active' ORDER BY p.created_at DESC,p.id DESC")
			if e != nil {
				return nil, e
			}
			summary := Row{"active_project_count": len(rows), "overdue_receivable_count": int64(0), "upcoming_delivery_count": int64(0), "contracted_amount_cents": int64(0), "received_amount_cents": int64(0), "outstanding_receivable_cents": int64(0)}
			out := []Row{}
			todos := []Row{}
			today := businessToday(t)
			for _, p := range rows {
				op, e := businessOperating(t, p, today, false)
				if e != nil {
					return nil, e
				}
				date, e := businessFinalDelivery(t.DB, p["id"])
				if e != nil {
					return nil, e
				}
				receivables, profit := op["receivables"].(Row), op["profit"].(Row)
				out = append(out, Row{"project": p, "current_stage": businessCurrentStage(op["stages"].([]Row)), "contracted_amount_cents": profit["contracted_amount_cents"], "received_amount_cents": receivables["received_amount_cents"], "outstanding_receivable_cents": receivables["outstanding_receivable_cents"], "final_delivery_on": date, "actual_profit_cents": profit["actual_profit_cents"]})
				todos = append(todos, op["todos"].([]Row)...)
				for _, f := range []string{"contracted_amount_cents", "received_amount_cents", "outstanding_receivable_cents"} {
					businessAdd(summary, f, businessInt(receivables[f]))
				}
				for _, term := range receivables["terms"].([]Row) {
					if term["is_overdue"] == true {
						businessAdd(summary, "overdue_receivable_count", 1)
					}
				}
				if businessUpcoming(date, today) {
					businessAdd(summary, "upcoming_delivery_count", 1)
				}
			}
			backup, e := businessBackupHealth(t)
			if e != nil {
				return nil, e
			}
			if backup["healthy"] == false {
				todos = append(todos, Row{"code": "BACKUP_UNHEALTHY", "severity": "danger", "project_code": nil, "due_on": nil, "title": "Backup requires attention", "description": backup["message"]})
			}
			return Row{"generated_at": t.Timestamp(), "summary": summary, "projects": out, "todos": businessSortedTodos(todos), "backup": backup}, nil
		})
	})
}
func businessOperating(c *Context, p Row, today string, details bool) (Row, error) {
	stages, e := businessStageList(c.DB, p["id"])
	if e != nil {
		return nil, e
	}
	var quote any
	contracts := []Row{}
	if details {
		row, e := One(c.DB, "SELECT * FROM quotes WHERE project_id=? AND status='accepted' ORDER BY version_number DESC,id DESC LIMIT 1", p["id"])
		if e != nil {
			return nil, e
		}
		if row != nil {
			quote, e = businessQuoteResponse(c.DB, row, Str(p["project_code"]))
			if e != nil {
				return nil, e
			}
		}
		rows, e := All(c.DB, "SELECT c.* FROM contracts c JOIN contract_project_allocations a ON a.contract_id=c.id WHERE a.project_id=? ORDER BY c.created_at DESC,c.id DESC", p["id"])
		if e != nil {
			return nil, e
		}
		for _, r := range rows {
			out, e := businessContractResponse(c.DB, r)
			if e != nil {
				return nil, e
			}
			contracts = append(contracts, out)
		}
	}
	receivables, e := businessPaymentOverview(c.DB, p, today, details)
	if e != nil {
		return nil, e
	}
	costs, e := businessProjectCosts(c.DB, p["id"])
	if e != nil {
		return nil, e
	}
	contracted := businessInt(receivables["contracted_amount_cents"])
	actualCost := businessInt(costs["total_cents"])
	profit := contracted - actualCost
	date, e := businessFinalDelivery(c.DB, p["id"])
	if e != nil {
		return nil, e
	}
	return Row{"stages": stages, "commercial": Row{"accepted_quote": quote, "contracts": contracts}, "costs": costs, "profit": Row{"contracted_amount_cents": contracted, "actual_cost_cents": actualCost, "actual_profit_cents": profit, "margin_basis_points": businessBasisPoints(profit, contracted)}, "receivables": receivables, "todos": businessProjectTodos(stages, receivables, Str(p["project_code"]), date, today)}, nil
}
func businessProjectCosts(db DBTX, id any) (Row, error) {
	r, e := One(db, `SELECT (SELECT COALESCE(SUM(total_cost_cents),0) FROM inventory_issues WHERE project_id=? AND status='active') AS material_consumed,(SELECT COALESCE(SUM(cost_cents),0) FROM labor_entries WHERE project_id=? AND status='active') AS labor,(SELECT COALESCE(SUM(total_amount_cents),0) FROM material_advances WHERE project_id=? AND status='active') AS field_material,(SELECT COALESCE(SUM(l.value_cents),0) FROM goods_receipt_lines l JOIN goods_receipts r ON r.id=l.goods_receipt_id JOIN purchase_orders o ON o.id=r.purchase_order_id WHERE o.project_id=? AND r.status='active') AS received,(SELECT COALESCE(SUM(p.amount_cents),0) FROM supplier_payments p JOIN purchase_orders o ON o.id=p.purchase_order_id WHERE o.project_id=? AND p.status='active') AS paid`, id, id, id, id, id)
	if e != nil {
		return nil, e
	}
	lines, e := All(db, "SELECT l.unit_cost_cents,l.quantity_milli,l.tax_amount_cents FROM purchase_order_lines l JOIN purchase_orders o ON o.id=l.purchase_order_id WHERE o.project_id=? AND o.status IN ('confirmed','partially_received','received')", id)
	if e != nil {
		return nil, e
	}
	committed := int64(0)
	for _, line := range lines {
		amount, err := businessLineGross(businessInt(line["unit_cost_cents"]), businessInt(line["quantity_milli"]), businessInt(line["tax_amount_cents"]))
		if err != nil {
			return nil, err
		}
		committed += amount
	}
	return Row{"material_consumed_cents": r["material_consumed"], "labor_cents": r["labor"], "field_material_cents": r["field_material"], "total_cents": businessInt(r["material_consumed"]) + businessInt(r["labor"]) + businessInt(r["field_material"]), "procurement_committed_cents": committed, "procurement_received_cents": r["received"], "procurement_paid_cents": r["paid"], "completeness": "complete"}, nil
}
func businessFinalDelivery(db DBTX, id any) (any, error) {
	r, e := One(db, "SELECT MIN(c.final_delivery_on) AS date FROM contracts c JOIN contract_project_allocations a ON a.contract_id=c.id WHERE a.project_id=? AND c.status IN ('signed','completed') AND c.final_delivery_on IS NOT NULL", id)
	if e != nil {
		return nil, e
	}
	return r["date"], nil
}
func businessUpcoming(v any, today string) bool {
	if v == nil {
		return false
	}
	start, e := time.Parse("2006-01-02", today)
	if e != nil {
		return false
	}
	date, e := time.Parse("2006-01-02", Str(v))
	return e == nil && !date.Before(start) && !date.After(start.AddDate(0, 0, 30))
}
func businessProjectTodos(stages []Row, receivables Row, code string, date any, today string) []Row {
	out := []Row{}
	blocked := []string{}
	blockedDates := []string{}
	for _, s := range stages {
		if s["status"] == "blocked" {
			blocked = append(blocked, Str(s["stage_code"]))
			if s["planned_end_on"] != nil {
				blockedDates = append(blockedDates, Str(s["planned_end_on"]))
			}
		}
	}
	if len(blocked) > 0 {
		var due any
		if len(blockedDates) > 0 {
			sort.Strings(blockedDates)
			due = blockedDates[0]
		}
		out = append(out, Row{"code": "STAGE_BLOCKED", "severity": "danger", "project_code": code, "due_on": due, "title": "Project stage is blocked", "description": strings.Join(blocked, ", ")})
	}
	overdue := []string{}
	dates := []string{}
	for _, t := range receivables["terms"].([]Row) {
		if t["is_overdue"] == true {
			overdue = append(overdue, Str(t["milestone"]))
			dates = append(dates, Str(t["due_on"]))
		}
	}
	if len(overdue) > 0 {
		sort.Strings(dates)
		out = append(out, Row{"code": "RECEIVABLE_OVERDUE", "severity": "danger", "project_code": code, "due_on": dates[0], "title": "Receivable is overdue", "description": strings.Join(overdue, ", ")})
	}
	if businessUpcoming(date, today) {
		out = append(out, Row{"code": "DELIVERY_UPCOMING", "severity": "warning", "project_code": code, "due_on": date, "title": "Final delivery is upcoming", "description": nil})
	}
	return businessSortedTodos(out)
}
func businessSortedTodos(rows []Row) []Row {
	severity := map[string]int{"danger": 0, "warning": 1, "info": 2}
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if severity[Str(a["severity"])] != severity[Str(b["severity"])] {
			return severity[Str(a["severity"])] < severity[Str(b["severity"])]
		}
		for _, f := range []string{"due_on", "project_code", "code"} {
			x, y := Str(a[f]), Str(b[f])
			if f == "due_on" {
				if x == "" {
					x = "9999-12-31"
				}
				if y == "" {
					y = "9999-12-31"
				}
			}
			if x != y {
				return x < y
			}
		}
		return false
	})
	return rows
}
func businessCurrentStage(rows []Row) any {
	for _, status := range []string{"in_progress", "blocked"} {
		for _, r := range rows {
			if r["status"] == status {
				return r
			}
		}
	}
	return nil
}
func businessBackupHealth(c *Context) (Row, error) {
	settings := c.S.Config
	if c.S.SettingsSnapshot != nil {
		settings = c.S.SettingsSnapshot()
	}
	latest, e := One(c.DB, "SELECT status FROM backup_runs ORDER BY id DESC LIMIT 1")
	if e != nil {
		return nil, e
	}
	success, e := One(c.DB, "SELECT finished_at FROM backup_runs WHERE status='success' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1")
	if e != nil {
		return nil, e
	}
	var last any
	if success != nil {
		last = success["finished_at"]
	}
	out := Row{"healthy": false, "last_success_at": last, "message": nil}
	if settings.BackupDir == "" {
		out["message"] = "Backup is not configured"
	} else if latest != nil && latest["status"] == "failed" {
		out["message"] = "Last backup failed"
	} else if success == nil {
		out["message"] = "No successful backup"
	} else {
		finished, e := time.Parse(time.RFC3339Nano, Str(last))
		now := c.S.Now()
		if e != nil || finished.After(now) {
			out["message"] = "Backup history is invalid"
		} else if !now.Before(finished.Add(time.Duration(settings.BackupIntervalHours) * time.Hour)) {
			out["message"] = "Last successful backup is overdue"
		} else {
			out["healthy"] = true
		}
	}
	return out, nil
}
