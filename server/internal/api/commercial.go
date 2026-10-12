package api

import (
	"fmt"
	"golang.org/x/text/unicode/norm"
	"math"
	"math/big"
	"reflect"
	"strings"
)

var businessQuoteFields = []string{"quote_date", "amount_cents", "valid_until", "notes", "document_version_ids"}
var businessContractFields = []string{"contract_no", "title", "customer_company_id", "signed_on", "total_amount_cents", "final_delivery_on", "allocations", "notes", "document_version_ids"}
var businessMilestones = []string{"advance", "progress", "final"}

func businessInvalid(detail string) error { return E(422, detail, "VALIDATION_ERROR") }
func businessMoney(v any, positive bool, detail string) (int64, error) {
	n, ok := Int(v)
	if !ok || n < 0 || n > 9000000000000 || (positive && n == 0) {
		return 0, businessInvalid(detail)
	}
	return n, nil
}
func businessDocumentIDs(v any, detail string) ([]int64, error) {
	list, ok := v.([]any)
	if !ok {
		return nil, businessInvalid(detail)
	}
	out := []int64{}
	seen := map[int64]bool{}
	for _, v := range list {
		n, e := businessPositive(v, detail)
		if e != nil || seen[n] {
			return nil, businessInvalid(detail)
		}
		seen[n] = true
		out = append(out, n)
	}
	return out, nil
}
func businessNormalizeQuote(p Row) (Row, error) {
	r := Row{}
	detail := "Invalid quote payload"
	var e error
	r["quote_date"], e = businessDate(p["quote_date"], false, detail)
	if e != nil {
		return nil, e
	}
	r["valid_until"], e = businessDate(p["valid_until"], true, detail)
	if e != nil {
		return nil, e
	}
	if r["valid_until"] != nil && Str(r["valid_until"]) < Str(r["quote_date"]) {
		return nil, businessInvalid(detail)
	}
	r["amount_cents"], e = businessMoney(p["amount_cents"], false, detail)
	if e != nil {
		return nil, e
	}
	r["notes"], e = businessText(p["notes"], false, detail)
	if e != nil {
		return nil, businessInvalid(detail)
	}
	r["document_version_ids"], e = businessDocumentIDs(p["document_version_ids"], detail)
	return r, e
}
func businessNormalizeContract(p Row) (Row, error) {
	r := Row{}
	detail := "Invalid contract payload"
	var e error
	for _, f := range []string{"contract_no", "title", "notes"} {
		r[f], e = businessText(p[f], f != "notes", detail)
		if e != nil {
			return nil, businessInvalid(detail)
		}
	}
	r["customer_company_id"], e = businessPositive(p["customer_company_id"], detail)
	if e != nil {
		return nil, e
	}
	for _, f := range []string{"signed_on", "final_delivery_on"} {
		r[f], e = businessDate(p[f], true, detail)
		if e != nil {
			return nil, e
		}
	}
	r["total_amount_cents"], e = businessMoney(p["total_amount_cents"], false, detail)
	if e != nil {
		return nil, e
	}
	r["document_version_ids"], e = businessDocumentIDs(p["document_version_ids"], detail)
	if e != nil {
		return nil, e
	}
	list, ok := p["allocations"].([]any)
	if !ok || len(list) == 0 {
		return nil, businessInvalid(detail)
	}
	seen := map[string]bool{}
	allocations := []Row{}
	for _, v := range list {
		a, ok := v.(map[string]any)
		if !ok || !businessExact(a, "project_code", "amount_cents") {
			return nil, businessInvalid(detail)
		}
		code := norm.NFC.String(strings.TrimSpace(Str(a["project_code"])))
		key, e := ProjectIdentity(code)
		if e != nil || seen[key] {
			return nil, businessInvalid(detail)
		}
		seen[key] = true
		n, e := businessMoney(a["amount_cents"], true, detail)
		if e != nil {
			return nil, e
		}
		allocations = append(allocations, Row{"project_code": code, "project_key": key, "amount_cents": n})
	}
	r["allocations"] = allocations
	return r, nil
}
func businessDocumentLinks(db DBTX, table, column string, id any) ([]int64, error) {
	rows, e := All(db, "SELECT document_version_id FROM "+table+" WHERE "+column+"=? ORDER BY document_version_id", id)
	if e != nil {
		return nil, e
	}
	ids := []int64{}
	for _, r := range rows {
		ids = append(ids, businessInt(r["document_version_id"]))
	}
	return ids, nil
}
func businessValidateDocuments(db DBTX, code string, ids []int64, detail string) error {
	for _, id := range ids {
		r, e := One(db, `SELECT v.id FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE v.id=? AND d.project_code=? COLLATE NOCASE AND d.archived_at IS NULL`, id, code)
		if e != nil {
			return e
		}
		if r == nil {
			return businessInvalid(detail)
		}
	}
	return nil
}
func businessReplaceLinks(db DBTX, table, column string, id any, ids []int64) error {
	if _, e := db.Exec("DELETE FROM "+table+" WHERE "+column+"=?", id); e != nil {
		return e
	}
	for _, document := range ids {
		if _, e := db.Exec("INSERT INTO "+table+"("+column+",document_version_id) VALUES(?,?)", id, document); e != nil {
			return e
		}
	}
	return nil
}
func businessQuoteResponse(db DBTX, r Row, code string) (Row, error) {
	out := Fields(r, "id", "version_number", "status", "quote_date", "amount_cents", "valid_until", "notes", "revision", "created_at", "updated_at")
	out["project_code"] = code
	ids, e := businessDocumentLinks(db, "quote_document_versions", "quote_id", r["id"])
	out["document_version_ids"] = ids
	return out, e
}
func businessContractRow(db DBTX, id, project any) (Row, error) {
	return One(db, "SELECT c.* FROM contracts c JOIN contract_project_allocations a ON a.contract_id=c.id WHERE c.id=? AND a.project_id=?", id, project)
}
func businessContractResponse(db DBTX, r Row) (Row, error) {
	out := Fields(r, "id", "contract_no", "title", "customer_company_id", "status", "signed_on", "total_amount_cents", "final_delivery_on", "notes", "revision", "created_at", "updated_at")
	customer, e := One(db, "SELECT name FROM companies WHERE id=?", r["customer_company_id"])
	if e != nil {
		return nil, e
	}
	if customer == nil {
		return nil, fmt.Errorf("contract customer is missing")
	}
	out["customer_company_name"] = customer["name"]
	out["allocations"], e = All(db, "SELECT a.id,a.contract_id,p.project_code,a.amount_cents FROM contract_project_allocations a JOIN projects p ON p.id=a.project_id WHERE a.contract_id=? ORDER BY a.id", r["id"])
	if e != nil {
		return nil, e
	}
	out["document_version_ids"], e = businessDocumentLinks(db, "contract_document_versions", "contract_id", r["id"])
	return out, e
}
func businessAllocations(db DBTX, id any) ([]Row, error) {
	return All(db, "SELECT a.project_id,p.project_code,a.amount_cents FROM contract_project_allocations a JOIN projects p ON p.id=a.project_id WHERE a.contract_id=? ORDER BY a.id", id)
}
func businessResolveAllocations(db DBTX, list []Row, current string) ([]Row, error) {
	out := []Row{}
	included := false
	currentKey, _ := ProjectIdentity(current)
	for _, v := range list {
		p, e := One(db, "SELECT id,project_code,status FROM projects WHERE project_code_key=?", v["project_key"])
		if e != nil {
			return nil, e
		}
		if p == nil || p["status"] != "active" {
			return nil, businessInvalid("Invalid contract payload")
		}
		if v["project_key"] == currentKey {
			included = true
		}
		out = append(out, Row{"project_id": p["id"], "project_code": p["project_code"], "amount_cents": v["amount_cents"]})
	}
	if !included {
		return nil, businessInvalid("Invalid contract payload")
	}
	return out, nil
}
func businessReplaceAllocations(db DBTX, id any, rows []Row) error {
	if _, e := db.Exec("DELETE FROM contract_project_allocations WHERE contract_id=?", id); e != nil {
		return e
	}
	for _, r := range rows {
		if _, e := db.Exec("INSERT INTO contract_project_allocations(contract_id,project_id,amount_cents) VALUES(?,?,?)", id, r["project_id"], r["amount_cents"]); e != nil {
			return e
		}
	}
	return nil
}
func businessSigning(r Row, allocations []Row) error {
	total := new(big.Int)
	for _, a := range allocations {
		total.Add(total, big.NewInt(businessInt(a["amount_cents"])))
	}
	if r["signed_on"] == nil || r["final_delivery_on"] == nil || len(allocations) == 0 || total.Cmp(big.NewInt(businessInt(r["total_amount_cents"]))) != 0 {
		return E(409, "Contract signing requirements are not satisfied", "CONTRACT_SIGNING_REQUIREMENTS")
	}
	return nil
}
func businessAllocationMap(rows []Row) map[int64]int64 {
	m := map[int64]int64{}
	for _, r := range rows {
		m[businessInt(r["project_id"])] = businessInt(r["amount_cents"])
	}
	return m
}
func businessPagination(c *Context) (int64, int64, error) {
	values := []int64{1, 50}
	for i, k := range []string{"page", "page_size"} {
		v, exists := c.R.URL.Query()[k]
		if !exists {
			continue
		}
		if len(v) != 1 {
			return 0, 0, businessInvalid("Invalid pagination")
		}
		n, e := PositiveID(v[0])
		if e != nil || (i == 1 && n > 200) {
			return 0, 0, businessInvalid("Invalid pagination")
		}
		values[i] = n
	}
	if values[0]-1 > math.MaxInt64/values[1] {
		return 0, 0, businessInvalid("Invalid pagination")
	}
	return values[0], values[1], nil
}
func businessTransitionPayload(c *Context, statuses []string, detail string) (Row, error) {
	p, e := c.Body()
	if e != nil {
		return nil, e
	}
	if !businessExact(p, "to_status", "occurred_at", "reason", "expected_revision") || !businessIn(Str(p["to_status"]), statuses...) {
		return nil, businessInvalid(detail)
	}
	p["occurred_at"], e = businessTimestamp(p["occurred_at"], detail)
	if e != nil {
		return nil, e
	}
	p["reason"], e = businessText(p["reason"], false, detail)
	if e != nil {
		return nil, businessInvalid(detail)
	}
	p["expected_revision"], e = businessPositive(p["expected_revision"], detail)
	return p, e
}
func businessScopedRequest(c *Context, path string) *Context {
	clone := *c
	r := c.R.Clone(c.R.Context())
	u := *r.URL
	u.Path = path
	r.URL = &u
	clone.R = r
	return &clone
}
func registerCommercial(s *Server) {
	registerBusinessQuotes(s)
	registerBusinessContracts(s)
	registerBusinessReceipts(s)
}
func registerBusinessQuotes(s *Server) {
	businessHandle(s, "GET /api/projects/{project_code}/quotes", func(c *Context) (any, error) {
		key, e := businessProjectKey(c)
		if e != nil {
			return nil, e
		}
		p, e := businessProject(c.DB, key, false)
		if e != nil {
			return nil, e
		}
		page, size, e := businessPagination(c)
		if e != nil {
			return nil, e
		}
		total, e := One(c.DB, "SELECT COUNT(*) AS total FROM quotes WHERE project_id=?", p["id"])
		if e != nil {
			return nil, e
		}
		rows, e := All(c.DB, "SELECT * FROM quotes WHERE project_id=? ORDER BY version_number DESC,id DESC LIMIT ? OFFSET ?", p["id"], size, (page-1)*size)
		if e != nil {
			return nil, e
		}
		items := []Row{}
		for _, r := range rows {
			v, e := businessQuoteResponse(c.DB, r, Str(p["project_code"]))
			if e != nil {
				return nil, e
			}
			items = append(items, v)
		}
		return Row{"items": items, "total": total["total"], "page": page, "page_size": size}, nil
	})
	businessHandle(s, "POST /api/projects/{project_code}/quotes", func(c *Context) (any, error) {
		key, e := businessProjectKey(c)
		if e != nil {
			return nil, e
		}
		idem, e := businessIdempotencyKey(c.R, strings.HasPrefix(c.R.Header.Get("Content-Type"), "multipart/"))
		if e != nil {
			return nil, e
		}
		p, batch, e := ReadAttachmentBody(c, "INVALID_QUOTE_ATTACHMENT")
		if e != nil {
			return nil, e
		}
		defer batch.Close()
		if !businessExact(p, businessQuoteFields...) {
			return nil, businessInvalid("Invalid quote payload")
		}
		p, e = businessNormalizeQuote(p)
		if e != nil {
			return nil, e
		}
		hash, e := businessCompactHash(batch.HashPayload(p))
		if e != nil {
			return nil, e
		}
		c.Status = 201
		return c.Tx(func(t *Context) (any, error) {
			project, e := businessProject(t.DB, key, false)
			if e != nil {
				return nil, e
			}
			t = businessScopedRequest(t, "/api/projects/"+Str(project["project_code"])+"/quotes")
			if idem != "" {
				r, e := RestoreIdempotent(t.DB, t.R, idem, hash)
				if r != nil || e != nil {
					return r, e
				}
			}
			if project["status"] != "active" {
				return nil, E(409, "Project is archived", "PROJECT_ARCHIVED")
			}
			ids := p["document_version_ids"].([]int64)
			if e = businessValidateDocuments(t.DB, Str(project["project_code"]), ids, "Invalid quote payload"); e != nil {
				return nil, e
			}
			v, e := One(t.DB, "SELECT COALESCE(MAX(version_number),0)+1 AS version FROM quotes WHERE project_id=?", project["id"])
			if e != nil {
				return nil, e
			}
			at := t.Timestamp()
			id, e := Insert(t.DB, "INSERT INTO quotes(project_id,version_number,status,quote_date,amount_cents,valid_until,notes,revision,created_at,updated_at) VALUES(?,?,'draft',?,?,?,?,1,?,?)", project["id"], v["version"], p["quote_date"], p["amount_cents"], p["valid_until"], p["notes"], at, at)
			if e != nil {
				return nil, e
			}
			documents := []ManagedDocument{}
			for i, a := range batch.Attachments {
				documents = append(documents, ManagedDocument{Title: fmt.Sprintf("报价 V%d 附件 %02d（报价记录 %d）", businessInt(v["version"]), i+1, id), ManagedFilename: ManagedFilename([]any{project["project_code"], "报价", CompactISODate(Str(p["quote_date"])), fmt.Sprintf("V%d", businessInt(v["version"])), fmt.Sprintf("%02d", i+1)}, a.OriginalFilename, 3)})
			}
			uploaded, e := batch.Publish(t, Str(project["project_code"]), "quotation", documents, p["notes"], at)
			if e != nil {
				return nil, e
			}
			if e = businessReplaceLinks(t.DB, "quote_document_versions", "quote_id", id, append(ids, uploaded...)); e != nil {
				return nil, e
			}
			r, e := One(t.DB, "SELECT * FROM quotes WHERE id=?", id)
			if e != nil {
				return nil, e
			}
			out, e := businessQuoteResponse(t.DB, r, Str(project["project_code"]))
			if e == nil && idem != "" {
				e = SaveIdempotent(t.DB, t.R, idem, hash, out, 201, "quote", id, at)
			}
			return out, e
		})
	})
	businessHandle(s, "GET /api/projects/{project_code}/quotes/{quote_id}", func(c *Context) (any, error) {
		p, r, e := businessQuoteContext(c, false)
		if e != nil {
			return nil, e
		}
		return businessQuoteResponse(c.DB, r, Str(p["project_code"]))
	})
	businessHandle(s, "PUT /api/projects/{project_code}/quotes/{quote_id}", func(c *Context) (any, error) {
		p, e := c.Body()
		if e != nil {
			return nil, e
		}
		if !businessExact(p, append(append([]string{}, businessQuoteFields...), "expected_revision")...) {
			return nil, businessInvalid("Invalid quote payload")
		}
		rev, e := businessPositive(p["expected_revision"], "Invalid quote payload")
		if e != nil {
			return nil, e
		}
		p, e = businessNormalizeQuote(p)
		if e != nil {
			return nil, e
		}
		return c.Tx(func(t *Context) (any, error) {
			project, r, e := businessQuoteContext(t, true)
			if e != nil {
				return nil, e
			}
			if e = businessRevision(r, rev); e != nil {
				return nil, e
			}
			if r["status"] != "draft" {
				return nil, E(409, "Quote is not editable", "QUOTE_NOT_EDITABLE")
			}
			ids := p["document_version_ids"].([]int64)
			if e = businessValidateDocuments(t.DB, Str(project["project_code"]), ids, "Invalid quote payload"); e != nil {
				return nil, e
			}
			_, e = t.DB.Exec("UPDATE quotes SET quote_date=?,amount_cents=?,valid_until=?,notes=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?", p["quote_date"], p["amount_cents"], p["valid_until"], p["notes"], t.Timestamp(), r["id"], rev)
			if e != nil {
				return nil, e
			}
			if e = businessReplaceLinks(t.DB, "quote_document_versions", "quote_id", r["id"], ids); e != nil {
				return nil, e
			}
			updated, e := One(t.DB, "SELECT * FROM quotes WHERE id=?", r["id"])
			if e != nil {
				return nil, e
			}
			return businessQuoteResponse(t.DB, updated, Str(project["project_code"]))
		})
	})
	businessHandle(s, "POST /api/projects/{project_code}/quotes/{quote_id}/transition", func(c *Context) (any, error) {
		p, e := businessTransitionPayload(c, []string{"draft", "sent", "accepted", "rejected", "withdrawn"}, "Invalid quote transition")
		if e != nil {
			return nil, e
		}
		return c.Tx(func(t *Context) (any, error) {
			project, r, e := businessQuoteContext(t, true)
			if e != nil {
				return nil, e
			}
			if e = businessRevision(r, p["expected_revision"]); e != nil {
				return nil, e
			}
			allowed := map[string][]string{"draft": {"sent", "withdrawn"}, "sent": {"accepted", "rejected", "withdrawn"}}
			if !businessIn(Str(p["to_status"]), allowed[Str(r["status"])]...) {
				return nil, E(409, "Invalid quote transition", "INVALID_QUOTE_TRANSITION")
			}
			if p["to_status"] == "accepted" {
				other, e := One(t.DB, "SELECT id FROM quotes WHERE project_id=? AND status='accepted' AND id<>?", project["id"], r["id"])
				if e != nil {
					return nil, e
				}
				if other != nil {
					return nil, E(409, "Project already has an accepted quote", "ACCEPTED_QUOTE_EXISTS")
				}
			}
			_, e = t.DB.Exec("UPDATE quotes SET status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?", p["to_status"], t.Timestamp(), r["id"], p["expected_revision"])
			if e != nil {
				return nil, e
			}
			r, e = One(t.DB, "SELECT * FROM quotes WHERE id=?", r["id"])
			if e != nil {
				return nil, e
			}
			return businessQuoteResponse(t.DB, r, Str(project["project_code"]))
		})
	})
}
func businessQuoteContext(c *Context, active bool) (Row, Row, error) {
	key, e := businessProjectKey(c)
	if e != nil {
		return nil, nil, e
	}
	id, e := PositiveID(c.R.PathValue("quote_id"))
	if e != nil {
		return nil, nil, e
	}
	p, e := businessProject(c.DB, key, active)
	if e != nil {
		return nil, nil, e
	}
	r, e := One(c.DB, "SELECT * FROM quotes WHERE id=? AND project_id=?", id, p["id"])
	if e == nil && r == nil {
		e = businessMissing("Quote")
	}
	return p, r, e
}
func businessContractContext(c *Context, active bool) (Row, Row, error) {
	key, e := businessProjectKey(c)
	if e != nil {
		return nil, nil, e
	}
	id, e := PositiveID(c.R.PathValue("contract_id"))
	if e != nil {
		return nil, nil, e
	}
	p, e := businessProject(c.DB, key, active)
	if e != nil {
		return nil, nil, e
	}
	r, e := businessContractRow(c.DB, id, p["id"])
	if e == nil && r == nil {
		e = businessMissing("Contract")
	}
	return p, r, e
}
func businessContractUnique(e error) error {
	if e != nil && strings.Contains(e.Error(), "UNIQUE constraint failed") {
		return E(409, "Contract number already exists", "CONTRACT_NO_EXISTS")
	}
	return e
}
func businessContractCompany(db DBTX, id any) error {
	r, e := One(db, "SELECT id FROM companies WHERE id=?", id)
	if e != nil {
		return e
	}
	if r == nil {
		return businessInvalid("Invalid contract payload")
	}
	return nil
}
func businessContractLocked(db DBTX, r, p Row, allocations []Row) error {
	old, e := businessAllocations(db, r["id"])
	if e != nil {
		return e
	}
	if businessInt(r["total_amount_cents"]) != businessInt(p["total_amount_cents"]) || !reflect.DeepEqual(businessAllocationMap(old), businessAllocationMap(allocations)) {
		return E(409, "Signed contract amount cannot be changed", "CONTRACT_AMOUNT_LOCKED")
	}
	for _, f := range []string{"contract_no", "title", "customer_company_id", "signed_on", "final_delivery_on"} {
		if r[f] != p[f] {
			return E(409, "Formal contract fields cannot be changed in current status", "CONTRACT_FORMAL_FIELDS_LOCKED")
		}
	}
	ids, e := businessDocumentLinks(db, "contract_document_versions", "contract_id", r["id"])
	if e != nil {
		return e
	}
	set := map[int64]bool{}
	for _, id := range ids {
		set[id] = true
	}
	newids := p["document_version_ids"].([]int64)
	if len(ids) != len(newids) {
		return E(409, "Formal contract fields cannot be changed in current status", "CONTRACT_FORMAL_FIELDS_LOCKED")
	}
	for _, id := range newids {
		if !set[id] {
			return E(409, "Formal contract fields cannot be changed in current status", "CONTRACT_FORMAL_FIELDS_LOCKED")
		}
	}
	return nil
}
