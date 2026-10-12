package api

import (
	"fmt"
	"math/big"
)

func businessBasisPoints(n, d int64) any {
	if d == 0 {
		return nil
	}
	v := new(big.Int).Mul(big.NewInt(n), big.NewInt(10000))
	v.Add(v, big.NewInt(d/2))
	q, rem := new(big.Int), new(big.Int)
	q.QuoRem(v, big.NewInt(d), rem)
	if v.Sign() < 0 && rem.Sign() != 0 {
		q.Sub(q, big.NewInt(1))
	}
	return q.Int64()
}
func businessReceiptResponse(r Row, code string) Row {
	out := Fields(r, "id", "contract_allocation_id", "milestone", "received_on", "amount_cents", "payment_method", "reference_no", "notes", "status", "voided_on", "void_reason", "revision", "created_at", "updated_at")
	out["project_code"] = code
	return out
}
func businessTermResponse(r Row, received int64, today, milestone string) Row {
	if r == nil {
		r = Row{"id": nil, "milestone": milestone, "due_on": nil, "planned_amount_cents": int64(0), "notes": nil, "revision": nil}
	}
	amount := businessInt(r["planned_amount_cents"])
	status := "paid"
	switch {
	case amount == 0:
		status = "unplanned"
	case received == 0:
		status = "scheduled"
	case received < amount:
		status = "partial"
	}
	out := Fields(r, "id", "milestone", "due_on", "planned_amount_cents", "notes", "revision")
	out["received_amount_cents"] = received
	out["outstanding_amount_cents"] = businessMax(amount - received)
	out["term_fulfillment_basis_points"] = businessBasisPoints(received, amount)
	out["status"] = status
	out["is_overdue"] = r["due_on"] != nil && amount > 0 && received < amount && Str(r["due_on"]) < today
	return out
}
func businessPaymentOverview(db DBTX, p Row, today string, details bool) (Row, error) {
	contracts, e := All(db, "SELECT a.amount_cents FROM contract_project_allocations a JOIN contracts c ON c.id=a.contract_id WHERE a.project_id=? AND c.status IN ('signed','completed')", p["id"])
	if e != nil {
		return nil, e
	}
	contracted := int64(0)
	for _, r := range contracts {
		contracted += businessInt(r["amount_cents"])
	}
	terms, e := All(db, "SELECT * FROM payment_terms WHERE project_id=?", p["id"])
	if e != nil {
		return nil, e
	}
	byMilestone := map[string]Row{}
	for _, r := range terms {
		byMilestone[Str(r["milestone"])] = r
	}
	receipts, e := All(db, "SELECT * FROM receipts WHERE project_id=? ORDER BY created_at DESC,id DESC", p["id"])
	if e != nil {
		return nil, e
	}
	received := map[string]int64{}
	allocated := int64(0)
	outReceipts := []Row{}
	for _, r := range receipts {
		if details {
			outReceipts = append(outReceipts, businessReceiptResponse(r, Str(p["project_code"])))
		}
		if r["status"] == "active" {
			received[Str(r["milestone"])] += businessInt(r["amount_cents"])
			if r["contract_allocation_id"] != nil {
				allocated += businessInt(r["amount_cents"])
			}
		}
	}
	outTerms := []Row{}
	planned, totalReceived := int64(0), int64(0)
	for _, m := range businessMilestones {
		t := businessTermResponse(byMilestone[m], received[m], today, m)
		outTerms = append(outTerms, t)
		planned += businessInt(t["planned_amount_cents"])
		totalReceived += received[m]
	}
	return Row{"contracted_amount_cents": contracted, "receivable_amount_cents": planned, "received_amount_cents": totalReceived, "allocated_received_amount_cents": allocated, "unallocated_received_amount_cents": totalReceived - allocated, "outstanding_receivable_cents": businessMax(planned - totalReceived), "contract_collection_basis_points": businessBasisPoints(allocated, contracted), "terms": outTerms, "receipts": outReceipts}, nil
}
func businessResolveReceipt(db DBTX, requested, project any) (int64, error) {
	q := "SELECT a.id FROM contract_project_allocations a JOIN contracts c ON c.id=a.contract_id WHERE a.project_id=? AND c.status IN ('signed','completed')"
	args := []any{project}
	if requested != nil {
		q += " AND a.id=?"
		args = append(args, requested)
	}
	rows, e := All(db, q+" ORDER BY a.id", args...)
	if e != nil {
		return 0, e
	}
	if requested != nil && len(rows) != 1 {
		return 0, businessInvalid("Invalid receipt payload")
	}
	if len(rows) == 1 {
		return businessInt(rows[0]["id"]), nil
	}
	if len(rows) == 0 {
		a := E(409, "Receipt requires an effective contract", "RECEIPT_CONTRACT_REQUIRED")
		a.FieldErrors = Row{"contract_allocation_id": []string{"项目暂无已生效合同，不能登记到账"}}
		return 0, a
	}
	a := E(409, "Receipt contract allocation is ambiguous", "RECEIPT_CONTRACT_AMBIGUOUS")
	a.FieldErrors = Row{"contract_allocation_id": []string{"项目存在多份已生效合同，必须明确选择本次到账归属"}}
	return 0, a
}
func businessReceiptCapacity(db DBTX, id, n int64) error {
	r, e := One(db, "SELECT a.amount_cents,COALESCE(SUM(r.amount_cents),0) AS received_amount_cents FROM contract_project_allocations a LEFT JOIN receipts r ON r.contract_allocation_id=a.id AND r.status='active' WHERE a.id=? GROUP BY a.id,a.amount_cents", id)
	if e != nil {
		return e
	}
	if r == nil {
		return fmt.Errorf("receipt allocation is missing")
	}
	remaining := businessMax(businessInt(r["amount_cents"]) - businessInt(r["received_amount_cents"]))
	if n > remaining {
		a := E(409, "本次到账超过所选合同分摊的剩余应收", "RECEIPT_ALLOCATION_EXCEEDED")
		a.FieldErrors = Row{"amount_cents": []string{fmt.Sprintf("本次到账超过该合同在本项目的剩余应收 %d.%02d 元", remaining/100, remaining%100)}}
		return a
	}
	return nil
}
func registerBusinessReceipts(s *Server) {
	businessHandle(s, "GET /api/projects/{project_code}/payments", func(c *Context) (any, error) {
		key, e := businessProjectKey(c)
		if e != nil {
			return nil, e
		}
		p, e := businessProject(c.DB, key, false)
		if e != nil {
			return nil, e
		}
		return businessPaymentOverview(c.DB, p, businessToday(c), true)
	})
	businessHandle(s, "PUT /api/projects/{project_code}/payment-terms/{milestone}", func(c *Context) (any, error) {
		milestone := c.R.PathValue("milestone")
		if !businessIn(milestone, businessMilestones...) {
			return nil, businessInvalid("Invalid payment milestone")
		}
		key, e := businessProjectKey(c)
		if e != nil {
			return nil, e
		}
		p, e := c.Body()
		if e != nil {
			return nil, e
		}
		detail := "Invalid payment term payload"
		if !businessExact(p, "due_on", "planned_amount_cents", "notes", "expected_revision") {
			return nil, businessInvalid(detail)
		}
		p["due_on"], e = businessDate(p["due_on"], true, detail)
		if e != nil {
			return nil, e
		}
		p["planned_amount_cents"], e = businessMoney(p["planned_amount_cents"], false, detail)
		if e != nil {
			return nil, e
		}
		p["notes"], e = businessText(p["notes"], false, detail)
		if e != nil {
			return nil, businessInvalid(detail)
		}
		if p["expected_revision"] != nil {
			p["expected_revision"], e = businessPositive(p["expected_revision"], detail)
			if e != nil {
				return nil, e
			}
		}
		return c.Tx(func(t *Context) (any, error) {
			project, e := businessProject(t.DB, key, true)
			if e != nil {
				return nil, e
			}
			r, e := One(t.DB, "SELECT * FROM payment_terms WHERE project_id=? AND milestone=?", project["id"], milestone)
			if e != nil {
				return nil, e
			}
			at := t.Timestamp()
			var id int64
			if r == nil {
				if p["expected_revision"] != nil {
					return nil, E(409, "Resource was modified", "REVISION_CONFLICT")
				}
				id, e = Insert(t.DB, "INSERT INTO payment_terms(project_id,milestone,due_on,planned_amount_cents,notes,revision,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)", project["id"], milestone, p["due_on"], p["planned_amount_cents"], p["notes"], at, at)
			} else {
				if e = businessRevision(r, p["expected_revision"]); e != nil {
					return nil, e
				}
				id = businessInt(r["id"])
				_, e = t.DB.Exec("UPDATE payment_terms SET due_on=?,planned_amount_cents=?,notes=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?", p["due_on"], p["planned_amount_cents"], p["notes"], at, id, p["expected_revision"])
			}
			if e != nil {
				return nil, e
			}
			r, e = One(t.DB, "SELECT * FROM payment_terms WHERE id=?", id)
			if e != nil {
				return nil, e
			}
			received, e := One(t.DB, "SELECT COALESCE(SUM(amount_cents),0) AS amount FROM receipts WHERE project_id=? AND milestone=? AND status='active'", project["id"], milestone)
			if e != nil {
				return nil, e
			}
			return businessTermResponse(r, businessInt(received["amount"]), businessToday(t), milestone), nil
		})
	})
	businessHandle(s, "POST /api/projects/{project_code}/receipts", func(c *Context) (any, error) {
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
		detail := "Invalid receipt payload"
		if !businessExact(p, "contract_allocation_id", "milestone", "received_on", "amount_cents", "payment_method", "reference_no", "notes") || !businessIn(Str(p["milestone"]), businessMilestones...) || !businessIn(Str(p["payment_method"]), "bank_transfer", "cash", "other") {
			return nil, businessInvalid(detail)
		}
		if p["contract_allocation_id"] != nil {
			p["contract_allocation_id"], e = businessPositive(p["contract_allocation_id"], detail)
			if e != nil {
				return nil, e
			}
		}
		p["received_on"], e = businessDate(p["received_on"], false, detail)
		if e != nil {
			return nil, e
		}
		p["amount_cents"], e = businessMoney(p["amount_cents"], true, detail)
		if e != nil {
			return nil, e
		}
		for _, f := range []string{"reference_no", "notes"} {
			p[f], e = businessText(p[f], false, detail)
			if e != nil {
				return nil, businessInvalid(detail)
			}
		}
		hash, e := businessCompactHash(p)
		if e != nil {
			return nil, e
		}
		c.Status = 201
		return c.Tx(func(t *Context) (any, error) {
			previous, e := RestoreIdempotent(t.DB, t.R, idem, hash)
			if previous != nil || e != nil {
				return previous, e
			}
			project, e := businessProject(t.DB, key, true)
			if e != nil {
				return nil, e
			}
			allocation, e := businessResolveReceipt(t.DB, p["contract_allocation_id"], project["id"])
			if e != nil {
				return nil, e
			}
			if e = businessReceiptCapacity(t.DB, allocation, businessInt(p["amount_cents"])); e != nil {
				return nil, e
			}
			at := t.Timestamp()
			id, e := Insert(t.DB, "INSERT INTO receipts(project_id,contract_allocation_id,milestone,received_on,amount_cents,payment_method,reference_no,notes,status,voided_on,void_reason,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'active',NULL,NULL,1,?,?)", project["id"], allocation, p["milestone"], p["received_on"], p["amount_cents"], p["payment_method"], p["reference_no"], p["notes"], at, at)
			if e != nil {
				return nil, e
			}
			r, e := One(t.DB, "SELECT * FROM receipts WHERE id=?", id)
			if e != nil {
				return nil, e
			}
			out := businessReceiptResponse(r, Str(project["project_code"]))
			e = SaveIdempotent(t.DB, t.R, idem, hash, out, 201, "receipt", id, at)
			return out, e
		})
	})
	for _, action := range []string{"update", "void"} {
		action := action
		route := "PUT /api/projects/{project_code}/receipts/{receipt_id}"
		if action == "void" {
			route = "POST /api/projects/{project_code}/receipts/{receipt_id}/void"
		}
		businessHandle(s, route, func(c *Context) (any, error) {
			key, e := businessProjectKey(c)
			if e != nil {
				return nil, e
			}
			id, e := PositiveID(c.R.PathValue("receipt_id"))
			if e != nil {
				return nil, e
			}
			p, e := c.Body()
			if e != nil {
				return nil, e
			}
			detail := "Invalid receipt payload"
			fields := []string{"reference_no", "notes", "expected_revision"}
			if action == "void" {
				detail = "Invalid receipt void payload"
				fields = []string{"voided_on", "reason", "expected_revision"}
			}
			if !businessExact(p, fields...) {
				return nil, businessInvalid(detail)
			}
			p["expected_revision"], e = businessPositive(p["expected_revision"], detail)
			if e != nil {
				return nil, e
			}
			if action == "void" {
				p["voided_on"], e = businessDate(p["voided_on"], false, detail)
				if e != nil {
					return nil, e
				}
				p["reason"], e = businessText(p["reason"], true, detail)
				if e != nil {
					return nil, businessInvalid(detail)
				}
			} else {
				for _, f := range []string{"reference_no", "notes"} {
					p[f], e = businessText(p[f], false, detail)
					if e != nil {
						return nil, businessInvalid(detail)
					}
				}
			}
			return c.Tx(func(t *Context) (any, error) {
				project, e := businessProject(t.DB, key, true)
				if e != nil {
					return nil, e
				}
				r, e := One(t.DB, "SELECT * FROM receipts WHERE id=? AND project_id=?", id, project["id"])
				if e != nil {
					return nil, e
				}
				if r == nil {
					return nil, businessMissing("Receipt")
				}
				if e = businessRevision(r, p["expected_revision"]); e != nil {
					return nil, e
				}
				if r["status"] != "active" {
					return nil, E(409, "Receipt is not active", "RECEIPT_NOT_ACTIVE")
				}
				if action == "void" {
					if Str(p["voided_on"]) < Str(r["received_on"]) {
						return nil, businessInvalid(detail)
					}
					_, e = t.DB.Exec("UPDATE receipts SET status='voided',voided_on=?,void_reason=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='active'", p["voided_on"], p["reason"], t.Timestamp(), id, p["expected_revision"])
				} else {
					_, e = t.DB.Exec("UPDATE receipts SET reference_no=?,notes=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='active'", p["reference_no"], p["notes"], t.Timestamp(), id, p["expected_revision"])
				}
				if e != nil {
					return nil, e
				}
				r, e = One(t.DB, "SELECT * FROM receipts WHERE id=?", id)
				if e != nil {
					return nil, e
				}
				return businessReceiptResponse(r, Str(project["project_code"])), nil
			})
		})
	}
}
