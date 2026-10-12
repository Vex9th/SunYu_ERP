package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"sunyu.local/erp/internal/config"
	"sunyu.local/erp/internal/database"
)

type Row = map[string]any
type DBTX interface {
	Exec(string, ...any) (sql.Result, error)
	Query(string, ...any) (*sql.Rows, error)
	QueryRow(string, ...any) *sql.Row
}
type Server struct {
	DB               *sql.DB
	Config           config.Settings
	Root, Version    string
	Now              func() time.Time
	Mux              *http.ServeMux
	SettingsSnapshot func() config.Settings
	System           *System
	Updates          UpdateEngine
	Supervised       bool
}
type Context struct {
	S                 *Server
	R                 *http.Request
	W                 http.ResponseWriter
	DB                DBTX
	Status            int
	commitCallbacks   *[]func()
	rollbackCallbacks *[]func()
	readOnly          bool
}
type Handler func(*Context) (any, error)
type APIError struct {
	Status          int
	Detail, Code    string
	FieldErrors     Row
	CurrentRevision *int64
	Headers         map[string]string
}

func (e *APIError) Error() string { return e.Detail }
func E(status int, detail, code string) *APIError {
	return &APIError{Status: status, Detail: detail, Code: code, FieldErrors: Row{}}
}
func Invalid(code, field, message string) *APIError {
	e := E(422, "Invalid payload", code)
	e.FieldErrors = Row{field: []string{message}}
	return e
}
func New(db *sql.DB, settings config.Settings) *Server {
	return &Server{DB: db, Config: settings, Version: "dev", Now: time.Now, Mux: http.NewServeMux()}
}
func (s *Server) Handle(pattern string, h Handler)                 { s.register(pattern, h, true) }
func (s *Server) Public(pattern string, h Handler)                 { s.register(pattern, h, false) }
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.Mux.ServeHTTP(w, r) }
func (s *Server) register(pattern string, h Handler, protected bool) {
	s.Mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		if protected {
			cookie, err := r.Cookie("sunyu_session")
			if err != nil || !ValidSession(s.Config.SessionSecret, cookie.Value, s.Now()) {
				writeError(w, E(401, "Authentication required", ""))
				return
			}
		}
		c := &Context{S: s, R: r, W: w, DB: s.DB, Status: 200}
		defer func() {
			if failure := recover(); failure != nil {
				log.Printf("API panic %s: %v", r.URL.Path, failure)
				if c.Status != 0 {
					writeError(w, E(500, "Operation failed", ""))
				}
			}
		}()
		value, err := h(c)
		if err != nil {
			writeError(w, err)
			return
		}
		if c.Status == 0 {
			return
		}
		if c.Status == 204 {
			w.WriteHeader(204)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(c.Status)
		if err = json.NewEncoder(w).Encode(value); err != nil {
			log.Printf("write response %s: %v", r.URL.Path, err)
		}
	})
}
func writeError(w http.ResponseWriter, err error) {
	var ae *APIError
	if !errors.As(err, &ae) {
		log.Printf("API failure: %v", err)
		ae = E(500, "Operation failed", "")
	}
	body := Row{"detail": ae.Detail}
	if ae.Code != "" {
		fields := ae.FieldErrors
		if fields == nil {
			fields = Row{}
		}
		body["error_code"] = ae.Code
		body["field_errors"] = fields
		body["current_revision"] = ae.CurrentRevision
	}
	for k, v := range ae.Headers {
		w.Header().Set(k, v)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(ae.Status)
	_ = json.NewEncoder(w).Encode(body)
}
func (c *Context) Body() (Row, error) {
	data, err := io.ReadAll(io.LimitReader(c.R.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 || !validJSONUnicode(data) {
		return nil, E(422, "Invalid JSON object", "")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var r Row
	if err := dec.Decode(&r); err != nil || r == nil {
		return nil, E(422, "Invalid JSON object", "")
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return nil, E(422, "Invalid JSON object", "")
	}
	return r, nil
}
func (c *Context) Timestamp() string {
	return c.S.Now().UTC().Format("2006-01-02T15:04:05.999999+00:00")
}
func (c *Context) Tx(fn Handler) (result any, err error) {
	if c.commitCallbacks != nil || c.readOnly {
		return nil, errors.New("nested transactions are not supported")
	}
	tx, err := c.S.DB.BeginTx(c.R.Context(), nil)
	if err != nil {
		return nil, err
	}
	committed := false
	commits, rollbacks := []func(){}, []func(){}
	defer func() {
		if !committed {
			_ = tx.Rollback()
			for i := len(rollbacks) - 1; i >= 0; i-- {
				rollbacks[i]()
			}
		}
	}()
	child := *c
	child.DB = tx
	child.commitCallbacks = &commits
	child.rollbackCallbacks = &rollbacks
	result, err = fn(&child)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	committed = true
	c.Status = child.Status
	for _, cb := range commits {
		cb()
	}
	return result, nil
}

type snapshotConnection struct {
	conn *sql.Conn
	ctx  context.Context
}

func (s snapshotConnection) Exec(string, ...any) (sql.Result, error) {
	return nil, errors.New("write in read transaction")
}
func (s snapshotConnection) Query(q string, args ...any) (*sql.Rows, error) {
	return s.conn.QueryContext(s.ctx, q, args...)
}
func (s snapshotConnection) QueryRow(q string, args ...any) *sql.Row {
	return s.conn.QueryRowContext(s.ctx, q, args...)
}

// A deferred transaction gives one consistent snapshot without reserving the
// writer lock used by mutation transactions on this connection pool.
func (c *Context) ReadTx(fn Handler) (result any, err error) {
	if c.commitCallbacks != nil || c.readOnly {
		return nil, errors.New("nested transactions are not supported")
	}
	ctx := c.R.Context()
	conn, err := c.S.DB.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "BEGIN DEFERRED"); err != nil {
		return nil, err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	child := *c
	child.readOnly = true
	child.DB = snapshotConnection{conn: conn, ctx: ctx}
	result, err = fn(&child)
	if err != nil {
		return nil, err
	}
	if _, err = conn.ExecContext(ctx, "COMMIT"); err != nil {
		return nil, err
	}
	c.Status = child.Status
	return result, nil
}

func validJSONUnicode(data []byte) bool {
	if !utf8.Valid(data) {
		return false
	}
	quoted := false
	for i := 0; i < len(data); i++ {
		if data[i] == '"' {
			quoted = !quoted
			continue
		}
		if !quoted || data[i] != '\\' {
			continue
		}
		i++
		if i >= len(data) {
			return false
		}
		if data[i] != 'u' {
			continue
		}
		if i+4 >= len(data) {
			return false
		}
		v, e := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
		if e != nil {
			return false
		}
		i += 4
		if v >= 0xdc00 && v <= 0xdfff {
			return false
		}
		if v >= 0xd800 && v <= 0xdbff {
			if i+6 >= len(data) || data[i+1] != '\\' || data[i+2] != 'u' {
				return false
			}
			v, e = strconv.ParseUint(string(data[i+3:i+7]), 16, 16)
			if e != nil || v < 0xdc00 || v > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return true
}
func All(db DBTX, q string, args ...any) ([]Row, error) {
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []Row{}
	for rows.Next() {
		values := make([]any, len(columns))
		p := make([]any, len(columns))
		for i := range p {
			p[i] = &values[i]
		}
		if err = rows.Scan(p...); err != nil {
			return nil, err
		}
		r := Row{}
		for i, key := range columns {
			v := values[i]
			if b, ok := v.([]byte); ok {
				v = string(b)
			}
			r[key] = v
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
func One(db DBTX, q string, args ...any) (Row, error) {
	rows, err := All(db, q, args...)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}
func Insert(db DBTX, q string, args ...any) (int64, error) {
	r, err := db.Exec(q, args...)
	if err != nil {
		return 0, err
	}
	return r.LastInsertId()
}
func Int(v any) (int64, bool) {
	switch n := v.(type) {
	case json.Number:
		i, e := n.Int64()
		return i, e == nil
	case int64:
		return n, true
	case int:
		return int64(n), true
	case int32:
		return int64(n), true
	case float64:
		if !math.IsNaN(n) && !math.IsInf(n, 0) && n == math.Trunc(n) && n >= math.MinInt64 && n < math.MaxInt64 {
			return int64(n), true
		}
	}
	return 0, false
}
func Str(v any) string { s, _ := v.(string); return s }
func Fields(r Row, keys ...string) Row {
	out := Row{}
	for _, key := range keys {
		out[key] = r[key]
	}
	return out
}
func Revision(row Row, expected any) error {
	n, ok := Int(expected)
	if !ok || n < 1 {
		return Invalid("VALIDATION_ERROR", "expected_revision", "must be a positive integer")
	}
	current, _ := Int(row["revision"])
	if n != current {
		e := E(409, "Revision conflict", "REVISION_CONFLICT")
		e.CurrentRevision = &current
		return e
	}
	return nil
}
func PositiveID(value string) (int64, error) {
	if value == "" {
		return 0, E(422, "Invalid identifier", "")
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return 0, E(422, "Invalid identifier", "")
		}
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 1 {
		return 0, E(422, "Invalid identifier", "")
	}
	return n, nil
}
func ProjectIdentity(code string) (string, error) { return database.ProjectIdentity(code) }
func CanonicalJSON(v any) ([]byte, error) {
	// encoding/json sorts map keys; Python defaults use a space after ',' and ':'.
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	raw := legacyJSONUnicode(bytes.TrimSpace(b.Bytes()))
	out := make([]byte, 0, len(raw))
	quoted, escaped := false, false
	for _, ch := range raw {
		out = append(out, ch)
		if quoted {
			if escaped {
				escaped = false
			} else if ch == '\\' {
				escaped = true
			} else if ch == '"' {
				quoted = false
			}
		} else {
			if ch == '"' {
				quoted = true
			} else if ch == ',' || ch == ':' {
				out = append(out, ' ')
			}
		}
	}
	return out, nil
}
func RequestHash(v any) (string, error) {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		return "", err
	}
	hash := sha256.Sum256(legacyJSONUnicode(bytes.TrimSuffix(b.Bytes(), []byte{'\n'})))
	return hex.EncodeToString(hash[:]), nil
}

// Python ensure_ascii=False preserves these codepoints. Do not replace a
// literal backslash-u sequence, which encodes a different business payload.
func legacyJSONUnicode(raw []byte) []byte {
	out := make([]byte, 0, len(raw))
	for i := 0; i < len(raw); i++ {
		if raw[i] == '\\' && i+1 < len(raw) {
			if i+5 < len(raw) && (string(raw[i:i+6]) == `\u2028` || string(raw[i:i+6]) == `\u2029`) {
				if raw[i+5] == '8' {
					out = append(out, []byte("\u2028")...)
				} else {
					out = append(out, []byte("\u2029")...)
				}
				i += 5
				continue
			}
			out = append(out, raw[i], raw[i+1])
			i++
			continue
		}
		out = append(out, raw[i])
	}
	return out
}

var uuidPattern = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)

func IdempotencyKey(r *http.Request, required bool) (string, error) {
	key := r.Header.Get("Idempotency-Key")
	if key == "" && !required {
		return "", nil
	}
	if !uuidPattern.MatchString(key) {
		return "", Invalid("IDEMPOTENCY_KEY_INVALID", "Idempotency-Key", "must be a UUID")
	}
	return strings.ToLower(key), nil
}
func RestoreIdempotent(db DBTX, r *http.Request, key, hash string) (Row, error) {
	if key == "" {
		return nil, nil
	}
	row, err := One(db, "SELECT request_sha256,response_json FROM idempotency_requests WHERE scope=? AND idempotency_key=?", r.Method+":"+r.URL.Path, key)
	if err != nil || row == nil {
		return nil, err
	}
	if row["request_sha256"] != hash {
		e := E(409, "Idempotency key reused", "IDEMPOTENCY_KEY_REUSED")
		e.Headers = map[string]string{"X-Error-Code": "IDEMPOTENCY_KEY_REUSED"}
		return nil, e
	}
	var value Row
	dec := json.NewDecoder(strings.NewReader(Str(row["response_json"])))
	dec.UseNumber()
	err = dec.Decode(&value)
	return value, err
}
func SaveIdempotent(db DBTX, r *http.Request, key, hash string, response Row, status int, resource string, id int64, at string) error {
	if key == "" {
		return nil
	}
	body, err := CanonicalJSON(response)
	if err != nil {
		return err
	}
	_, err = db.Exec("INSERT INTO idempotency_requests(scope,idempotency_key,request_sha256,response_status,response_json,resource_type,resource_id,created_at) VALUES(?,?,?,?,?,?,?,?)", r.Method+":"+r.URL.Path, key, hash, status, string(body), resource, id, at)
	return err
}

var _ = fmt.Sprint
