package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"golang.org/x/text/cases"
	"log"
	"math"
	"math/big"
	"net/http"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// dFailure is caught only at the module boundary, including transaction callbacks.
// Unexpected programmer panics are deliberately not converted to successful responses.
type dFailure struct{ err error }

func dWrap(fn func(*Context) any) Handler {
	return func(c *Context) (out any, err error) {
		defer func() {
			if p := recover(); p != nil {
				if f, ok := p.(dFailure); ok {
					err = f.err
				} else {
					panic(p)
				}
			}
		}()
		out = fn(c)
		return
	}
}
func dDomain(module string, fn func(*Context) any) Handler {
	h := dWrap(fn)
	return func(c *Context) (any, error) {
		var out any
		var err error
		if c.R.Method == http.MethodGet {
			out, err = c.ReadTx(h)
		} else {
			out, err = h(c)
		}
		var apiError *APIError
		if errors.As(err, &apiError) && apiError.Status == 422 {
			switch module {
			case "workforce":
				apiError.Detail = "Invalid workforce payload"
			case "site":
				apiError.Detail = "Invalid site operation payload"
			default:
				apiError.Detail = "Invalid delivery payload"
			}
		}
		if err != nil && !errors.As(err, &apiError) {
			log.Printf("%s operation failed: %v", module, err)
			switch module {
			case "workforce":
				err = E(500, "Workforce operation failed", "WORKFORCE_OPERATION_FAILED")
			case "site":
				err = E(500, "Site operation failed", "SITE_OPERATION_FAILED")
			default:
				err = E(500, "Delivery operation failed", "DELIVERY_OPERATION_FAILED")
			}
		}
		return out, err
	}
}
func dTry[T any](value T, err error) T {
	if err != nil {
		panic(dFailure{err})
	}
	return value
}
func dCheck(err error) {
	if err != nil {
		panic(dFailure{err})
	}
}
func dFail(status int, detail, code string) { panic(dFailure{E(status, detail, code)}) }
func dInvalid(code, field, msg string) {
	e := Invalid(code, field, msg)
	e.FieldErrors = Row{field: msg}
	switch {
	case strings.Contains(code, "WORKER") || strings.Contains(code, "ASSIGNMENT") || strings.Contains(code, "LABOR") || code == "INVALID_DEACTIVATION_PAYLOAD" || code == "INVALID_REACTIVATION_PAYLOAD":
		e.Detail = "Invalid workforce payload"
	case strings.Contains(code, "REPORT") || strings.Contains(code, "ADVANCE") || strings.Contains(code, "REIMBURSEMENT"):
		e.Detail = "Invalid site operation payload"
	default:
		e.Detail = "Invalid delivery payload"
	}
	panic(dFailure{e})
}
func dTx(c *Context, fn func(*Context) any) any    { return dTry(c.Tx(dWrap(fn))) }
func dRow(db DBTX, q string, args ...any) Row      { return dTry(One(db, q, args...)) }
func dRows(db DBTX, q string, args ...any) []Row   { return dTry(All(db, q, args...)) }
func dExec(db DBTX, q string, args ...any)         { _, err := db.Exec(q, args...); dCheck(err) }
func dInsert(db DBTX, q string, args ...any) int64 { return dTry(Insert(db, q, args...)) }
func dI(v any) int64                               { n, _ := Int(v); return n }
func dFields(r Row, fields string) Row             { return Fields(r, strings.Fields(fields)...) }
func dExact(r Row, fields, code string) {
	keys := strings.Fields(fields)
	if len(r) != len(keys) {
		dInvalid(code, "body", "has invalid fields")
	}
	for _, key := range keys {
		if _, ok := r[key]; !ok {
			dInvalid(code, "body", "has invalid fields")
		}
	}
}
func dBody(c *Context, fields, code string) Row {
	r, err := c.Body()
	if err != nil {
		dInvalid(code, "body", "must be valid JSON")
	}
	dExact(r, fields, code)
	return r
}
func dText(v any, field, code string, required bool) any {
	if v == nil && !required {
		return nil
	}
	s, ok := v.(string)
	if !ok {
		dInvalid(code, field, "must be a string")
	}
	s = strings.TrimSpace(s)
	if strings.ContainsRune(s, 0) {
		dInvalid(code, field, "contains an invalid character")
	}
	if !utf8.ValidString(s) {
		dInvalid(code, field, "must be valid UTF-8")
	}
	if s == "" {
		if required {
			dInvalid(code, field, "must not be empty")
		}
		return nil
	}
	return s
}
func dInteger(v any, field, code string, min int64) int64 {
	if n, ok := v.(json.Number); ok && strings.ContainsAny(string(n), ".eE") {
		dInvalid(code, field, "is out of range")
	}
	if _, ok := v.(float64); ok {
		dInvalid(code, field, "is out of range")
	}
	n, ok := Int(v)
	if !ok || n < min {
		dInvalid(code, field, "is out of range")
	}
	return n
}
func dDate(v any, field, code string, optional bool) any {
	if v == nil && optional {
		return nil
	}
	s, ok := v.(string)
	t, err := time.Parse("2006-01-02", s)
	if !ok || err != nil || t.Format("2006-01-02") != s {
		dInvalid(code, field, "must be YYYY-MM-DD")
	}
	return s
}
func dDatetime(v any, field, code string, optional bool) any {
	if v == nil && optional {
		return nil
	}
	s, ok := v.(string)
	if !ok {
		dInvalid(code, field, "must be an ISO 8601 datetime")
	}
	s = strings.Replace(s, " ", "T", 1)
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		dInvalid(code, field, "must be an ISO 8601 datetime with timezone")
	}
	if t.Nanosecond()/1000 != 0 {
		return t.UTC().Format("2006-01-02T15:04:05.000000+00:00")
	}
	return t.UTC().Format("2006-01-02T15:04:05+00:00")
}
func dEnum(v any, field, code, allowed string) string {
	s, ok := v.(string)
	if !ok || !strings.Contains("|"+allowed+"|", "|"+s+"|") {
		dInvalid(code, field, "has an invalid value")
	}
	return s
}
func dID(c *Context, name string) int64 { return dIdentifier(c.R.PathValue(name)) }
func dIdentifier(value string) int64 {
	n, err := PositiveID(value)
	if err != nil {
		dInvalid("INVALID_IDENTIFIER", "identifier", "must be a positive integer")
	}
	return n
}
func dProject(c *Context, active bool) Row {
	key, err := ProjectIdentity(c.R.PathValue("project_code"))
	if err != nil {
		dInvalid("INVALID_PROJECT_CODE", "project_code", "is invalid")
	}
	r := dRow(c.DB, "SELECT * FROM projects WHERE project_code_key=?", key)
	if r == nil {
		dFail(404, "Project not found", "PROJECT_NOT_FOUND")
	}
	if active && r["status"] == "archived" {
		dFail(409, "Archived project cannot accept new records", "PROJECT_ARCHIVED")
	}
	return r
}
func dOwned(c *Context, table string, project, id int64, code string) Row {
	r := dRow(c.DB, "SELECT * FROM "+table+" WHERE id=? AND project_id=?", id, project)
	if r == nil {
		dFail(404, "Record not found", code)
	}
	return r
}
func dRevision(r Row, expected any) {
	current := dI(r["revision"])
	n, ok := Int(expected)
	if !ok || n != current {
		e := E(409, "Resource was modified", "REVISION_CONFLICT")
		e.CurrentRevision = &current
		panic(dFailure{e})
	}
}
func dSingleQuery(c *Context, name, code string) (string, bool) {
	v, ok := c.R.URL.Query()[name]
	if !ok {
		return "", false
	}
	if len(v) != 1 {
		dInvalid(code, name, "must occur once")
	}
	return v[0], true
}
func dPage(c *Context) (int64, int64) {
	p, n := int64(1), int64(50)
	for _, x := range []struct {
		name string
		dst  *int64
		max  int64
	}{{"page", &p, math.MaxInt64}, {"page_size", &n, 200}} {
		if s, ok := dSingleQuery(c, x.name, "INVALID_PAGINATION"); ok {
			v, e := strconv.ParseInt(s, 10, 64)
			if e != nil || v < 1 || v > x.max || strings.ContainsAny(s, "+- ") {
				dInvalid("INVALID_PAGINATION", x.name, "is out of range")
			}
			*x.dst = v
		}
	}
	if (p - 1) > math.MaxInt64/n {
		dInvalid("INVALID_PAGINATION", "page", "is out of range")
	}
	return p, n
}
func dPaged(c *Context, query, count string, args []any, convert func(Row) Row) Row {
	p, n := dPage(c)
	total := dI(dRow(c.DB, count, args...)["total"])
	rows := dRows(c.DB, query+" LIMIT ? OFFSET ?", append(append([]any{}, args...), n, (p-1)*n)...)
	if convert != nil {
		for i, r := range rows {
			rows[i] = convert(r)
		}
	}
	return Row{"items": rows, "total": total, "page": p, "page_size": n}
}
func dCompactHash(v any) string {
	b := dTry(CanonicalJSON(v))
	var compact bytes.Buffer
	dCheck(json.Compact(&compact, b))
	sum := sha256.Sum256(compact.Bytes())
	return hex.EncodeToString(sum[:])
}
func dKey(c *Context) string {
	values := c.R.Header.Values("Idempotency-Key")
	if len(values) != 1 {
		dInvalid("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key", "must occur once")
	}
	id, err := uuid.Parse(values[0])
	if err != nil {
		dInvalid("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key", "must be a UUID")
	}
	return id.String()
}
func dIdempotent(c *Context, payload Row, status int, resource string, fn func(*Context) any) any {
	key := dKey(c)
	hash := dCompactHash(payload)
	c.Status = status
	scope := "POST:" + cases.Fold().String(c.R.URL.Path)
	return dTx(c, func(tx *Context) any {
		if old := dRow(tx.DB, "SELECT request_sha256,response_json FROM idempotency_requests WHERE scope=? AND idempotency_key=?", scope, key); old != nil {
			if old["request_sha256"] != hash {
				dFail(409, "Idempotency key was already used with different content", "IDEMPOTENCY_CONFLICT")
			}
			var restored Row
			dec := json.NewDecoder(strings.NewReader(Str(old["response_json"])))
			dec.UseNumber()
			dCheck(dec.Decode(&restored))
			return restored
		}
		out := fn(tx).(Row)
		dExec(tx.DB, "INSERT INTO idempotency_requests(scope,idempotency_key,request_sha256,response_status,response_json,resource_type,resource_id,created_at) VALUES(?,?,?,?,?,?,?,?)", scope, key, hash, status, string(dTry(CanonicalJSON(out))), resource, out["id"], tx.Timestamp())
		return out
	})
}
func dIDs(v any, code string) []int64 {
	raw, ok := v.([]any)
	if !ok {
		if ids, yes := v.([]int64); yes {
			return ids
		}
		dInvalid(code, "document_version_ids", "must be an array")
	}
	ids := make([]int64, 0, len(raw))
	seen := map[int64]bool{}
	for _, v := range raw {
		id := dInteger(v, "document_version_ids", code, 1)
		if seen[id] {
			dInvalid(code, "document_version_ids", "must not contain duplicates")
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids
}

var dDecimalPattern = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

func dDecimalMilli(v any, field, code string, max int64) int64 {
	s, ok := v.(string)
	if !ok {
		dInvalid(code, field, "must be a decimal string")
	}
	s = strings.ReplaceAll(strings.TrimSpace(s), "_", "")
	if !dDecimalPattern.MatchString(s) {
		dInvalid(code, field, "must be a decimal string")
	}
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		dInvalid(code, field, "must be a decimal string")
	}
	r.Mul(r, big.NewRat(1000, 1))
	if !r.IsInt() {
		dInvalid(code, field, "supports at most 3 decimal places")
	}
	n := r.Num()
	if !n.IsInt64() || n.Sign() <= 0 || (max > 0 && n.Int64() > max) {
		dInvalid(code, field, "is out of range")
	}
	return n.Int64()
}
func dRoundMul(a, b, div int64, code, field string) int64 {
	v := new(big.Int).Mul(big.NewInt(a), big.NewInt(b))
	v.Add(v, big.NewInt(div/2))
	v.Quo(v, big.NewInt(div))
	if !v.IsInt64() {
		dInvalid(code, field, "calculated cost is outside the supported range")
	}
	return v.Int64()
}
func dEqual(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	if x, ok := Int(a); ok {
		if y, yes := Int(b); yes {
			return x == y
		}
	}
	return reflect.DeepEqual(a, b)
}
func dFraction(v any) any {
	if v == nil {
		return nil
	}
	n := dI(v)
	return fmt.Sprintf("%d.%03d", n/1000, n%1000)
}
func dEnumQuery(c *Context, name, code, allowed, def string) string {
	if v, ok := dSingleQuery(c, name, code); ok {
		return dEnum(v, name, code, allowed)
	}
	return def
}
