package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	"golang.org/x/text/cases"
)

// Procurement operations use one typed error boundary inside the transaction so every failed invariant rolls back.
type procFailure struct{ err error }

func pCheck(err error) {
	if err != nil {
		panic(procFailure{err})
	}
}
func pInvalid(detail string) { pCheck(E(422, detail, "VALIDATION_ERROR")) }
func pConflict(detail, code string) {
	e := E(409, detail, code)
	e.Headers = map[string]string{"X-Error-Code": code}
	pCheck(e)
}
func pCatch(c *Context, fn func(*Context) any) (result any, err error) {
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(procFailure); ok {
				err = e.err
				if ae, ok := err.(*APIError); ok && c != nil && ae.Detail == "Invalid monetary value" && (strings.HasPrefix(c.R.URL.Path, "/api/inventory/items") || strings.HasPrefix(c.R.URL.Path, "/api/inventory/adjustments")) {
					ae.Detail = "Invalid inventory payload"
				}
			} else {
				panic(r)
			}
		}
	}()
	return fn(c), nil
}
func pHandle(s *Server, pattern string, write bool, status int, fn func(*Context) any) {
	s.Handle(pattern, func(c *Context) (any, error) {
		c.Status = status
		if write {
			return c.Tx(func(tx *Context) (any, error) { return pCatch(tx, fn) })
		}
		return pCatch(c, fn)
	})
}
func pOne(db DBTX, q string, args ...any) Row    { r, e := One(db, q, args...); pCheck(e); return r }
func pRows(db DBTX, q string, args ...any) []Row { r, e := All(db, q, args...); pCheck(e); return r }
func pExec(db DBTX, q string, args ...any) int64 {
	r, e := db.Exec(q, args...)
	pCheck(e)
	n, e := r.RowsAffected()
	pCheck(e)
	return n
}
func pInsert(db DBTX, q string, args ...any) int64 {
	v, e := Insert(db, q, args...)
	pCheck(e)
	return v
}
func pInt(v any) int64 { n, _ := Int(v); return n }
func pScalar(db DBTX, q string, args ...any) int64 {
	r := pOne(db, q, args...)
	for _, v := range r {
		return pInt(v)
	}
	return 0
}
func pSQL(module, fn string, index int) string {
	q := procSQL[fmt.Sprintf("%s:%s:%d", module, fn, index)]
	if q == "" {
		panic("missing procurement SQL")
	}
	return q
}
func pFields(r Row, fields string) Row { return Fields(r, strings.Fields(fields)...) }
func pRequireFields(r Row, required, optional string) {
	allowed := map[string]bool{}
	for _, k := range strings.Fields(required) {
		allowed[k] = true
		if _, ok := r[k]; !ok {
			pInvalid("Invalid procurement payload")
		}
	}
	for _, k := range strings.Fields(optional) {
		allowed[k] = true
	}
	for k := range r {
		if !allowed[k] {
			pInvalid("Invalid procurement payload")
		}
	}
}
func pBody(c *Context, required, optional string) Row {
	r, e := c.Body()
	pCheck(e)
	pRequireFields(r, required, optional)
	return r
}
func pOptional(v any) any {
	if v == nil {
		return nil
	}
	s, ok := v.(string)
	if !ok {
		pInvalid("Invalid procurement payload")
	}
	s = strings.TrimSpace(s)
	if strings.ContainsRune(s, 0) {
		pInvalid("Invalid procurement payload")
	}
	if s == "" {
		return nil
	}
	return s
}
func pText(v any) string {
	n := pOptional(v)
	if n == nil {
		pInvalid("Invalid procurement payload")
	}
	return n.(string)
}
func pPositive(v any) int64 {
	n, ok := Int(v)
	if !ok || n <= 0 {
		pInvalid("Invalid procurement payload")
	}
	if j, ok := v.(json.Number); ok && strings.ContainsAny(string(j), ".eE") {
		pInvalid("Invalid procurement payload")
	}
	return n
}
func pMoney(v any) int64 {
	n, ok := Int(v)
	if !ok || n < 0 || n > 9000000000000 {
		pInvalid("Invalid monetary value")
	}
	if j, ok := v.(json.Number); ok && strings.ContainsAny(string(j), ".eE") {
		pInvalid("Invalid monetary value")
	}
	return n
}
func pDate(v any) string {
	s, ok := v.(string)
	if !ok {
		pInvalid("Invalid date")
	}
	d, e := time.Parse("2006-01-02", s)
	if e != nil || d.Format("2006-01-02") != s {
		pInvalid("Invalid date")
	}
	return s
}
func pID(c *Context, k string) int64 { v, e := PositiveID(c.R.PathValue(k)); pCheck(e); return v }
func pQuantity(v any, negative bool) int64 {
	n, e := procParseQuantity(v, negative)
	if e != nil {
		pInvalid(e.Error())
	}
	return n
}
func pValue(unit, q int64) int64 {
	n, e := procRoundedProduct(unit, q, 1000)
	if e != nil || n < 0 {
		pInvalid("Invalid monetary value")
	}
	return n
}
func pRound(a, b, d int64) int64 { n, e := procRoundedProduct(a, b, d); pCheck(e); return n }
func pAdd(a, b int64) int64 {
	if b > 0 && a > math.MaxInt64-b || b < 0 && a < math.MinInt64-b {
		pInvalid("Invalid monetary value")
	}
	return a + b
}
func pGross(r Row) int64 {
	return pAdd(pValue(pInt(r["unit_cost_cents"]), pInt(r["quantity_milli"])), pInt(r["tax_amount_cents"]))
}
func pArray(v any) []any {
	a, ok := v.([]any)
	if !ok {
		pInvalid("Invalid procurement payload")
	}
	return a
}
func pLineArray(v any) []Row {
	a := pArray(v)
	if len(a) == 0 {
		pInvalid("Invalid procurement payload")
	}
	rows := make([]Row, 0, len(a))
	for _, v := range a {
		r, ok := v.(map[string]any)
		if !ok {
			pInvalid("Invalid procurement payload")
		}
		rows = append(rows, r)
	}
	return rows
}
func pIDs(v any) []int64 {
	a := pArray(v)
	out := make([]int64, 0, len(a))
	seen := map[int64]bool{}
	for _, x := range a {
		n := pPositive(x)
		if seen[n] {
			pInvalid("Invalid procurement payload")
		}
		seen[n] = true
		out = append(out, n)
	}
	return out
}
func pSingle(c *Context, k string) *string {
	a, ok := c.R.URL.Query()[k]
	if !ok {
		return nil
	}
	if len(a) != 1 {
		pInvalid("Invalid " + k)
	}
	return &a[0]
}
func pPage(c *Context) (int64, int64) {
	read := func(k string, d, max int64) int64 {
		v := pSingle(c, k)
		if v == nil {
			return d
		}
		if *v == "" {
			pInvalid("Invalid pagination")
		}
		for _, r := range *v {
			if r < '0' || r > '9' {
				pInvalid("Invalid pagination")
			}
		}
		n, e := strconv.ParseInt(*v, 10, 64)
		if e != nil || n < 1 || n > max {
			pInvalid("Invalid pagination")
		}
		return n
	}
	return read("page", 1, math.MaxInt64), read("page_size", 50, 200)
}
func pProject(c *Context, active bool) Row {
	k, e := ProjectIdentity(c.R.PathValue("project_code"))
	pCheck(e)
	r := pOne(c.DB, "SELECT * FROM projects WHERE project_code_key = ?", k)
	if r == nil {
		pCheck(E(404, "Project not found", "RESOURCE_NOT_FOUND"))
	}
	if active && r["status"] != "active" {
		pConflict("Project is archived", "PROJECT_ARCHIVED")
	}
	return r
}
func pActive(r Row) {
	if r["status"] != "active" {
		pConflict("Project is archived", "PROJECT_ARCHIVED")
	}
}
func pRequired(r Row, detail string) Row {
	if r == nil {
		pCheck(E(404, detail, "RESOURCE_NOT_FOUND"))
	}
	return r
}
func pList(c *Context, id, project any, editable bool) Row {
	r := pRequired(pOne(c.DB, "SELECT * FROM procurement_lists WHERE id = ? AND project_id = ?", id, project), "Procurement list not found")
	if editable && r["status"] != "draft" {
		pConflict("Procurement list is not editable", "PROCUREMENT_LIST_NOT_EDITABLE")
	}
	return r
}
func pOrder(c *Context, id, project any) Row {
	return pRequired(pOne(c.DB, "SELECT * FROM purchase_orders WHERE id = ? AND project_id = ?", id, project), "Purchase order not found")
}
func pOrderLines(db DBTX, id any) []Row {
	return pRows(db, "SELECT * FROM purchase_order_lines WHERE purchase_order_id = ? ORDER BY id", id)
}
func pListLines(db DBTX, id any) []Row {
	return pRows(db, "SELECT * FROM procurement_lines WHERE procurement_list_id = ? ORDER BY sequence_no,id", id)
}
func pRevision(row Row, v any) {
	expected := pPositive(v)
	current := pInt(row["revision"])
	if expected != current {
		e := E(409, "Resource was modified", "REVISION_CONFLICT")
		e.CurrentRevision = &current
		e.Headers = map[string]string{"X-Error-Code": "REVISION_CONFLICT", "X-Current-Revision": strconv.FormatInt(current, 10)}
		pCheck(e)
	}
}
func pIdentity(r Row) []any {
	return []any{cases.Fold().String(Str(r["name"])), cases.Fold().String(Str(r["unit"])), r["brand"], r["model"], r["specification"]}
}
func pSameIdentity(a, b Row) bool { return reflect.DeepEqual(pIdentity(a), pIdentity(b)) }
func pStorageKey(r *http.Request, key string) string {
	d := sha256.Sum256([]byte(r.Method + ":" + r.URL.Path + "\x00" + key))
	return hex.EncodeToString(d[:])
}
func pCanonicalProject(c *Context, project Row) {
	r := c.R.Clone(c.R.Context())
	u := *r.URL
	r.URL = &u
	code := c.R.PathValue("project_code")
	r.URL.Path = strings.Replace(r.URL.Path, "/api/projects/"+code+"/", "/api/projects/"+Str(project["project_code"])+"/", 1)
	c.R = r
}
func pIdem(c *Context, normalized any, fn func(key, hash, stored string) Row, resource string) Row {
	key := pKey(c)
	hash, e := RequestHash(normalized)
	pCheck(e)
	old, e := RestoreIdempotent(c.DB, c.R, key, hash)
	pCheck(e)
	if old != nil {
		return old
	}
	out := fn(key, hash, pStorageKey(c.R, key))
	resourceID := pInt(out["id"])
	if nested, ok := out["import"].(Row); ok {
		resourceID = pInt(nested["id"])
	}
	pCheck(SaveIdempotent(c.DB, c.R, key, hash, out, c.Status, resource, resourceID, c.Timestamp()))
	return out
}
func pSameHash(stored any, hash string) {
	if stored != hash {
		pConflict("Idempotency key reused", "IDEMPOTENCY_KEY_REUSED")
	}
}
func pUnique(err error, detail, code string) error {
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "unique constraint") {
		e := E(409, detail, code)
		e.Headers = map[string]string{"X-Error-Code": code}
		return e
	}
	return err
}
func pQuantityStatus(actual, target int64, zero, complete, over string) string {
	if actual == 0 || target == 0 {
		return zero
	}
	if actual < target {
		return "partial"
	}
	if actual == target {
		return complete
	}
	return over
}
func pAmountStatus(actual, target int64, zero, complete string) string {
	if actual == 0 || target == 0 {
		return zero
	}
	if actual < target {
		return "partial"
	}
	return complete
}
func pDocumentVersions(c *Context, project string, ids []int64) {
	for _, id := range ids {
		r := pOne(c.DB, `SELECT versions.id FROM document_versions versions JOIN documents ON documents.id=versions.document_id WHERE versions.id=? AND documents.project_code=? COLLATE NOCASE AND documents.archived_at IS NULL`, id, project)
		if r == nil {
			pInvalid("Invalid purchase order payload")
		}
	}
}
func pConfirmedLine(c *Context, id, project any) Row {
	r := pOne(c.DB, pSQL("procurement", "_confirmed_procurement_line", 0), id, project)
	if r == nil {
		pInvalid("Invalid purchase order payload")
	}
	return r
}
func pNormalizeLine(r Row) Row {
	pRequireFields(r, "sequence_no category name specification brand model quantity unit unit_cost_cents quoted_unit_price_cents", "")
	q := pQuantity(r["quantity"], false)
	unit := pMoney(r["unit_cost_cents"])
	quote := pMoney(r["quoted_unit_price_cents"])
	pValue(unit, q)
	pValue(quote, q)
	return Row{"sequence_no": pPositive(r["sequence_no"]), "category": pText(r["category"]), "name": pText(r["name"]), "specification": pOptional(r["specification"]), "brand": pOptional(r["brand"]), "model": pOptional(r["model"]), "quantity_milli": q, "unit": pText(r["unit"]), "unit_cost_cents": unit, "quoted_unit_price_cents": quote}
}
func pNormalizeOrder(r Row, auto bool) Row {
	pRequireFields(r, "order_no supplier_company_id ordered_on expected_delivery_on lines notes document_version_ids", "tax_rate_bps")
	var rate any
	if r["tax_rate_bps"] != nil {
		n, ok := Int(r["tax_rate_bps"])
		if !ok || n < 0 || n > 10000 {
			pInvalid("Invalid purchase order payload")
		}
		if j, ok := r["tax_rate_bps"].(json.Number); ok && strings.ContainsAny(string(j), ".eE") {
			pInvalid("Invalid purchase order payload")
		}
		rate = n
	}
	lines := []Row{}
	seen := map[int64]bool{}
	total := int64(0)
	for _, l := range pLineArray(r["lines"]) {
		pRequireFields(l, "procurement_line_id quantity unit_cost_cents overage_reason", "")
		id := pPositive(l["procurement_line_id"])
		if seen[id] {
			pInvalid("Invalid purchase order payload")
		}
		seen[id] = true
		q := pQuantity(l["quantity"], false)
		unit := pMoney(l["unit_cost_cents"])
		_, tax, gross, e := procAmounts(unit, q, pInt(rate))
		if e != nil {
			pInvalid("Invalid purchase order payload")
		}
		total = pAdd(total, gross)
		out := Row{"procurement_line_id": id, "quantity_milli": q, "unit_cost_cents": unit, "overage_reason": pOptional(l["overage_reason"])}
		if _, ok := r["tax_rate_bps"]; ok {
			out["tax_amount_cents"] = tax
		}
		lines = append(lines, out)
	}
	date := pDate(r["ordered_on"])
	var delivery any
	if r["expected_delivery_on"] != nil {
		delivery = pDate(r["expected_delivery_on"])
		if delivery.(string) < date {
			pInvalid("Invalid purchase order payload")
		}
	}
	no := ""
	if !auto || r["order_no"] != "" {
		no = pText(r["order_no"])
	}
	out := Row{"order_no": no, "supplier_company_id": pPositive(r["supplier_company_id"]), "ordered_on": date, "expected_delivery_on": delivery, "lines": lines, "notes": pOptional(r["notes"]), "document_version_ids": pIDs(r["document_version_ids"])}
	if _, ok := r["tax_rate_bps"]; ok {
		out["tax_rate_bps"] = rate
	}
	return out
}
