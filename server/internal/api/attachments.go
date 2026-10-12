package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

type Attachment struct {
	OriginalFilename, ContentType, SHA256, Path string
	SizeBytes                                   int64
	stage                                       *attachmentStage
}
type attachmentStage struct {
	root *os.Root
	name string
	info os.FileInfo
	once sync.Once
	err  error
}

func (a Attachment) Close() error {
	if a.stage == nil {
		return nil
	}
	s := a.stage
	s.once.Do(func() {
		defer s.root.Close()
		actual, e := s.root.Lstat(s.name)
		if os.IsNotExist(e) {
			return
		}
		if e != nil {
			s.err = e
			return
		}
		if !os.SameFile(actual, s.info) {
			s.err = errors.New("staged upload was replaced")
			return
		}
		s.err = s.root.Remove(s.name)
	})
	return s.err
}

type AttachmentBatch struct{ Attachments []Attachment }
type ManagedDocument struct{ Title, ManagedFilename string }

var categoryNames = map[string]string{"planning_minutes": "项目纪要", "site_survey": "现场勘察", "quotation": "项目报价", "technical_agreement": "技术协议", "contract": "项目合同", "mechanical_design": "机械设计", "electrical_design": "电气设计", "procurement_list": "采购清单", "procurement_contract": "采购合同", "mechanical_signoff": "机械会签", "electrical_signoff": "电气会签", "construction": "施工资料", "commissioning": "调试资料", "acceptance": "验收资料", "invoice": "项目发票", "warranty": "质保资料", "after_sales": "售后资料", "other": "其他资料"}

func normalizeUploadName(name string) (string, error) {
	name = strings.TrimSpace(filepath.Base(strings.ReplaceAll(name, "\\", "/")))
	if name == "" || name == "." || name == ".." || !utf8.ValidString(name) {
		return "", errors.New("invalid upload filename")
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", errors.New("invalid upload filename")
		}
	}
	return name, nil
}
func normalizeContentType(value string) string {
	if value == "" || len(value) > 255 {
		return "application/octet-stream"
	}
	for _, r := range value {
		if r < 32 || r > 126 {
			return "application/octet-stream"
		}
	}
	return value
}
func ReadAttachmentBody(c *Context, code string) (payload Row, batch *AttachmentBatch, err error) {
	batch = &AttachmentBatch{Attachments: []Attachment{}}
	media, _, _ := mime.ParseMediaType(c.R.Header.Get("Content-Type"))
	if media != "multipart/form-data" {
		payload, err = c.Body()
		return
	}
	limit := int64(c.S.Config.MaxDocumentUploadMB) * 1024 * 1024
	c.R.Body = http.MaxBytesReader(c.W, c.R.Body, limit+1024*1024)
	reader, e := c.R.MultipartReader()
	if e != nil {
		return nil, batch, Invalid(code, "body", "must be valid multipart data")
	}
	defer func() {
		if err != nil {
			_ = batch.Close()
		}
	}()
	total := int64(0)
	seen := false
	for {
		part, e := reader.NextPart()
		if e == io.EOF {
			break
		}
		if e != nil {
			var oversized *http.MaxBytesError
			if errors.As(e, &oversized) {
				return nil, batch, attachmentTooLarge(limit, true)
			}
			return nil, batch, Invalid(code, "body", "must be valid multipart data")
		}
		field := part.FormName()
		if field == "payload" && part.FileName() == "" && !seen {
			seen = true
			data, e := io.ReadAll(io.LimitReader(part, (1<<20)+1))
			_ = part.Close()
			if e != nil || len(data) > 1<<20 || !validJSONUnicode(data) {
				return nil, batch, Invalid(code, "payload", "must be valid JSON")
			}
			dec := json.NewDecoder(strings.NewReader(string(data)))
			dec.UseNumber()
			if dec.Decode(&payload) != nil || payload == nil {
				return nil, batch, Invalid(code, "payload", "must be a JSON object")
			}
			var extra any
			if dec.Decode(&extra) != io.EOF {
				return nil, batch, Invalid(code, "payload", "must be valid JSON")
			}
			continue
		}
		if field != "files" || part.FileName() == "" {
			part.Close()
			return nil, batch, Invalid(code, "body", "has invalid multipart fields")
		}
		if len(batch.Attachments) >= 20 {
			part.Close()
			return nil, batch, attachmentTooLarge(limit, true)
		}
		a, e := stageAttachment(c.S.Config.DataDir, part, part.FileName(), part.Header.Get("Content-Type"), limit)
		_ = part.Close()
		if e != nil {
			return nil, batch, e
		}
		batch.Attachments = append(batch.Attachments, a)
		total += a.SizeBytes
		if total > limit {
			return nil, batch, attachmentTooLarge(limit, true)
		}
		if a.SizeBytes == 0 {
			return nil, batch, Invalid(code, "files", "must not contain empty files")
		}
	}
	if !seen {
		return nil, batch, Invalid(code, "payload", "must occur once as text")
	}
	return payload, batch, nil
}
func attachmentTooLarge(limit int64, batch bool) *APIError {
	e := E(413, "Document file is too large", "DOCUMENT_FILE_TOO_LARGE")
	message := fmt.Sprintf("must not exceed %d MB", limit/(1024*1024))
	if batch {
		e = E(413, "Document attachment batch is too large", "DOCUMENT_BATCH_TOO_LARGE")
		message = fmt.Sprintf("must contain at most 20 files whose combined size does not exceed %d MB", limit/(1024*1024))
	}
	e.FieldErrors = Row{"files": []string{message}}
	return e
}
func stageAttachment(dataDir string, reader io.Reader, name, contentType string, limit int64) (Attachment, error) {
	name, err := normalizeUploadName(name)
	if err != nil {
		return Attachment{}, Invalid("INVALID_ATTACHMENT", "files", err.Error())
	}
	root, err := os.OpenRoot(dataDir)
	if err != nil {
		return Attachment{}, err
	}
	defer root.Close()
	if err = root.Mkdir("Temp", 0700); err != nil && !os.IsExist(err) {
		return Attachment{}, err
	}
	if info, e := root.Lstat("Temp"); e != nil || info.Mode()&os.ModeSymlink != 0 {
		return Attachment{}, errors.New("upload directory is a symlink")
	}
	stageRoot, err := root.OpenRoot("Temp")
	if err != nil {
		return Attachment{}, err
	}
	stageName := ".upload-" + rand.Text() + ".tmp"
	file, err := stageRoot.OpenFile(stageName, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		stageRoot.Close()
		return Attachment{}, err
	}
	keep := false
	defer func() {
		_ = file.Close()
		if !keep {
			_ = stageRoot.Remove(stageName)
			_ = stageRoot.Close()
		}
	}()
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(reader, limit+1))
	if err != nil {
		var oversized *http.MaxBytesError
		if errors.As(err, &oversized) {
			return Attachment{}, attachmentTooLarge(limit, true)
		}
		return Attachment{}, err
	}
	if n > limit {
		return Attachment{}, attachmentTooLarge(limit, false)
	}
	if err = file.Sync(); err != nil {
		return Attachment{}, err
	}
	info, err := file.Stat()
	if err != nil {
		return Attachment{}, err
	}
	if err = file.Close(); err != nil {
		return Attachment{}, err
	}
	keep = true
	return Attachment{OriginalFilename: name, ContentType: normalizeContentType(contentType), SHA256: hex.EncodeToString(hash.Sum(nil)), Path: filepath.Join(dataDir, "Temp", stageName), SizeBytes: n, stage: &attachmentStage{root: stageRoot, name: stageName, info: info}}, nil
}
func (b *AttachmentBatch) HashPayload(payload Row) Row {
	if len(b.Attachments) == 0 {
		return payload
	}
	files := []Row{}
	for _, a := range b.Attachments {
		files = append(files, Row{"original_filename": a.OriginalFilename, "content_type": a.ContentType, "size_bytes": a.SizeBytes, "sha256": a.SHA256})
	}
	return Row{"payload": payload, "files": files}
}
func (b *AttachmentBatch) Close() error {
	var problems []error
	for _, a := range b.Attachments {
		if err := a.Close(); err != nil && !os.IsNotExist(err) {
			problems = append(problems, err)
		}
	}
	return errors.Join(problems...)
}
func (b *AttachmentBatch) Publish(c *Context, projectCode, category string, documents []ManagedDocument, notes any, at string) ([]int64, error) {
	if len(documents) != len(b.Attachments) {
		return nil, errors.New("document and attachment counts differ")
	}
	out := []int64{}
	for i, a := range b.Attachments {
		id, err := Insert(c.DB, "INSERT INTO documents(project_code,category,logical_name,notes,revision,created_at,updated_at) VALUES(?,?,?,?,1,?,?)", projectCode, category, documents[i].Title, notes, at, at)
		if err != nil {
			return nil, err
		}
		vid, err := publishAttachmentVersion(c, a, projectCode, category, id, 1, documents[i].ManagedFilename, notes, at)
		if err != nil {
			return nil, err
		}
		out = append(out, vid)
	}
	return out, nil
}
func publishAttachmentVersion(c *Context, a Attachment, project, category string, documentID, version int64, managedName string, notes any, at string) (int64, error) {
	if c.rollbackCallbacks == nil {
		return 0, errors.New("publishing attachment requires transaction")
	}
	if _, err := ProjectIdentity(project); err != nil {
		return 0, err
	}
	if _, ok := categoryNames[category]; !ok {
		return 0, errors.New("invalid document category")
	}
	managedName = sanitizeFilename(managedName, "")
	relative := filepath.Join("Projects", project, category, fmt.Sprint(documentID), managedName)
	root, err := os.OpenRoot(c.S.Config.DataDir)
	if err != nil {
		return 0, err
	}
	defer root.Close()
	prefix := ""
	for _, part := range strings.Split(filepath.Dir(relative), string(filepath.Separator)) {
		prefix = filepath.Join(prefix, part)
		if err = root.Mkdir(prefix, 0700); err != nil && !os.IsExist(err) {
			return 0, err
		}
		info, e := root.Lstat(prefix)
		if e != nil {
			return 0, e
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return 0, errors.New("document path contains a symlink")
		}
	}
	if err = reconcileDocumentFiles(c, root, filepath.Dir(relative), documentID); err != nil {
		return 0, err
	}
	var source *os.File
	if a.stage != nil {
		source, err = a.stage.root.Open(a.stage.name)
	} else {
		source, err = os.Open(a.Path)
	}
	if err != nil {
		return 0, err
	}
	defer source.Close()
	dest, err := root.OpenFile(relative, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return 0, err
	}
	hash := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(dest, hash), source)
	syncErr := dest.Sync()
	info, _ := dest.Stat()
	closeErr := dest.Close()
	cleanup := func() {
		r, e := os.OpenRoot(c.S.Config.DataDir)
		if e != nil {
			log.Printf("attachment rollback: %v", e)
			return
		}
		defer r.Close()
		actual, e := r.Lstat(relative)
		if e == nil && info != nil && os.SameFile(info, actual) {
			if e = r.Remove(relative); e != nil {
				log.Printf("attachment rollback: %v", e)
			}
		}
	}
	*c.rollbackCallbacks = append(*c.rollbackCallbacks, cleanup)
	if err = errors.Join(copyErr, syncErr, closeErr); err != nil {
		return 0, err
	}
	if n != a.SizeBytes || hex.EncodeToString(hash.Sum(nil)) != a.SHA256 {
		return 0, errors.New("staged attachment changed")
	}
	return Insert(c.DB, "INSERT INTO document_versions(document_id,version_number,original_filename,managed_filename,content_type,stored_relative_path,size_bytes,sha256,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", documentID, version, a.OriginalFilename, managedName, a.ContentType, relative, a.SizeBytes, a.SHA256, notes, at)
}

var documentReservation = regexp.MustCompile(`^\.version-[0-9]{12}\.reserve$`)

// The database writer lock excludes concurrent publication into this directory.
// Only a document's own unreferenced regular files are crash residue.
func reconcileDocumentFiles(c *Context, root *os.Root, directory string, documentID int64) error {
	if c.rollbackCallbacks == nil {
		return errors.New("document reconciliation requires a transaction")
	}
	rows, err := All(c.DB, "SELECT stored_relative_path FROM document_versions WHERE document_id=?", documentID)
	if err != nil {
		return err
	}
	referenced := map[string]bool{}
	for _, row := range rows {
		stored := filepath.FromSlash(strings.ReplaceAll(Str(row["stored_relative_path"]), "\\", "/"))
		if filepath.Dir(stored) != directory || filepath.Base(stored) == "." || filepath.Base(stored) == ".." {
			return errors.New("document reference is outside its directory")
		}
		referenced[filepath.Base(stored)] = true
	}
	bound, err := root.OpenRoot(directory)
	if err != nil {
		return err
	}
	defer bound.Close()
	dir, err := bound.Open(".")
	if err != nil {
		return err
	}
	names, err := dir.Readdirnames(-1)
	dir.Close()
	if err != nil {
		return err
	}
	for _, name := range names {
		if referenced[name] || (strings.HasPrefix(name, ".") && !documentReservation.MatchString(name)) {
			continue
		}
		info, e := bound.Lstat(name)
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() {
			continue
		}
		if e = bound.Remove(name); e != nil && !os.IsNotExist(e) {
			return e
		}
	}
	return nil
}
func CompactISODate(value string) string {
	t, e := time.Parse("2006-01-02", value)
	if e == nil && t.Format("2006-01-02") == value {
		return t.Format("20060102")
	}
	return value
}
func ManagedFilename(parts []any, original string, preserve int) string {
	s := make([]string, len(parts))
	for i, p := range parts {
		s[i] = fmt.Sprint(p)
	}
	tail := ""
	if preserve > 0 && len(parts) > 0 {
		if preserve > len(parts) {
			preserve = len(parts)
		}
		tail = "_" + strings.Join(s[len(s)-preserve:], "_")
	}
	return sanitizeFilename(strings.Join(s, "_")+filepath.Ext(original), tail)
}
func DocumentManagedFilename(project, category, title, businessDate string, version int64, original string) string {
	name := categoryNames[category]
	if name == "" {
		name = category
	}
	return ManagedFilename([]any{project, name, title, businessDate, fmt.Sprintf("V%d", version)}, original, 2)
}
func sanitizeFilename(name, tail string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune("<>:\"/\\|?*", r) {
			return '_'
		}
		return r
	}, name)
	name = strings.TrimRight(name, ". ")
	if name == "" {
		name = "unnamed"
	}
	base := strings.ToUpper(strings.SplitN(name, ".", 2)[0])
	reserved := base == "CON" || base == "PRN" || base == "AUX" || base == "NUL"
	if len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '1' && base[3] <= '9' {
		reserved = true
	}
	if reserved {
		name = "_" + name
	}
	if len(name) <= 120 {
		return name
	}
	suffix := filepath.Ext(name)
	if len(suffix) >= 60 {
		suffix = ""
	}
	stem := strings.TrimSuffix(name, suffix)
	if !strings.HasSuffix(stem, tail) {
		tail = ""
	}
	marker := ""
	if tail != "" {
		sum := sha256.Sum256([]byte(name))
		marker = "_" + hex.EncodeToString(sum[:])[:10]
	}
	if len(marker+tail+suffix) >= 120 {
		tail = ""
		marker = ""
	}
	prefix := strings.TrimSuffix(stem, tail)
	limit := 120 - len(marker+tail+suffix)
	for len(prefix) > limit {
		_, n := utf8.DecodeLastRuneInString(prefix)
		prefix = prefix[:len(prefix)-n]
	}
	return prefix + marker + tail + suffix
}
