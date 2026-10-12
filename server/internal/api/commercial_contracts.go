package api

import (
	"fmt"
	"strings"
)

func registerBusinessContracts(s *Server) {
	businessHandle(s, "GET /api/projects/{project_code}/contracts", func(c *Context) (any, error) {
		key, e := businessProjectKey(c)
		if e != nil {
			return nil, e
		}
		project, e := businessProject(c.DB, key, false)
		if e != nil {
			return nil, e
		}
		page, size, e := businessPagination(c)
		if e != nil {
			return nil, e
		}
		total, e := One(c.DB, "SELECT COUNT(*) AS total FROM contracts c JOIN contract_project_allocations a ON a.contract_id=c.id WHERE a.project_id=?", project["id"])
		if e != nil {
			return nil, e
		}
		rows, e := All(c.DB, "SELECT c.* FROM contracts c JOIN contract_project_allocations a ON a.contract_id=c.id WHERE a.project_id=? ORDER BY c.created_at DESC,c.id DESC LIMIT ? OFFSET ?", project["id"], size, (page-1)*size)
		if e != nil {
			return nil, e
		}
		items := []Row{}
		for _, r := range rows {
			out, e := businessContractResponse(c.DB, r)
			if e != nil {
				return nil, e
			}
			items = append(items, out)
		}
		return Row{"items": items, "total": total["total"], "page": page, "page_size": size}, nil
	})
	businessHandle(s, "POST /api/projects/{project_code}/contracts", func(c *Context) (any, error) {
		key, e := businessProjectKey(c)
		if e != nil {
			return nil, e
		}
		idem, e := businessIdempotencyKey(c.R, strings.HasPrefix(c.R.Header.Get("Content-Type"), "multipart/"))
		if e != nil {
			return nil, e
		}
		p, batch, e := ReadAttachmentBody(c, "INVALID_CONTRACT_ATTACHMENT")
		if e != nil {
			return nil, e
		}
		defer batch.Close()
		if !businessExact(p, businessContractFields...) {
			return nil, businessInvalid("Invalid contract payload")
		}
		p, e = businessNormalizeContract(p)
		if e != nil {
			return nil, e
		}
		hash, e := businessCompactHash(batch.HashPayload(p))
		if e != nil {
			return nil, e
		}
		c.Status = 201
		out, e := c.Tx(func(t *Context) (any, error) {
			project, e := businessProject(t.DB, key, false)
			if e != nil {
				return nil, e
			}
			t = businessScopedRequest(t, "/api/projects/"+Str(project["project_code"])+"/contracts")
			if idem != "" {
				r, e := RestoreIdempotent(t.DB, t.R, idem, hash)
				if r != nil || e != nil {
					return r, e
				}
			}
			if project["status"] != "active" {
				return nil, E(409, "Project is archived", "PROJECT_ARCHIVED")
			}
			if e = businessContractCompany(t.DB, p["customer_company_id"]); e != nil {
				return nil, e
			}
			allocations, e := businessResolveAllocations(t.DB, p["allocations"].([]Row), Str(project["project_code"]))
			if e != nil {
				return nil, e
			}
			ids := p["document_version_ids"].([]int64)
			if e = businessValidateDocuments(t.DB, Str(project["project_code"]), ids, "Invalid contract payload"); e != nil {
				return nil, e
			}
			at := t.Timestamp()
			id, e := Insert(t.DB, "INSERT INTO contracts(contract_no,title,customer_company_id,status,signed_on,total_amount_cents,final_delivery_on,notes,revision,created_at,updated_at) VALUES(?,?,?,'draft',?,?,?,?,1,?,?)", p["contract_no"], p["title"], p["customer_company_id"], p["signed_on"], p["total_amount_cents"], p["final_delivery_on"], p["notes"], at, at)
			if e != nil {
				return nil, e
			}
			if e = businessReplaceAllocations(t.DB, id, allocations); e != nil {
				return nil, e
			}
			docs := []ManagedDocument{}
			for i, a := range batch.Attachments {
				docs = append(docs, ManagedDocument{Title: fmt.Sprintf("合同 %s 附件 %02d（合同记录 %d）", Str(p["contract_no"]), i+1, id), ManagedFilename: ManagedFilename([]any{project["project_code"], "合同", p["contract_no"], fmt.Sprintf("%02d", i+1)}, a.OriginalFilename, 2)})
			}
			uploaded, e := batch.Publish(t, Str(project["project_code"]), "contract", docs, p["notes"], at)
			if e != nil {
				return nil, e
			}
			if e = businessReplaceLinks(t.DB, "contract_document_versions", "contract_id", id, append(ids, uploaded...)); e != nil {
				return nil, e
			}
			r, e := One(t.DB, "SELECT * FROM contracts WHERE id=?", id)
			if e != nil {
				return nil, e
			}
			response, e := businessContractResponse(t.DB, r)
			if e == nil && idem != "" {
				e = SaveIdempotent(t.DB, t.R, idem, hash, response, 201, "contract", id, at)
			}
			return response, e
		})
		return out, businessContractUnique(e)
	})
	businessHandle(s, "GET /api/projects/{project_code}/contracts/{contract_id}", func(c *Context) (any, error) {
		_, r, e := businessContractContext(c, false)
		if e != nil {
			return nil, e
		}
		return businessContractResponse(c.DB, r)
	})
	businessHandle(s, "PUT /api/projects/{project_code}/contracts/{contract_id}", func(c *Context) (any, error) {
		p, e := c.Body()
		if e != nil {
			return nil, e
		}
		if !businessExact(p, append(append([]string{}, businessContractFields...), "expected_revision")...) {
			return nil, businessInvalid("Invalid contract payload")
		}
		rev, e := businessPositive(p["expected_revision"], "Invalid contract payload")
		if e != nil {
			return nil, e
		}
		p, e = businessNormalizeContract(p)
		if e != nil {
			return nil, e
		}
		response, e := c.Tx(func(t *Context) (any, error) {
			project, r, e := businessContractContext(t, true)
			if e != nil {
				return nil, e
			}
			if e = businessRevision(r, rev); e != nil {
				return nil, e
			}
			if e = businessContractCompany(t.DB, p["customer_company_id"]); e != nil {
				return nil, e
			}
			allocations, e := businessResolveAllocations(t.DB, p["allocations"].([]Row), Str(project["project_code"]))
			if e != nil {
				return nil, e
			}
			ids := p["document_version_ids"].([]int64)
			if e = businessValidateDocuments(t.DB, Str(project["project_code"]), ids, "Invalid contract payload"); e != nil {
				return nil, e
			}
			locked := businessIn(Str(r["status"]), "signed", "completed", "terminated")
			if locked {
				if e = businessContractLocked(t.DB, r, p, allocations); e != nil {
					return nil, e
				}
			}
			if businessIn(Str(r["status"]), "signed", "completed") {
				if e = businessSigning(p, allocations); e != nil {
					return nil, e
				}
			}
			at := t.Timestamp()
			if locked {
				_, e = t.DB.Exec("UPDATE contracts SET notes=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?", p["notes"], at, r["id"], rev)
			} else {
				_, e = t.DB.Exec("UPDATE contracts SET contract_no=?,title=?,customer_company_id=?,signed_on=?,total_amount_cents=?,final_delivery_on=?,notes=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?", p["contract_no"], p["title"], p["customer_company_id"], p["signed_on"], p["total_amount_cents"], p["final_delivery_on"], p["notes"], at, r["id"], rev)
			}
			if e != nil {
				return nil, e
			}
			if !locked {
				if e = businessReplaceAllocations(t.DB, r["id"], allocations); e != nil {
					return nil, e
				}
				if e = businessReplaceLinks(t.DB, "contract_document_versions", "contract_id", r["id"], ids); e != nil {
					return nil, e
				}
			}
			r, e = One(t.DB, "SELECT * FROM contracts WHERE id=?", r["id"])
			if e != nil {
				return nil, e
			}
			return businessContractResponse(t.DB, r)
		})
		return response, businessContractUnique(e)
	})
	businessHandle(s, "POST /api/projects/{project_code}/contracts/{contract_id}/transition", func(c *Context) (any, error) {
		p, e := businessTransitionPayload(c, []string{"draft", "signed", "completed", "terminated"}, "Invalid contract transition")
		if e != nil {
			return nil, e
		}
		return c.Tx(func(t *Context) (any, error) {
			_, r, e := businessContractContext(t, true)
			if e != nil {
				return nil, e
			}
			if e = businessRevision(r, p["expected_revision"]); e != nil {
				return nil, e
			}
			allowed := map[string][]string{"draft": {"signed", "terminated"}, "signed": {"completed", "terminated"}}
			if !businessIn(Str(p["to_status"]), allowed[Str(r["status"])]...) {
				return nil, E(409, "Invalid contract transition", "INVALID_CONTRACT_TRANSITION")
			}
			if p["to_status"] == "signed" {
				allocations, e := businessAllocations(t.DB, r["id"])
				if e != nil {
					return nil, e
				}
				if e = businessSigning(r, allocations); e != nil {
					return nil, e
				}
			}
			_, e = t.DB.Exec("UPDATE contracts SET status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?", p["to_status"], t.Timestamp(), r["id"], p["expected_revision"])
			if e != nil {
				return nil, e
			}
			r, e = One(t.DB, "SELECT * FROM contracts WHERE id=?", r["id"])
			if e != nil {
				return nil, e
			}
			return businessContractResponse(t.DB, r)
		})
	})
}
