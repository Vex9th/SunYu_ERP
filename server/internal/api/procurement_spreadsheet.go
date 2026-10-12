package api

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/xuri/excelize/v2"
	"golang.org/x/text/cases"
	"io"
	"math/big"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var pTemplateHeaders = []string{"序号", "大类", "名称", "规格", "品牌", "型号", "数量", "单位", "成本单价（元）", "报价单价（元）"}
var pQuoteHeaders = []string{"序号", "大类", "名称", "规格", "品牌", "型号", "数量", "单位", "报价单价（元）", "报价金额（元）"}

func pRegisterSpreadsheet(s *Server) {
	pHandle(s, "GET /api/procurement/import-template.xlsx", false, 200, func(c *Context) any {
		f := excelize.NewFile()
		defer f.Close()
		pCheck(f.SetSheetName("Sheet1", "采购清单"))
		pWriteRow(f, "采购清单", 1, pStringsAny(pTemplateHeaders))
		pCheck(f.SetPanes("采购清单", &excelize.Panes{Freeze: true, YSplit: 1, TopLeftCell: "A2", ActivePane: "bottomLeft"}))
		pCheck(f.AutoFilter("采购清单", "A1:J1", nil))
		style, e := f.NewStyle(&excelize.Style{Font: &excelize.Font{Color: "FFFFFF", Bold: true}, Fill: excelize.Fill{Type: "pattern", Color: []string{"1F4E78"}, Pattern: 1}, Alignment: &excelize.Alignment{Horizontal: "center"}})
		pCheck(e)
		pCheck(f.SetCellStyle("采购清单", "A1", "J1", style))
		for i, width := range []float64{8, 14, 20, 18, 14, 18, 12, 10, 18, 18} {
			col, e := excelize.ColumnNumberToName(i + 1)
			pCheck(e)
			pCheck(f.SetColWidth("采购清单", col, col, width))
		}
		return pSendWorkbook(c, f, "procurement-import-template.xlsx")
	})
	s.Handle("POST /api/projects/{project_code}/procurement-imports/preview", pPreviewImport)
	pHandle(s, "POST /api/projects/{project_code}/procurement-imports/{import_id}/confirm", true, 201, func(c *Context) any {
		r := pBody(c, "list_name expected_revision", "")
		n := Row{"list_name": pText(r["list_name"]), "expected_revision": pPositive(r["expected_revision"])}
		project := pProject(c, false)
		pCanonicalProject(c, project)
		id := pID(c, "import_id")
		return pIdem(c, n, func(key, hash, stored string) Row {
			pActive(project)
			row := pRequired(pOne(c.DB, "SELECT * FROM procurement_imports WHERE id=? AND project_id=?", id, project["id"]), "Procurement import not found")
			if row["status"] != "preview" {
				pConflict("Procurement import cannot be confirmed", "PROCUREMENT_IMPORT_NOT_CONFIRMABLE")
			}
			pRevision(row, n["expected_revision"])
			at := c.Timestamp()
			if Str(row["expires_at"]) <= at {
				pConflict("Procurement import expired", "PROCUREMENT_IMPORT_EXPIRED")
			}
			preview := pStoredPreview(row)
			if len(preview["errors"].([]any)) > 0 {
				pConflict("Procurement import has validation errors", "PROCUREMENT_IMPORT_HAS_ERRORS")
			}
			rows := preview["rows"].([]any)
			if len(rows) == 0 {
				pConflict("Procurement import is empty", "PROCUREMENT_IMPORT_EMPTY")
			}
			matches := pInventoryMatches(c.DB)
			list := pInsert(c.DB, pSQL("procurement_extensions", "confirm_procurement_import", 0), project["id"], n["list_name"], pDerivedKey(stored, "list"), hash, at, at)
			for i, raw := range rows {
				line := raw.(map[string]any)
				norm := pNormalizeLine(line)
				lineHash, e := RequestHash(line)
				pCheck(e)
				var item any
				if v, ok := matches[pMatchIdentity(norm)]; ok {
					item = v
				}
				pExec(c.DB, pSQL("procurement_extensions", "confirm_procurement_import", 2), list, item, norm["sequence_no"], norm["category"], norm["name"], norm["specification"], norm["brand"], norm["model"], norm["quantity_milli"], norm["unit"], norm["unit_cost_cents"], norm["quoted_unit_price_cents"], pDerivedKey(stored, fmt.Sprintf("line:%d", i+1)), lineHash, at, at)
			}
			pExec(c.DB, pSQL("procurement_extensions", "confirm_procurement_import", 1), list, at, id, n["expected_revision"])
			return Row{"import": pImportResponse(pOne(c.DB, "SELECT * FROM procurement_imports WHERE id=?", id), project["project_code"]), "procurement_list": pListDetail(c.DB, pList(c, list, project["id"], false), project["project_code"])}
		}, "procurement_import")
	})
	pHandle(s, "POST /api/projects/{project_code}/procurement-lists/{list_id}/quote-exports", true, 201, func(c *Context) any {
		r := pBody(c, "title customer_company_id notes", "")
		n := Row{"title": pText(r["title"]), "customer_company_id": pPositive(r["customer_company_id"]), "notes": pOptional(r["notes"])}
		p := pProject(c, false)
		pCanonicalProject(c, p)
		id := pID(c, "list_id")
		return pIdem(c, n, func(key, hash, stored string) Row {
			pActive(p)
			if pInt(p["company_id"]) != pInt(n["customer_company_id"]) {
				err := E(409, "Quote customer must match project customer", "PROJECT_CUSTOMER_MISMATCH")
				err.FieldErrors = Row{"customer_company_id": []string{"必须使用项目绑定的客户公司"}}
				err.Headers = map[string]string{"X-Error-Code": "PROJECT_CUSTOMER_MISMATCH"}
				pCheck(err)
			}
			list := pList(c, id, p["id"], false)
			if list["status"] != "confirmed" {
				pConflict("Only a confirmed procurement list can be quoted", "PROCUREMENT_LIST_NOT_QUOTABLE")
			}
			pRequired(pOne(c.DB, "SELECT id FROM companies WHERE id=?", n["customer_company_id"]), "Company not found")
			export := pInsert(c.DB, pSQL("procurement_extensions", "create_quote_export", 0), p["id"], id, n["title"], n["customer_company_id"], n["notes"], stored, hash, c.Timestamp())
			return pQuoteResponse(pOne(c.DB, pSQL("procurement_extensions", "_quote_row", 0), export, p["id"]), p["project_code"])
		}, "quote_export")
	})
	pHandle(s, "GET /api/projects/{project_code}/quote-exports", false, 200, func(c *Context) any {
		p := pProject(c, false)
		page, size := pPage(c)
		items := []Row{}
		for _, r := range pRows(c.DB, pSQL("procurement_extensions", "list_quote_exports", 0), p["id"], size, (page-1)*size) {
			items = append(items, pQuoteResponse(r, p["project_code"]))
		}
		return Row{"items": items, "page": page, "page_size": size, "total": pScalar(c.DB, pSQL("procurement_extensions", "list_quote_exports", 1), p["id"])}
	})
	pHandle(s, "GET /api/projects/{project_code}/quote-exports/{export_id}/download", false, 200, func(c *Context) any {
		p := pProject(c, false)
		r := pRequired(pOne(c.DB, pSQL("procurement_extensions", "_quote_row", 0), pID(c, "export_id"), p["id"]), "Quote export not found")
		f := excelize.NewFile()
		defer f.Close()
		pCheck(f.SetSheetName("Sheet1", "报价单"))
		pWriteRow(f, "报价单", 1, []any{"标题", r["title"]})
		pWriteRow(f, "报价单", 2, []any{"客户公司", r["customer_company_name"]})
		pWriteRow(f, "报价单", 3, []any{"备注", r["notes"]})
		pWriteRow(f, "报价单", 5, pStringsAny(pQuoteHeaders))
		for i, l := range pRows(c.DB, pSQL("procurement_extensions", "_quote_workbook", 0), r["procurement_list_id"]) {
			pWriteRow(f, "报价单", i+6, []any{l["sequence_no"], l["category"], l["name"], l["specification"], l["brand"], l["model"], procFormatQuantity(pInt(l["quantity_milli"])), l["unit"], pCentsText(pInt(l["quoted_unit_price_cents"])), pCentsText(pValue(pInt(l["quoted_unit_price_cents"]), pInt(l["quantity_milli"])))})
		}
		return pSendWorkbook(c, f, fmt.Sprintf("quote-export-%d.xlsx", pInt(r["id"])))
	})
}
func pPreviewImport(c *Context) (any, error) {
	c.Status = 201
	var filename string
	var content []byte
	_, e := pCatch(c, func(c *Context) any {
		pKey(c)
		var err error
		filename, content, err = pReadWorkbookUpload(c)
		pCheck(err)
		return nil
	})
	if e != nil {
		return nil, e
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(content))
	normalized := Row{"filename": filename, "sha256": digest}
	hash, e := RequestHash(normalized)
	if e != nil {
		return nil, e
	}
	key, e := IdempotencyKey(c.R, true)
	if e != nil {
		return nil, e
	}
	restored, e := c.Tx(func(c *Context) (any, error) {
		return pCatch(c, func(c *Context) any {
			project := pProject(c, false)
			pCanonicalProject(c, project)
			v, err := RestoreIdempotent(c.DB, c.R, key, hash)
			pCheck(err)
			if v != nil {
				return v
			}
			pActive(project)
			pRejectImport(c, project["id"], digest)
			return nil
		})
	})
	if e != nil || restored != nil {
		return restored, e
	}
	preview, e := pParseWorkbook(content)
	if e != nil {
		return nil, e
	}
	return c.Tx(func(c *Context) (any, error) {
		return pCatch(c, func(c *Context) any {
			project := pProject(c, false)
			pCanonicalProject(c, project)
			return pIdem(c, normalized, func(key, hash, stored string) Row {
				pActive(project)
				pRejectImport(c, project["id"], digest)
				at := c.Timestamp()
				t, e := time.Parse(time.RFC3339Nano, at)
				pCheck(e)
				expires := t.Add(24 * time.Hour).Format("2006-01-02T15:04:05.999999+00:00")
				body, e := CanonicalJSON(preview)
				pCheck(e)
				row := pOne(c.DB, pSQL("procurement_extensions", "preview_procurement_import", 1), project["id"], digest)
				if row != nil {
					if Str(row["expires_at"]) <= at {
						pExec(c.DB, pSQL("procurement_extensions", "preview_procurement_import", 2), filename, string(body), expires, at, row["id"])
						row = pOne(c.DB, "SELECT * FROM procurement_imports WHERE id=?", row["id"])
					}
				} else {
					id := pInsert(c.DB, pSQL("procurement_extensions", "preview_procurement_import", 0), project["id"], filename, digest, string(body), expires, at, at)
					row = pOne(c.DB, "SELECT * FROM procurement_imports WHERE id=?", id)
				}
				return pImportResponse(row, project["project_code"])
			}, "procurement_import")
		})
	})
}
func pKey(c *Context) string {
	values := c.R.Header.Values("Idempotency-Key")
	if len(values) != 1 || !uuidPattern.MatchString(values[0]) {
		pInvalid("Invalid Idempotency-Key")
	}
	return strings.ToLower(values[0])
}
func pDerivedKey(key, suffix string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(key+"\x00"+suffix)))
}
func pRejectImport(c *Context, project any, digest string) {
	if pOne(c.DB, pSQL("procurement_extensions", "_reject_confirmed_import", 0), project, digest) != nil {
		pConflict("Procurement import was already confirmed", "PROCUREMENT_IMPORT_ALREADY_CONFIRMED")
	}
}
func pStoredPreview(r Row) Row {
	var out Row
	decoder := json.NewDecoder(strings.NewReader(Str(r["preview_json"])))
	decoder.UseNumber()
	pCheck(decoder.Decode(&out))
	if len(out) != 2 {
		pCheck(fmt.Errorf("procurement import preview is invalid"))
	}
	for _, k := range []string{"rows", "errors"} {
		if _, ok := out[k].([]any); !ok {
			pCheck(fmt.Errorf("procurement import preview is invalid"))
		}
	}
	return out
}
func pImportResponse(r Row, code any) Row {
	out := pFields(r, "id filename sha256 status revision expires_at confirmed_list_id created_at updated_at")
	out["project_code"] = code
	preview := pStoredPreview(r)
	out["rows"] = preview["rows"]
	out["errors"] = preview["errors"]
	return out
}
func pQuoteResponse(r Row, code any) Row {
	out := pFields(r, "id procurement_list_id title customer_company_id customer_company_name notes created_at")
	out["project_code"] = code
	out["download_url"] = fmt.Sprintf("/api/projects/%s/quote-exports/%d/download", code, pInt(r["id"]))
	return out
}
func pMatchIdentity(r Row) string {
	values := []any{}
	for _, k := range []string{"brand", "name", "model", "specification", "unit"} {
		value := strings.TrimSpace(Str(r[k]))
		if value == "" {
			values = append(values, nil)
		} else {
			values = append(values, cases.Fold().String(value))
		}
	}
	v, e := json.Marshal(values)
	pCheck(e)
	return string(v)
}
func pInventoryMatches(db DBTX) map[string]int64 {
	out := map[string]int64{}
	ambiguous := map[string]bool{}
	for _, r := range pRows(db, pSQL("procurement_extensions", "_inventory_exact_matches", 0)) {
		identity := pMatchIdentity(r)
		if _, ok := out[identity]; ok {
			ambiguous[identity] = true
		} else {
			out[identity] = pInt(r["id"])
		}
	}
	for k := range ambiguous {
		delete(out, k)
	}
	return out
}
func pReadWorkbookUpload(c *Context) (string, []byte, error) {
	c.R.Body = http.MaxBytesReader(c.W, c.R.Body, 20*1024*1024+256*1024)
	err := c.R.ParseMultipartForm(1 << 20)
	if c.R.MultipartForm != nil {
		defer c.R.MultipartForm.RemoveAll()
	}
	if err != nil || c.R.MultipartForm == nil {
		return "", nil, E(422, "Invalid procurement import file", "VALIDATION_ERROR")
	}
	form := c.R.MultipartForm
	files := form.File["file"]
	if len(form.Value) != 0 || len(form.File) != 1 || len(files) != 1 || !strings.HasSuffix(strings.ToLower(files[0].Filename), ".xlsx") {
		return "", nil, E(422, "Invalid procurement import file", "VALIDATION_ERROR")
	}
	file, e := files[0].Open()
	if e != nil {
		return "", nil, e
	}
	defer file.Close()
	data, e := io.ReadAll(io.LimitReader(file, 20*1024*1024+1))
	if e != nil || len(data) == 0 || len(data) > 20*1024*1024 {
		return "", nil, E(422, "Invalid procurement import file", "VALIDATION_ERROR")
	}
	return files[0].Filename, data, nil
}
func pValidateXLSX(data []byte) error {
	z, e := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if e != nil {
		return E(422, "Invalid procurement import workbook", "VALIDATION_ERROR")
	}
	if len(z.File) == 0 || len(z.File) > 256 {
		return E(422, "Invalid procurement import workbook", "VALIDATION_ERROR")
	}
	seen := map[string]bool{}
	total := uint64(0)
	for _, f := range z.File {
		parts := strings.Split(strings.ReplaceAll(f.Name, "\\", "/"), "/")
		unsafe := false
		for _, part := range parts {
			if part == ".." {
				unsafe = true
			}
		}
		if unsafe || seen[f.Name] || strings.HasPrefix(f.Name, "/") || strings.HasPrefix(f.Name, "\\") || f.Flags&1 != 0 || (f.Method != zip.Store && f.Method != zip.Deflate) || f.UncompressedSize64 > 64*1024*1024 || f.UncompressedSize64 > 0 && (f.CompressedSize64 == 0 || f.UncompressedSize64 > f.CompressedSize64*200) {
			return E(422, "Invalid procurement import workbook", "VALIDATION_ERROR")
		}
		seen[f.Name] = true
		total += f.UncompressedSize64
		if total > 128*1024*1024 {
			return E(422, "Invalid procurement import workbook", "VALIDATION_ERROR")
		}
		r, e := f.Open()
		if e != nil {
			return E(422, "Invalid procurement import workbook", "VALIDATION_ERROR")
		}
		_, e = io.Copy(io.Discard, r)
		closeErr := r.Close()
		if e != nil || closeErr != nil {
			return E(422, "Invalid procurement import workbook", "VALIDATION_ERROR")
		}
	}
	return nil
}

var pSpreadsheetDecimal = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

func pSpreadsheetInteger(text string, multiplier int64) int64 {
	if !pSpreadsheetDecimal.MatchString(strings.TrimSpace(text)) {
		pInvalid("Invalid procurement import cell")
	}
	r, ok := new(big.Rat).SetString(strings.TrimSpace(text))
	if !ok {
		pInvalid("Invalid procurement import cell")
	}
	r.Mul(r, big.NewRat(multiplier, 1))
	if !r.IsInt() || !r.Num().IsInt64() {
		pInvalid("Invalid procurement import cell")
	}
	v := r.Num().Int64()
	if multiplier == 1 {
		return pPositive(v)
	}
	return pMoney(v)
}
func pSpreadsheetQuantity(text string) string {
	if !pSpreadsheetDecimal.MatchString(strings.TrimSpace(text)) {
		pInvalid("Invalid procurement import cell")
	}
	r, ok := new(big.Rat).SetString(strings.TrimSpace(text))
	if !ok {
		pInvalid("Invalid procurement import cell")
	}
	r.Mul(r, big.NewRat(1000, 1))
	if !r.IsInt() || !r.Num().IsInt64() {
		pInvalid("Invalid procurement import cell")
	}
	q := r.Num().Int64()
	if q <= 0 || q > 999999999999 {
		pInvalid("Invalid procurement import cell")
	}
	return procFormatQuantity(q)
}
func pStringsAny(values []string) []any {
	out := make([]any, len(values))
	for i, v := range values {
		out[i] = v
	}
	return out
}
func pWriteRow(f *excelize.File, sheet string, row int, values []any) {
	for i, v := range values {
		cell, e := excelize.CoordinatesToCellName(i+1, row)
		pCheck(e)
		pCheck(f.SetCellValue(sheet, cell, v))
	}
}
func pCentsText(v int64) string { return fmt.Sprintf("%d.%02d", v/100, v%100) }
func pSendWorkbook(c *Context, f *excelize.File, name string) any {
	for _, sheet := range f.GetSheetList() {
		rows, e := f.GetRows(sheet)
		pCheck(e)
		width := 1
		for _, r := range rows {
			if len(r) > width {
				width = len(r)
			}
		}
		if len(rows) > 0 {
			last, e := excelize.CoordinatesToCellName(width, len(rows))
			pCheck(e)
			pCheck(f.SetSheetDimension(sheet, "A1:"+last))
		}
	}
	b, e := f.WriteToBuffer()
	pCheck(e)
	c.W.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	c.W.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", name))
	c.W.WriteHeader(200)
	_, e = c.W.Write(b.Bytes())
	pCheck(e)
	c.Status = 0
	return nil
}
func pParseWorkbook(data []byte) (Row, error) {
	v, e := pCatch(nil, func(_ *Context) any {
		pCheck(pValidateXLSX(data))
		f, e := excelize.OpenReader(bytes.NewReader(data), excelize.Options{UnzipSizeLimit: 128 * 1024 * 1024, UnzipXMLSizeLimit: 64 * 1024 * 1024, RawCellValue: true})
		if e != nil {
			pInvalid("Invalid procurement import workbook")
		}
		defer f.Close()
		sheets := f.GetSheetList()
		if len(sheets) == 0 {
			pInvalid("Invalid procurement import workbook")
		}
		sheet := sheets[0]
		dimension, e := f.GetSheetDimension(sheet)
		pCheck(e)
		last := strings.Split(dimension, ":")
		col, row, e := excelize.CellNameToCoordinates(last[len(last)-1])
		if e != nil {
			pInvalid("Invalid procurement import workbook")
		}
		if row > 10001 {
			pInvalid("Procurement import exceeds 10000 rows")
		}
		if col > 10 {
			pInvalid("Invalid procurement import headers")
		}
		all, e := f.GetRows(sheet, excelize.Options{RawCellValue: true})
		if e != nil {
			pInvalid("Invalid procurement import workbook")
		}
		if len(all) == 0 || len(all[0]) != 10 {
			pInvalid("Invalid procurement import headers")
		}
		for i, h := range pTemplateHeaders {
			if all[0][i] != h {
				pInvalid("Invalid procurement import headers")
			}
		}
		if len(all) > 10001 {
			pInvalid("Procurement import exceeds 10000 rows")
		}
		rows, errors := []Row{}, []Row{}
		seenSequence := map[int64]bool{}
		seenRows := map[string]bool{}
		fields := []string{"sequence_no", "category", "name", "specification", "brand", "model", "quantity", "unit", "unit_cost_cents", "quoted_unit_price_cents"}
		for index, values := range all[1:] {
			rowNo := index + 2
			empty := true
			for _, v := range values {
				if v != "" {
					empty = false
				}
			}
			if empty {
				continue
			}
			normal := Row{}
			rowErrors := []Row{}
			for column, field := range fields {
				cell, _ := excelize.CoordinatesToCellName(column+1, rowNo)
				value := ""
				if column < len(values) {
					value = values[column]
				}
				formula, e := f.GetCellFormula(sheet, cell)
				typ, typeErr := f.GetCellType(sheet, cell)
				_, cellErr := pCatch(nil, func(_ *Context) any {
					if e != nil || typeErr != nil || formula != "" || typ == excelize.CellTypeBool || typ == excelize.CellTypeError || typ == excelize.CellTypeDate {
						pInvalid("Invalid procurement import cell")
					}
					textual := typ == excelize.CellTypeInlineString || typ == excelize.CellTypeSharedString
					switch field {
					case "sequence_no":
						normal[field] = pSpreadsheetInteger(value, 1)
					case "category", "name", "unit":
						if !textual {
							pInvalid("Invalid procurement import cell")
						}
						normal[field] = pText(value)
					case "specification", "brand", "model":
						if !textual && value != "" {
							pInvalid("Invalid procurement import cell")
						}
						normal[field] = pOptional(value)
					case "quantity":
						normal[field] = pSpreadsheetQuantity(value)
					default:
						normal[field] = pSpreadsheetInteger(value, 100)
					}
					return nil
				})
				if cellErr != nil {
					rowErrors = append(rowErrors, Row{"row": rowNo, "column": column + 1, "field": field, "message": "单元格格式无效"})
				}
			}
			if seq, ok := Int(normal["sequence_no"]); ok {
				if seenSequence[seq] {
					rowErrors = append(rowErrors, Row{"row": rowNo, "column": 1, "field": "sequence_no", "message": "序号重复"})
				} else {
					seenSequence[seq] = true
				}
			}
			if len(rowErrors) == 0 {
				fingerprint := Row{}
				for k, v := range normal {
					if k != "sequence_no" {
						fingerprint[k] = v
					}
				}
				hash, e := RequestHash(fingerprint)
				pCheck(e)
				if seenRows[hash] {
					rowErrors = append(rowErrors, Row{"row": rowNo, "column": 0, "field": "row", "message": "业务字段重复"})
				} else {
					seenRows[hash] = true
				}
			}
			if len(rowErrors) > 0 {
				errors = append(errors, rowErrors...)
			} else {
				rows = append(rows, normal)
			}
		}
		return Row{"rows": rows, "errors": errors}
	})
	if e != nil {
		return nil, e
	}
	return v.(Row), nil
}
