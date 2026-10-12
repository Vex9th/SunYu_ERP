package api

import "fmt"

const pLineFields = "sequence_no category name specification brand model quantity unit unit_cost_cents quoted_unit_price_cents"

func RegisterProcurement(s *Server) {
	pRegisterLists(s)
	pRegisterOrders(s)
	pRegisterExtensions(s)
	pRegisterInventory(s)
	pRegisterSpreadsheet(s)
	pHandle(s, "GET /api/projects/{project_code}/procurement-options", false, 200, func(c *Context) any {
		project := pProject(c, false)
		lists := pRows(c.DB, pSQL("procurement", "get_procurement_options", 0), project["id"])
		lines := []Row{}
		for _, r := range pRows(c.DB, pSQL("procurement", "_project_line_quantities", 0), project["id"], project["id"], 0) {
			v := pFields(r, "id procurement_list_id name model unit unit_cost_cents")
			v["quantity"] = procFormatQuantity(pInt(r["quantity_milli"]))
			v["ordered_quantity"] = procFormatQuantity(pInt(r["ordered_quantity_milli"]))
			lines = append(lines, v)
		}
		return Row{"lists": lists, "lines": lines}
	})
	pHandle(s, "GET /api/projects/{project_code}/procurement-overview", false, 200, func(c *Context) any {
		project := pProject(c, false)
		rows := pRows(c.DB, pSQL("procurement", "_project_line_quantities", 0), project["id"], project["id"], 1)
		counts := Row{"not_ordered": int64(0), "partial": int64(0), "ordered": int64(0), "over_ordered": int64(0)}
		for _, r := range rows {
			k := pQuantityStatus(pInt(r["ordered_quantity_milli"]), pInt(r["quantity_milli"]), "not_ordered", "ordered", "over_ordered")
			counts[k] = pInt(counts[k]) + 1
		}
		committed := int64(0)
		for _, r := range pRows(c.DB, pSQL("procurement", "get_procurement_overview", 0), project["id"]) {
			committed = pAdd(committed, pGross(r))
		}
		out := Row{"project_code": project["project_code"], "line_count": len(rows), "line_status_counts": counts, "procurement_committed_cents": committed}
		for i, k := range []string{"procurement_received_cents", "procurement_paid_cents", "procurement_invoiced_cents", "material_consumed_cents"} {
			out[k] = pScalar(c.DB, pSQL("procurement", "get_procurement_overview", i+1), project["id"])
		}
		return out
	})
}
func pRegisterLists(s *Server) {
	const base = "/api/projects/{project_code}/procurement-lists"
	pHandle(s, "GET "+base, false, 200, func(c *Context) any {
		p := pProject(c, false)
		page, size := pPage(c)
		rows := pRows(c.DB, pSQL("procurement", "list_procurement_lists", 0), p["id"], size, (page-1)*size)
		out := []Row{}
		for _, r := range rows {
			out = append(out, pListSummary(r, c.R.PathValue("project_code")))
		}
		return Row{"items": out, "total": pScalar(c.DB, pSQL("procurement", "list_procurement_lists", 1), p["id"]), "page": page, "page_size": size}
	})
	pHandle(s, "POST "+base, true, 201, func(c *Context) any {
		r := pBody(c, "name notes", "")
		n := Row{"name": pText(r["name"]), "notes": pOptional(r["notes"])}
		return pIdem(c, n, func(key, hash, stored string) Row {
			p := pProject(c, true)
			at := c.Timestamp()
			id := pInsert(c.DB, pSQL("procurement", "create_procurement_list", 0), p["id"], n["name"], n["notes"], stored, hash, at, at)
			return pListDetail(c.DB, pList(c, id, p["id"], false), p["project_code"])
		}, "procurement_list")
	})
	pHandle(s, "GET "+base+"/{list_id}", false, 200, func(c *Context) any {
		p := pProject(c, false)
		return pListDetail(c.DB, pList(c, pID(c, "list_id"), p["id"], false), p["project_code"])
	})
	pHandle(s, "PUT "+base+"/{list_id}", true, 200, func(c *Context) any {
		r := pBody(c, "name notes expected_revision", "")
		name, notes := pText(r["name"]), pOptional(r["notes"])
		id := pID(c, "list_id")
		p := pProject(c, true)
		list := pList(c, id, p["id"], true)
		pRevision(list, r["expected_revision"])
		pExec(c.DB, pSQL("procurement", "update_procurement_list", 0), name, notes, c.Timestamp(), id, r["expected_revision"])
		return pListDetail(c.DB, pList(c, id, p["id"], false), p["project_code"])
	})
	s.Handle("POST "+base+"/{list_id}/lines", func(c *Context) (any, error) {
		c.Status = 201
		v, e := c.Tx(func(c *Context) (any, error) {
			return pCatch(c, func(c *Context) any {
				n := pNormalizeLine(pBody(c, pLineFields, ""))
				id := pID(c, "list_id")
				return pIdem(c, n, func(key, hash, stored string) Row {
					p := pProject(c, true)
					pList(c, id, p["id"], true)
					at := c.Timestamp()
					line := pInsert(c.DB, pSQL("procurement", "create_procurement_line", 0), id, n["sequence_no"], n["category"], n["name"], n["specification"], n["brand"], n["model"], n["quantity_milli"], n["unit"], n["unit_cost_cents"], n["quoted_unit_price_cents"], stored, hash, at, at)
					pExec(c.DB, pSQL("procurement", "create_procurement_line", 1), at, id)
					return pLineResponse(c.DB, pOne(c.DB, "SELECT * FROM procurement_lines WHERE id=?", line), pList(c, id, p["id"], false)["revision"])
				}, "procurement_line")
			})
		})
		return v, pUnique(e, "Procurement sequence already exists", "PROCUREMENT_SEQUENCE_EXISTS")
	})
	s.Handle("PUT "+base+"/{list_id}/lines/{line_id}", func(c *Context) (any, error) {
		v, e := c.Tx(func(c *Context) (any, error) {
			return pCatch(c, func(c *Context) any {
				r := pBody(c, pLineFields+" expected_revision", "")
				rev := pPositive(r["expected_revision"])
				delete(r, "expected_revision")
				n := pNormalizeLine(r)
				listID, lineID := pID(c, "list_id"), pID(c, "line_id")
				p := pProject(c, true)
				pList(c, listID, p["id"], true)
				row := pRequired(pOne(c.DB, "SELECT * FROM procurement_lines WHERE id=? AND procurement_list_id=?", lineID, listID), "Procurement line not found")
				pRevision(row, rev)
				var item any
				if pSameIdentity(row, n) {
					item = row["inventory_item_id"]
				}
				at := c.Timestamp()
				pExec(c.DB, pSQL("procurement", "update_procurement_line", 0), item, n["sequence_no"], n["category"], n["name"], n["specification"], n["brand"], n["model"], n["quantity_milli"], n["unit"], n["unit_cost_cents"], n["quoted_unit_price_cents"], at, lineID, rev)
				pExec(c.DB, pSQL("procurement", "update_procurement_line", 1), at, listID)
				return pLineResponse(c.DB, pOne(c.DB, "SELECT * FROM procurement_lines WHERE id=?", lineID), pList(c, listID, p["id"], false)["revision"])
			})
		})
		return v, pUnique(e, "Procurement sequence already exists", "PROCUREMENT_SEQUENCE_EXISTS")
	})
	pHandle(s, "DELETE "+base+"/{list_id}/lines/{line_id}", true, 204, func(c *Context) any {
		p := pProject(c, true)
		id := pID(c, "list_id")
		pList(c, id, p["id"], true)
		if pExec(c.DB, pSQL("procurement", "delete_procurement_line", 0), pID(c, "line_id"), id) != 1 {
			pCheck(E(404, "Procurement line not found", "RESOURCE_NOT_FOUND"))
		}
		pExec(c.DB, pSQL("procurement", "delete_procurement_line", 1), c.Timestamp(), id)
		return nil
	})
	pHandle(s, "POST "+base+"/{list_id}/confirm", true, 200, func(c *Context) any {
		n := pBody(c, "expected_revision", "")
		n["expected_revision"] = pPositive(n["expected_revision"])
		id := pID(c, "list_id")
		return pIdem(c, n, func(key, hash, stored string) Row {
			p := pProject(c, true)
			r := pList(c, id, p["id"], false)
			if r["confirm_idempotency_key"] == key {
				pSameHash(r["confirm_request_hash"], hash)
				return pListDetail(c.DB, r, p["project_code"])
			}
			if r["status"] != "draft" {
				pConflict("Procurement list is not editable", "PROCUREMENT_LIST_NOT_EDITABLE")
			}
			pRevision(r, n["expected_revision"])
			if len(pListLines(c.DB, id)) == 0 {
				pConflict("Procurement list has no lines", "PROCUREMENT_LIST_EMPTY")
			}
			at := c.Timestamp()
			pExec(c.DB, pSQL("procurement", "confirm_procurement_list", 0), at, stored, hash, at, id)
			return pListDetail(c.DB, pList(c, id, p["id"], false), p["project_code"])
		}, "procurement_list")
	})
	pHandle(s, "POST "+base+"/{list_id}/copy-as-draft", true, 201, func(c *Context) any {
		n := pBody(c, "expected_revision", "")
		n["expected_revision"] = pPositive(n["expected_revision"])
		p := pProject(c, false)
		pCanonicalProject(c, p)
		id := pID(c, "list_id")
		return pIdem(c, n, func(key, hash, stored string) Row {
			pActive(p)
			source := pList(c, id, p["id"], false)
			if source["status"] != "confirmed" {
				pConflict("Only confirmed procurement lists can be copied", "PROCUREMENT_LIST_NOT_CONFIRMED")
			}
			pRevision(source, n["expected_revision"])
			at := c.Timestamp()
			copyID := pInsert(c.DB, pSQL("procurement", "copy_procurement_list_as_draft", 0), p["id"], Str(source["name"])+"（修订草稿）", source["notes"], stored, hash, at, at)
			for _, l := range pListLines(c.DB, id) {
				pExec(c.DB, pSQL("procurement", "copy_procurement_list_as_draft", 1), copyID, l["inventory_item_id"], l["sequence_no"], l["category"], l["name"], l["specification"], l["brand"], l["model"], l["quantity_milli"], l["unit"], l["unit_cost_cents"], l["quoted_unit_price_cents"], fmt.Sprintf("%s:line:%d", stored, pInt(l["id"])), hash, at, at)
			}
			return pListDetail(c.DB, pList(c, copyID, p["id"], false), p["project_code"])
		}, "procurement_list")
	})
}
