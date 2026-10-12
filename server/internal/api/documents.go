package api

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"golang.org/x/text/cases"
)

const docSummarySQL = `SELECT documents.id,documents.project_code,documents.category,documents.logical_name AS title,documents.notes,COALESCE((SELECT MAX(version_number) FROM document_versions WHERE document_id=documents.id),0) AS latest_version_number,documents.archived_at,documents.revision,documents.created_at,documents.updated_at FROM documents`
const docVersionsSQL = `SELECT id,version_number,original_filename,managed_filename,content_type,size_bytes,sha256,notes,created_at FROM document_versions`

func docInvalid(field, message string) *APIError {
	e := Invalid("INVALID_DOCUMENT_PAYLOAD", field, message)
	e.Detail = "Invalid document payload"
	return e
}
func docText(v any, field string, required bool) (any, error) {
	if v == nil && !required {
		return nil, nil
	}
	s, ok := v.(string)
	if !ok {
		return nil, docInvalid(field, "must be text")
	}
	s = strings.TrimSpace(s)
	if s == "" {
		if required {
			return nil, docInvalid(field, "must not be blank")
		}
		return nil, nil
	}
	if strings.ContainsRune(s, 0) || !utf8.ValidString(s) {
		return nil, docInvalid(field, "contains invalid characters")
	}
	return s, nil
}
func docProject(c *Context, active bool) (Row, error) {
	key, err := ProjectIdentity(c.R.PathValue("project_code"))
	if err != nil {
		return nil, docInvalid("project_code", "is invalid")
	}
	row, err := One(c.DB, "SELECT id,project_code,status FROM projects WHERE project_code_key=?", key)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, E(404, "Project not found", "PROJECT_NOT_FOUND")
	}
	if active && row["status"] != "active" {
		return nil, E(409, "Project is archived", "PROJECT_ARCHIVED")
	}
	return row, nil
}
func docRecord(c *Context, project string, id int64, editable bool) (Row, error) {
	row, err := One(c.DB, docSummarySQL+" WHERE documents.id=? AND documents.project_code=? COLLATE NOCASE", id, project)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, E(404, "Document not found", "DOCUMENT_NOT_FOUND")
	}
	if editable && row["archived_at"] != nil {
		return nil, E(409, "Document is archived", "DOCUMENT_ARCHIVED")
	}
	return row, nil
}
func docDetail(c *Context, project string, id int64) (Row, error) {
	row, err := docRecord(c, project, id, false)
	if err != nil {
		return nil, err
	}
	versions, err := All(c.DB, docVersionsSQL+" WHERE document_id=? ORDER BY version_number,id", id)
	if err != nil {
		return nil, err
	}
	row["versions"] = versions
	return row, nil
}
func docScope(c *Context, project, suffix, key string) (*http.Request, string) {
	r := c.R.Clone(c.R.Context())
	u := *r.URL
	r.URL = &u
	r.URL.Path = "/api/projects/" + project + "/" + suffix
	hash := sha256.Sum256([]byte(r.Method + ":" + r.URL.Path + "\x00" + key))
	return r, hex.EncodeToString(hash[:])
}
func documentID(value, field string) (int64, error) {
	id, err := PositiveID(value)
	if err != nil {
		return 0, docInvalid(field, "must be a positive integer")
	}
	return id, nil
}
func docIdempotencyKey(r *http.Request) (string, error) {
	values := r.Header.Values("Idempotency-Key")
	if len(values) != 1 {
		return "", docInvalid("Idempotency-Key", "must occur once")
	}
	key, err := uuid.Parse(values[0])
	if err != nil {
		return "", docInvalid("Idempotency-Key", "must be a UUID")
	}
	return key.String(), nil
}
func docPositiveRevision(value any) (int64, error) {
	if text, ok := value.(string); ok {
		return documentID(text, "expected_revision")
	}
	n, ok := Int(value)
	if !ok || n < 1 {
		return 0, docInvalid("expected_revision", "must be a positive integer")
	}
	return n, nil
}
func docHandler(h Handler) Handler {
	return func(c *Context) (any, error) {
		value, err := h(c)
		if err == nil {
			return value, nil
		}
		var ae *APIError
		if errors.As(err, &ae) {
			if ae.Code == "REVISION_CONFLICT" {
				ae.Detail = "Resource was modified"
			}
			if ae.Status == 413 {
				ae = E(413, "Document file is too large", "DOCUMENT_FILE_TOO_LARGE")
				ae.FieldErrors = Row{"file": []string{fmt.Sprintf("must not exceed %d MB", c.S.Config.MaxDocumentUploadMB)}}
			}
			return nil, ae
		}
		log.Printf("Document operation failed: %v", err)
		return nil, E(500, "Document operation failed", "DOCUMENT_OPERATION_FAILED")
	}
}
func RegisterDocuments(s *Server) {
	handle := func(pattern string, h Handler) {
		if strings.HasPrefix(pattern, "GET ") && !strings.HasSuffix(pattern, "/download") {
			read := h
			h = func(c *Context) (any, error) { return c.ReadTx(read) }
		}
		s.Handle(pattern, docHandler(h))
	}
	handle("GET /api/projects/{project_code}/documents", docList)
	handle("GET /api/projects/{project_code}/document-version-options", docOptions)
	handle("POST /api/projects/{project_code}/documents", docCreate)
	handle("GET /api/projects/{project_code}/documents/{document_id}", func(c *Context) (any, error) {
		id, e := documentID(c.R.PathValue("document_id"), "document_id")
		if e != nil {
			return nil, e
		}
		p, e := docProject(c, false)
		if e != nil {
			return nil, e
		}
		return docDetail(c, Str(p["project_code"]), id)
	})
	handle("PUT /api/projects/{project_code}/documents/{document_id}", docUpdate)
	handle("POST /api/projects/{project_code}/documents/{document_id}/versions", docAddVersion)
	handle("POST /api/projects/{project_code}/documents/{document_id}/archive", docArchive)
	handle("GET /api/projects/{project_code}/documents/{document_id}/versions/{version_id}/download", docDownload)
	handle("GET /api/projects/{project_code}/document-versions/{version_id}/download", docDownload)
}
func docReadForm(c *Context, creating bool) (Row, Attachment, error) {
	limit := int64(c.S.Config.MaxDocumentUploadMB) * 1024 * 1024
	c.R.Body = http.MaxBytesReader(c.W, c.R.Body, limit+1024*1024)
	reader, err := c.R.MultipartReader()
	if err != nil {
		return nil, Attachment{}, docInvalid("body", "must be valid multipart data")
	}
	fields := Row{}
	seen := map[string]bool{}
	var attachment Attachment
	success := false
	defer func() {
		if !success && attachment.Path != "" {
			_ = attachment.Close()
		}
	}()
	for {
		part, e := reader.NextPart()
		if e == io.EOF {
			break
		}
		if e != nil {
			return nil, attachment, docInvalid("body", "must be valid multipart data")
		}
		name := part.FormName()
		if seen[name] {
			part.Close()
			return nil, attachment, docInvalid("body", "has duplicate multipart fields")
		}
		seen[name] = true
		allowed := name == "file" || name == "notes" || (creating && (name == "category" || name == "title")) || (!creating && name == "expected_revision")
		if !allowed {
			part.Close()
			return nil, attachment, docInvalid("body", "has invalid multipart fields")
		}
		if name == "file" {
			if part.FileName() == "" {
				part.Close()
				return nil, attachment, docInvalid(name, "must be a file")
			}
			attachment, e = stageAttachment(c.S.Config.DataDir, part, part.FileName(), part.Header.Get("Content-Type"), limit)
			part.Close()
			if e != nil {
				return nil, attachment, e
			}
		} else {
			if part.FileName() != "" {
				part.Close()
				return nil, attachment, docInvalid(name, "must be text")
			}
			data, e := io.ReadAll(io.LimitReader(part, (1<<20)+1))
			part.Close()
			if e != nil || len(data) > 1<<20 {
				return nil, attachment, docInvalid(name, "must be text")
			}
			fields[name] = string(data)
		}
	}
	if !seen["file"] || creating && (!seen["category"] || !seen["title"]) || !creating && !seen["expected_revision"] {
		return nil, attachment, docInvalid("body", "has invalid multipart fields")
	}
	notes, err := docText(fields["notes"], "notes", false)
	if err != nil {
		return nil, attachment, err
	}
	fields["notes"] = notes
	if creating {
		if _, ok := categoryNames[Str(fields["category"])]; !ok {
			return nil, attachment, Invalid("INVALID_DOCUMENT_CATEGORY", "category", "must be a supported category")
		}
		title, e := docText(fields["title"], "title", true)
		if e != nil {
			return nil, attachment, e
		}
		fields["title"] = title
	} else {
		revision, e := PositiveID(Str(fields["expected_revision"]))
		if e != nil {
			return nil, attachment, docInvalid("expected_revision", "must be a positive integer")
		}
		fields["expected_revision"] = revision
	}
	success = true
	return fields, attachment, nil
}
func docCreate(c *Context) (any, error) {
	key, err := docIdempotencyKey(c.R)
	if err != nil {
		return nil, err
	}
	payload, a, err := docReadForm(c, true)
	if err != nil {
		return nil, err
	}
	defer a.Close()
	fingerprint := Row{"category": payload["category"], "title": payload["title"], "notes": payload["notes"], "filename": a.OriginalFilename, "content_type": a.ContentType, "size_bytes": a.SizeBytes, "sha256": a.SHA256}
	hash, err := RequestHash(fingerprint)
	if err != nil {
		return nil, err
	}
	return c.Tx(func(tx *Context) (any, error) {
		p, e := docProject(tx, false)
		if e != nil {
			return nil, e
		}
		project := Str(p["project_code"])
		r, storedKey := docScope(tx, project, "documents", key)
		cached, e := RestoreIdempotent(tx.DB, r, storedKey, hash)
		tx.Status = 201
		if e != nil || cached != nil {
			return cached, e
		}
		if p["status"] != "active" {
			return nil, E(409, "Project is archived", "PROJECT_ARCHIVED")
		}
		at := tx.Timestamp()
		id, e := Insert(tx.DB, "INSERT INTO documents(project_code,category,logical_name,notes,revision,created_at,updated_at) VALUES(?,?,?,?,1,?,?)", project, payload["category"], payload["title"], payload["notes"], at, at)
		if e != nil {
			return nil, docConflict(e)
		}
		date := tx.S.Now().In(time.FixedZone("Asia/Shanghai", 8*3600)).Format("20060102")
		managed := DocumentManagedFilename(project, Str(payload["category"]), Str(payload["title"]), date, 1, a.OriginalFilename)
		if _, e = publishAttachmentVersion(tx, a, project, Str(payload["category"]), id, 1, managed, payload["notes"], at); e != nil {
			return nil, e
		}
		result, e := docDetail(tx, project, id)
		if e != nil {
			return nil, e
		}
		e = SaveIdempotent(tx.DB, r, storedKey, hash, result, 201, "document", id, at)
		return result, e
	})
}
func docConflict(err error) error {
	if strings.Contains(err.Error(), "UNIQUE constraint failed: documents.") {
		return E(409, "Document title already exists", "DOCUMENT_TITLE_EXISTS")
	}
	return err
}
func docUpdate(c *Context) (any, error) {
	id, err := documentID(c.R.PathValue("document_id"), "document_id")
	if err != nil {
		return nil, err
	}
	body, err := c.Body()
	if err != nil {
		return nil, err
	}
	if len(body) != 3 {
		return nil, docInvalid("body", "has invalid fields")
	}
	for _, key := range []string{"title", "notes", "expected_revision"} {
		if _, ok := body[key]; !ok {
			return nil, docInvalid("body", "has invalid fields")
		}
	}
	title, err := docText(body["title"], "title", true)
	if err != nil {
		return nil, err
	}
	notes, err := docText(body["notes"], "notes", false)
	if err != nil {
		return nil, err
	}
	body["expected_revision"], err = docPositiveRevision(body["expected_revision"])
	if err != nil {
		return nil, err
	}
	return c.Tx(func(tx *Context) (any, error) {
		p, e := docProject(tx, true)
		if e != nil {
			return nil, e
		}
		project := Str(p["project_code"])
		row, e := docRecord(tx, project, id, true)
		if e != nil {
			return nil, e
		}
		if e = Revision(row, body["expected_revision"]); e != nil {
			return nil, e
		}
		if _, e = tx.DB.Exec("UPDATE documents SET logical_name=?,notes=?,revision=revision+1,updated_at=? WHERE id=?", title, notes, tx.Timestamp(), id); e != nil {
			return nil, docConflict(e)
		}
		return docDetail(tx, project, id)
	})
}
func docAddVersion(c *Context) (any, error) {
	id, err := documentID(c.R.PathValue("document_id"), "document_id")
	if err != nil {
		return nil, err
	}
	key, err := docIdempotencyKey(c.R)
	if err != nil {
		return nil, err
	}
	body, a, err := docReadForm(c, false)
	if err != nil {
		return nil, err
	}
	defer a.Close()
	hash, err := RequestHash(Row{"notes": body["notes"], "expected_revision": body["expected_revision"], "filename": a.OriginalFilename, "content_type": a.ContentType, "size_bytes": a.SizeBytes, "sha256": a.SHA256})
	if err != nil {
		return nil, err
	}
	return c.Tx(func(tx *Context) (any, error) {
		p, e := docProject(tx, false)
		if e != nil {
			return nil, e
		}
		project := Str(p["project_code"])
		r, storedKey := docScope(tx, project, fmt.Sprintf("documents/%d/versions", id), key)
		cached, e := RestoreIdempotent(tx.DB, r, storedKey, hash)
		tx.Status = 201
		if e != nil || cached != nil {
			return cached, e
		}
		if p["status"] != "active" {
			return nil, E(409, "Project is archived", "PROJECT_ARCHIVED")
		}
		row, e := docRecord(tx, project, id, true)
		if e != nil {
			return nil, e
		}
		if e = Revision(row, body["expected_revision"]); e != nil {
			return nil, e
		}
		version, _ := Int(row["latest_version_number"])
		version++
		date := tx.S.Now().In(time.FixedZone("Asia/Shanghai", 8*3600)).Format("20060102")
		managed := DocumentManagedFilename(project, Str(row["category"]), Str(row["title"]), date, version, a.OriginalFilename)
		at := tx.Timestamp()
		vid, e := publishAttachmentVersion(tx, a, project, Str(row["category"]), id, version, managed, body["notes"], at)
		if e != nil {
			return nil, e
		}
		if _, e = tx.DB.Exec("UPDATE documents SET revision=revision+1,updated_at=? WHERE id=?", at, id); e != nil {
			return nil, e
		}
		result, e := One(tx.DB, docVersionsSQL+" WHERE id=?", vid)
		if e != nil {
			return nil, e
		}
		e = SaveIdempotent(tx.DB, r, storedKey, hash, result, 201, "document_version", vid, at)
		return result, e
	})
}
func docArchive(c *Context) (any, error) {
	id, err := documentID(c.R.PathValue("document_id"), "document_id")
	if err != nil {
		return nil, err
	}
	key, err := docIdempotencyKey(c.R)
	if err != nil {
		return nil, err
	}
	body, err := c.Body()
	if err != nil {
		return nil, err
	}
	if len(body) != 2 || body["expected_revision"] == nil {
		return nil, docInvalid("body", "has invalid fields")
	}
	reason, err := docText(body["reason"], "reason", true)
	if err != nil {
		return nil, err
	}
	body["reason"] = reason
	body["expected_revision"], err = docPositiveRevision(body["expected_revision"])
	if err != nil {
		return nil, err
	}
	hash, err := RequestHash(body)
	if err != nil {
		return nil, err
	}
	return c.Tx(func(tx *Context) (any, error) {
		p, e := docProject(tx, false)
		if e != nil {
			return nil, e
		}
		project := Str(p["project_code"])
		r, storedKey := docScope(tx, project, fmt.Sprintf("documents/%d/archive", id), key)
		cached, e := RestoreIdempotent(tx.DB, r, storedKey, hash)
		if e != nil || cached != nil {
			return cached, e
		}
		if p["status"] != "active" {
			return nil, E(409, "Project is archived", "PROJECT_ARCHIVED")
		}
		row, e := docRecord(tx, project, id, true)
		if e != nil {
			return nil, e
		}
		if e = Revision(row, body["expected_revision"]); e != nil {
			return nil, e
		}
		at := tx.Timestamp()
		if _, e = tx.DB.Exec("UPDATE documents SET archive_reason=?,archived_at=?,revision=revision+1,updated_at=? WHERE id=?", reason, at, at, id); e != nil {
			return nil, e
		}
		result, e := docDetail(tx, project, id)
		if e != nil {
			return nil, e
		}
		e = SaveIdempotent(tx.DB, r, storedKey, hash, result, 200, "document", id, at)
		return result, e
	})
}
func docList(c *Context) (any, error) {
	p, err := docProject(c, false)
	if err != nil {
		return nil, err
	}
	project := Str(p["project_code"])
	values := c.R.URL.Query()
	get := func(key, def string) (string, error) {
		v, ok := values[key]
		if !ok {
			return def, nil
		}
		if len(v) != 1 {
			return "", docInvalid(key, "must occur once")
		}
		return v[0], nil
	}
	category, err := get("category", "")
	if err != nil {
		return nil, err
	}
	if category != "" {
		if _, ok := categoryNames[category]; !ok {
			return nil, Invalid("INVALID_DOCUMENT_CATEGORY", "category", "must be a supported category")
		}
	}
	archived, err := get("archived", "active")
	if err != nil {
		return nil, err
	}
	if archived != "active" && archived != "archived" && archived != "all" {
		return nil, docInvalid("archived", "must be active, archived, or all")
	}
	pageText, err := get("page", "1")
	if err != nil {
		return nil, err
	}
	page, err := PositiveID(pageText)
	if err != nil {
		return nil, docInvalid("page", "must be a positive integer")
	}
	sizeText, err := get("page_size", "50")
	if err != nil {
		return nil, err
	}
	size, err := PositiveID(sizeText)
	if err != nil || size > 200 {
		return nil, docInvalid("page_size", "is out of range")
	}
	if page-1 > (1<<63-1)/size {
		return nil, docInvalid("page", "is out of range")
	}
	search, err := get("search", "")
	if err != nil {
		return nil, err
	}
	search = strings.TrimSpace(search)
	if len([]rune(search)) > 200 {
		return nil, docInvalid("search", "must not exceed 200 characters")
	}
	for _, r := range search {
		if unicode.IsControl(r) {
			return nil, docInvalid("search", "contains invalid characters")
		}
	}
	where := " WHERE documents.project_code=? COLLATE NOCASE"
	args := []any{project}
	if category != "" {
		where += " AND documents.category=?"
		args = append(args, category)
	}
	if archived == "active" {
		where += " AND documents.archived_at IS NULL"
	} else if archived == "archived" {
		where += " AND documents.archived_at IS NOT NULL"
	}
	rows, err := All(c.DB, docSummarySQL+where+" ORDER BY documents.created_at DESC,documents.id DESC", args...)
	if err != nil {
		return nil, err
	}
	if search != "" {
		filtered := []Row{}
		for _, row := range rows {
			match, excerpt, e := docSearch(c, row, search)
			if e != nil {
				return nil, e
			}
			if match {
				row["search_excerpt"] = excerpt
				filtered = append(filtered, row)
			}
		}
		rows = filtered
	}
	total := int64(len(rows))
	start := (page - 1) * size
	if start > total {
		start = total
	}
	end := start + size
	if end > total {
		end = total
	}
	return Row{"items": rows[start:end], "total": total, "page": page, "page_size": size}, nil
}
func docOptions(c *Context) (any, error) {
	p, e := docProject(c, false)
	if e != nil {
		return nil, e
	}
	rows, e := All(c.DB, "SELECT v.id,v.version_number,v.original_filename,v.managed_filename,d.logical_name AS title FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE d.project_code=? COLLATE NOCASE AND d.archived_at IS NULL ORDER BY d.created_at DESC,d.id DESC,v.version_number DESC,v.id DESC", p["project_code"])
	if e != nil {
		return nil, e
	}
	out := []Row{}
	for _, r := range rows {
		name := strings.TrimSpace(Str(r["managed_filename"]))
		original := Str(r["original_filename"])
		if name == "" {
			name = original
		}
		if name != original {
			name += "（原文件名：" + original + "）"
		}
		out = append(out, Row{"value": r["id"], "label": fmt.Sprintf("%s V%v · %s", r["title"], r["version_number"], name)})
	}
	return out, nil
}
func openDocumentFile(dataDir, project, category string, id int64, stored string, size int64) (*os.File, error) {
	failure := func() error { return E(404, "Document file not found", "DOCUMENT_FILE_NOT_FOUND") }
	stored = strings.ReplaceAll(stored, "\\", "/")
	parts := strings.Split(stored, "/")
	if len(parts) != 5 || parts[0] != "Projects" || parts[1] != project || parts[2] != category || parts[3] != fmt.Sprint(id) || parts[4] == "" || parts[4] == "." || parts[4] == ".." {
		return nil, failure()
	}
	root, err := os.OpenRoot(dataDir)
	if err != nil {
		return nil, failure()
	}
	defer root.Close()
	prefix := ""
	for _, part := range parts {
		prefix = filepath.Join(prefix, part)
		info, e := root.Lstat(prefix)
		if e != nil || info.Mode()&os.ModeSymlink != 0 {
			return nil, failure()
		}
	}
	file, err := root.Open(filepath.FromSlash(stored))
	if err != nil {
		return nil, failure()
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != size {
		file.Close()
		return nil, failure()
	}
	return file, nil
}
func docDownload(c *Context) (any, error) {
	p, err := docProject(c, false)
	if err != nil {
		return nil, err
	}
	id, err := documentID(c.R.PathValue("version_id"), "version_id")
	if err != nil {
		return nil, err
	}
	q := "SELECT v.document_id,v.managed_filename,v.original_filename,v.content_type,v.stored_relative_path,v.size_bytes,d.category FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE d.project_code=? COLLATE NOCASE AND v.id=?"
	args := []any{p["project_code"], id}
	if did := c.R.PathValue("document_id"); did != "" {
		documentID, e := documentID(did, "document_id")
		if e != nil {
			return nil, e
		}
		q += " AND d.id=?"
		args = append(args, documentID)
	}
	row, err := One(c.DB, q, args...)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, E(404, "Document version not found", "DOCUMENT_VERSION_NOT_FOUND")
	}
	did, _ := Int(row["document_id"])
	size, _ := Int(row["size_bytes"])
	f, err := openDocumentFile(c.S.Config.DataDir, Str(p["project_code"]), Str(row["category"]), did, Str(row["stored_relative_path"]), size)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	name := Str(row["managed_filename"])
	if name == "" {
		name = Str(row["original_filename"])
	}
	fallback := strings.Map(func(r rune) rune {
		if r > 127 || r == '"' || r == '\\' || unicode.IsControl(r) {
			return '_'
		}
		return r
	}, name)
	c.W.Header().Set("Content-Disposition", `attachment; filename="`+fallback+`"; filename*=UTF-8''`+strings.ReplaceAll(url.QueryEscape(name), "+", "%20"))
	c.W.Header().Set("Content-Type", normalizeContentType(Str(row["content_type"])))
	c.W.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	c.Status = 0
	_, err = io.Copy(c.W, f)
	return nil, err
}
func docSearch(c *Context, row Row, search string) (bool, any, error) {
	fold := cases.Fold()
	needle := fold.String(search)
	contains := func(v any) bool { return strings.Contains(fold.String(Str(v)), needle) }
	matched := contains(row["title"])
	var excerpt any
	if !matched && contains(row["notes"]) {
		matched = true
		excerpt = docExcerpt(Str(row["notes"]), search)
	}
	versions, err := All(c.DB, "SELECT * FROM document_versions WHERE document_id=? ORDER BY version_number DESC,id DESC", row["id"])
	if err != nil {
		return false, nil, err
	}
	for _, v := range versions {
		if !matched {
			for _, pair := range [][2]string{{"managed_filename", "文件："}, {"original_filename", "原文件名："}, {"notes", "版本说明："}} {
				if contains(v[pair[0]]) {
					matched = true
					excerpt = pair[1] + docExcerpt(Str(v[pair[0]]), search)
					break
				}
			}
		}
		size, _ := Int(v["size_bytes"])
		if row["category"] == "planning_minutes" && v["content_type"] == "text/plain" && size <= 5*1024*1024 {
			id, _ := Int(row["id"])
			f, e := openDocumentFile(c.S.Config.DataDir, Str(row["project_code"]), "planning_minutes", id, Str(v["stored_relative_path"]), size)
			if e == nil {
				data, e := io.ReadAll(io.LimitReader(f, 5*1024*1024))
				f.Close()
				if e == nil {
					content := strings.ToValidUTF8(string(data), "�")
					if contains(content) {
						return true, docExcerpt(content, search), nil
					}
				}
			}
		}
	}
	return matched, excerpt, nil
}
func docExcerpt(value, search string) string {
	normalized := strings.Join(strings.Fields(value), " ")
	runes := []rune(normalized)
	fold := cases.Fold()
	folded := fold.String(normalized)
	position := strings.Index(folded, fold.String(search))
	if position < 0 {
		if len(runes) > 120 {
			return string(runes[:120])
		}
		return normalized
	}
	// Full case folding can expand a character (for example ß -> ss). Map the
	// folded byte offset back to the original text before slicing the excerpt.
	pos, matchEnd, offset := 0, len(runes), 0
	widths := make(map[rune]int)
	foldedEnd := position + len(fold.String(search))
	for i, r := range runes {
		width, ok := widths[r]
		if !ok {
			width = len(fold.String(string(r)))
			widths[r] = width
		}
		if offset <= position {
			pos = i
		}
		offset += width
		if offset >= foldedEnd {
			matchEnd = i + 1
			break
		}
	}
	start := pos - 36
	if start < 0 {
		start = 0
	}
	end := matchEnd + 64
	if end > len(runes) {
		end = len(runes)
	}
	prefix, suffix := "", ""
	if start > 0 {
		prefix = "…"
	}
	if end < len(runes) {
		suffix = "…"
	}
	return prefix + string(runes[start:end]) + suffix
}
