package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"
)

var businessCompanyFields = []string{"name", "taxpayer_id", "registered_address", "registered_phone", "bank_name", "bank_account", "notes"}
var businessContactFields = []string{"name", "phone", "email", "position", "notes"}

func RegisterBusiness(s *Server) {
	registerCompanies(s)
	registerProjects(s)
	registerProjectStages(s)
	registerCommercial(s)
	registerDashboards(s)
}
func businessInt(v any) int64 { n, _ := Int(v); return n }
func businessExact(p Row, fields ...string) bool {
	if len(p) != len(fields) {
		return false
	}
	for _, f := range fields {
		if _, ok := p[f]; !ok {
			return false
		}
	}
	return true
}
func businessText(v any, required bool, detail string) (any, error) {
	if v == nil && !required {
		return nil, nil
	}
	s, ok := v.(string)
	if !ok {
		return nil, E(422, detail, "")
	}
	s = strings.TrimSpace(s)
	if strings.ContainsRune(s, 0) || !utf8.ValidString(s) || (required && s == "") {
		return nil, E(422, detail, "")
	}
	if s == "" {
		return nil, nil
	}
	return s, nil
}
func businessPositive(v any, detail string) (int64, error) {
	n, ok := Int(v)
	if !ok || n < 1 {
		return 0, E(422, detail, "VALIDATION_ERROR")
	}
	return n, nil
}
func businessNormalize(p Row, fields []string, update bool, detail string) (Row, error) {
	expected := append([]string{}, fields...)
	if update {
		expected = append(expected, "expected_revision")
	}
	if !businessExact(p, expected...) {
		code := ""
		if update && businessExact(p, fields...) {
			code = "VALIDATION_ERROR"
		}
		return nil, E(422, detail, code)
	}
	r := Row{}
	for i, f := range fields {
		v, e := businessText(p[f], i == 0, detail)
		if e != nil {
			return nil, e
		}
		r[f] = v
	}
	if update {
		n, e := businessPositive(p["expected_revision"], detail)
		if e != nil {
			return nil, e
		}
		r["expected_revision"] = n
	}
	return r, nil
}
func businessValues(p Row, fields []string) []any {
	r := make([]any, 0, len(fields))
	for _, f := range fields {
		r = append(r, p[f])
	}
	return r
}
func businessCompactHash(p any) (string, error) {
	b, e := CanonicalJSON(p)
	if e != nil {
		return "", e
	}
	var out bytes.Buffer
	if e = json.Compact(&out, b); e != nil {
		return "", e
	}
	h := sha256.Sum256(out.Bytes())
	return hex.EncodeToString(h[:]), nil
}
func businessRevisionPayload(c *Context) (Row, error) {
	p, e := c.Body()
	if e != nil {
		return nil, e
	}
	if !businessExact(p, "expected_revision") {
		return nil, E(422, "Invalid revision payload", "VALIDATION_ERROR")
	}
	n, e := businessPositive(p["expected_revision"], "Invalid revision payload")
	p["expected_revision"] = n
	return p, e
}
func businessCompanyDetail(db DBTX, id int64) (Row, error) {
	r, e := One(db, "SELECT id,name,taxpayer_id,registered_address,registered_phone,bank_name,bank_account,notes,revision,created_at,updated_at FROM companies WHERE id=?", id)
	if e != nil || r == nil {
		return r, e
	}
	contacts, e := All(db, "SELECT id,company_id,name,phone,email,position,notes,revision,created_at,updated_at FROM contacts WHERE company_id=? ORDER BY id", id)
	r["contacts"] = contacts
	return r, e
}
func businessCompanyError(e error) error {
	if e == nil {
		return nil
	}
	if strings.Contains(e.Error(), "UNIQUE constraint failed") {
		return E(409, "Company name already exists", "")
	}
	return e
}
func registerCompanies(s *Server) {
	businessHandle(s, "GET /api/companies", func(c *Context) (any, error) {
		return All(c.DB, `SELECT c.id,c.name,c.taxpayer_id,c.registered_address,c.registered_phone,c.bank_name,c.bank_account,c.notes,c.revision,c.created_at,c.updated_at,COUNT(t.id) AS contact_count FROM companies c LEFT JOIN contacts t ON t.company_id=c.id GROUP BY c.id ORDER BY c.name COLLATE NOCASE,c.id`)
	})
	businessHandle(s, "POST /api/companies", func(c *Context) (any, error) {
		p, e := c.Body()
		if e != nil {
			return nil, e
		}
		p, e = businessNormalize(p, businessCompanyFields, false, "Invalid company payload")
		if e != nil {
			return nil, e
		}
		key, e := businessIdempotencyKey(c.R, false)
		if e != nil {
			return nil, e
		}
		hash, e := businessCompactHash(p)
		if e != nil {
			return nil, e
		}
		c.Status = 201
		r, e := c.Tx(func(t *Context) (any, error) {
			if key != "" {
				r, e := RestoreIdempotent(t.DB, t.R, key, hash)
				if r != nil || e != nil {
					return r, e
				}
			}
			at := t.Timestamp()
			args := append(businessValues(p, businessCompanyFields), at, at)
			id, e := Insert(t.DB, "INSERT INTO companies(name,taxpayer_id,registered_address,registered_phone,bank_name,bank_account,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)", args...)
			if e != nil {
				return nil, e
			}
			r, e := businessCompanyDetail(t.DB, id)
			if e == nil && key != "" {
				e = SaveIdempotent(t.DB, t.R, key, hash, r, 201, "company", id, at)
			}
			return r, e
		})
		return r, businessCompanyError(e)
	})
	businessHandle(s, "GET /api/companies/{company_id}", func(c *Context) (any, error) {
		id, e := PositiveID(c.R.PathValue("company_id"))
		if e != nil {
			return nil, e
		}
		r, e := businessCompanyDetail(c.DB, id)
		if e == nil && r == nil {
			return nil, E(404, "Company not found", "")
		}
		return r, e
	})
	businessHandle(s, "GET /api/companies/{company_id}/ledger", func(c *Context) (any, error) {
		id, e := PositiveID(c.R.PathValue("company_id"))
		if e != nil {
			return nil, e
		}
		return c.ReadTx(func(t *Context) (any, error) {
			r, e := One(t.DB, "SELECT id FROM companies WHERE id=?", id)
			if e != nil {
				return nil, e
			}
			if r == nil {
				return nil, E(404, "Company not found", "")
			}
			return businessCompanyLedger(t.DB, id)
		})
	})
	businessHandle(s, "PUT /api/companies/{company_id}", func(c *Context) (any, error) {
		id, e := PositiveID(c.R.PathValue("company_id"))
		if e != nil {
			return nil, e
		}
		p, e := c.Body()
		if e != nil {
			return nil, e
		}
		p, e = businessNormalize(p, businessCompanyFields, true, "Invalid company payload")
		if e != nil {
			return nil, e
		}
		r, e := c.Tx(func(t *Context) (any, error) {
			r, e := One(t.DB, "SELECT revision FROM companies WHERE id=?", id)
			if e != nil {
				return nil, e
			}
			if r == nil {
				return nil, E(404, "Company not found", "")
			}
			if e = businessRevision(r, p["expected_revision"]); e != nil {
				return nil, e
			}
			args := append(businessValues(p, businessCompanyFields), t.Timestamp(), id, p["expected_revision"])
			_, e = t.DB.Exec("UPDATE companies SET name=?,taxpayer_id=?,registered_address=?,registered_phone=?,bank_name=?,bank_account=?,notes=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?", args...)
			if e != nil {
				return nil, e
			}
			return businessCompanyDetail(t.DB, id)
		})
		return r, businessCompanyError(e)
	})
	businessHandle(s, "DELETE /api/companies/{company_id}", func(c *Context) (any, error) {
		id, e := PositiveID(c.R.PathValue("company_id"))
		if e != nil {
			return nil, e
		}
		p, e := businessRevisionPayload(c)
		if e != nil {
			return nil, e
		}
		c.Status = 204
		return c.Tx(func(t *Context) (any, error) {
			r, e := One(t.DB, "SELECT revision FROM companies WHERE id=?", id)
			if e != nil {
				return nil, e
			}
			if r == nil {
				return nil, E(404, "Company not found", "")
			}
			if e = businessRevision(r, p["expected_revision"]); e != nil {
				return nil, e
			}
			_, e = t.DB.Exec("DELETE FROM companies WHERE id=? AND revision=?", id, p["expected_revision"])
			if e != nil && (strings.Contains(e.Error(), "FOREIGN KEY") || strings.Contains(e.Error(), "project")) {
				return nil, E(409, "Company is referenced by projects", "")
			}
			return nil, e
		})
	})
	businessHandle(s, "POST /api/companies/{company_id}/contacts", func(c *Context) (any, error) {
		id, e := PositiveID(c.R.PathValue("company_id"))
		if e != nil {
			return nil, e
		}
		p, e := c.Body()
		if e != nil {
			return nil, e
		}
		p, e = businessNormalize(p, businessContactFields, false, "Invalid contact payload")
		if e != nil {
			return nil, e
		}
		key, e := businessIdempotencyKey(c.R, false)
		if e != nil {
			return nil, e
		}
		hash, e := businessCompactHash(p)
		if e != nil {
			return nil, e
		}
		c.Status = 201
		return c.Tx(func(t *Context) (any, error) {
			if key != "" {
				r, e := RestoreIdempotent(t.DB, t.R, key, hash)
				if r != nil || e != nil {
					return r, e
				}
			}
			parent, e := One(t.DB, "SELECT id FROM companies WHERE id=?", id)
			if e != nil {
				return nil, e
			}
			if parent == nil {
				return nil, E(404, "Company not found", "")
			}
			at := t.Timestamp()
			args := append([]any{id}, businessValues(p, businessContactFields)...)
			args = append(args, at, at)
			cid, e := Insert(t.DB, "INSERT INTO contacts(company_id,name,phone,email,position,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", args...)
			if e != nil {
				return nil, e
			}
			r, e := One(t.DB, "SELECT id,company_id,name,phone,email,position,notes,revision,created_at,updated_at FROM contacts WHERE id=?", cid)
			if e == nil && key != "" {
				e = SaveIdempotent(t.DB, t.R, key, hash, r, 201, "contact", cid, at)
			}
			return r, e
		})
	})
	for _, method := range []string{"PUT", "DELETE"} {
		method := method
		businessHandle(s, method+" /api/companies/{company_id}/contacts/{contact_id}", func(c *Context) (any, error) {
			id, e := PositiveID(c.R.PathValue("company_id"))
			if e != nil {
				return nil, e
			}
			cid, e := PositiveID(c.R.PathValue("contact_id"))
			if e != nil {
				return nil, e
			}
			var p Row
			if method == "DELETE" {
				p, e = businessRevisionPayload(c)
				c.Status = 204
			} else {
				p, e = c.Body()
				if e == nil {
					p, e = businessNormalize(p, businessContactFields, true, "Invalid contact payload")
				}
			}
			if e != nil {
				return nil, e
			}
			return c.Tx(func(t *Context) (any, error) {
				r, e := One(t.DB, "SELECT revision FROM contacts WHERE id=? AND company_id=?", cid, id)
				if e != nil {
					return nil, e
				}
				if r == nil {
					return nil, E(404, "Contact not found", "")
				}
				if e = businessRevision(r, p["expected_revision"]); e != nil {
					return nil, e
				}
				if method == "DELETE" {
					_, e = t.DB.Exec("DELETE FROM contacts WHERE id=? AND company_id=? AND revision=?", cid, id, p["expected_revision"])
					return nil, e
				}
				args := append(businessValues(p, businessContactFields), t.Timestamp(), cid, id, p["expected_revision"])
				_, e = t.DB.Exec("UPDATE contacts SET name=?,phone=?,email=?,position=?,notes=?,revision=revision+1,updated_at=? WHERE id=? AND company_id=? AND revision=?", args...)
				if e != nil {
					return nil, e
				}
				return One(t.DB, "SELECT id,company_id,name,phone,email,position,notes,revision,created_at,updated_at FROM contacts WHERE id=?", cid)
			})
		})
	}
}
func businessAdd(r Row, k string, n int64) { r[k] = businessInt(r[k]) + n }
func businessMax(n int64) int64 {
	if n < 0 {
		return 0
	}
	return n
}
func businessMissing(subject string) error {
	return E(404, fmt.Sprintf("%s not found", subject), "RESOURCE_NOT_FOUND")
}

func businessRevision(r Row, expected any) error {
	current := businessInt(r["revision"])
	value, ok := Int(expected)
	if !ok || value != current {
		e := E(409, "Resource was modified", "REVISION_CONFLICT")
		e.CurrentRevision = &current
		e.Headers = map[string]string{"X-Error-Code": "REVISION_CONFLICT", "X-Current-Revision": fmt.Sprint(current)}
		return e
	}
	return nil
}
