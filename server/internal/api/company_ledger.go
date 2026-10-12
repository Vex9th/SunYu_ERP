package api

import "math/big"

var businessSupplierAmounts = []string{"ordered_amount_cents", "paid_amount_cents", "unpaid_amount_cents", "invoiced_amount_cents", "uninvoiced_amount_cents"}
var businessCustomerAmounts = []string{"contracted_amount_cents", "allocated_received_amount_cents", "unreceived_amount_cents", "unallocated_received_amount_cents", "invoiced_amount_cents"}

func businessLineGross(unit, quantity, tax int64) (int64, error) {
	v := new(big.Int).Mul(big.NewInt(unit), big.NewInt(quantity))
	v.Add(v, big.NewInt(500))
	v.Quo(v, big.NewInt(1000))
	v.Add(v, big.NewInt(tax))
	if !v.IsInt64() || v.Sign() < 0 {
		return 0, businessInvalid("Invalid purchase order payload")
	}
	return v.Int64(), nil
}
func businessTotals(rows []Row, fields []string) Row {
	r := Row{}
	for _, f := range fields {
		r[f] = int64(0)
		for _, v := range rows {
			businessAdd(r, f, businessInt(v[f]))
		}
	}
	return r
}
func businessCompanyLedger(db DBTX, id int64) (Row, error) {
	supplier, e := businessSupplierLedger(db, id)
	if e != nil {
		return nil, e
	}
	customer, e := businessCustomerLedger(db, id)
	if e != nil {
		return nil, e
	}
	return Row{"company_id": id, "supplier": supplier, "customer": customer}, nil
}
func businessSupplierLedger(db DBTX, id int64) (Row, error) {
	rows, e := All(db, `SELECT o.id AS order_id,o.order_no,o.project_id,p.project_code,p.name AS project_name,o.ordered_on,o.status FROM purchase_orders o JOIN projects p ON p.id=o.project_id WHERE o.supplier_company_id=? AND o.status IN ('confirmed','partially_received','received') ORDER BY o.ordered_on DESC,o.id DESC`, id)
	if e != nil {
		return nil, e
	}
	orders := map[int64]Row{}
	projects := map[int64]bool{}
	for _, r := range rows {
		for _, f := range businessSupplierAmounts {
			r[f] = int64(0)
		}
		orders[businessInt(r["order_id"])] = r
		projects[businessInt(r["project_id"])] = true
	}
	lines, e := All(db, `SELECT l.purchase_order_id,l.unit_cost_cents,l.quantity_milli,l.tax_amount_cents FROM purchase_order_lines l JOIN purchase_orders o ON o.id=l.purchase_order_id WHERE o.supplier_company_id=? AND o.status IN ('confirmed','partially_received','received')`, id)
	if e != nil {
		return nil, e
	}
	for _, l := range lines {
		amount, err := businessLineGross(businessInt(l["unit_cost_cents"]), businessInt(l["quantity_milli"]), businessInt(l["tax_amount_cents"]))
		if err != nil {
			return nil, err
		}
		businessAdd(orders[businessInt(l["purchase_order_id"])], "ordered_amount_cents", amount)
	}
	for _, fact := range []struct{ table, key string }{{"supplier_payments", "paid_amount_cents"}, {"supplier_invoices", "invoiced_amount_cents"}} {
		facts, e := All(db, "SELECT f.purchase_order_id,f.amount_cents FROM "+fact.table+" f JOIN purchase_orders o ON o.id=f.purchase_order_id WHERE o.supplier_company_id=? AND o.status IN ('confirmed','partially_received','received') AND f.status='active'", id)
		if e != nil {
			return nil, e
		}
		for _, r := range facts {
			businessAdd(orders[businessInt(r["purchase_order_id"])], fact.key, businessInt(r["amount_cents"]))
		}
	}
	for _, r := range rows {
		r["unpaid_amount_cents"] = businessMax(businessInt(r["ordered_amount_cents"]) - businessInt(r["paid_amount_cents"]))
		r["uninvoiced_amount_cents"] = businessMax(businessInt(r["ordered_amount_cents"]) - businessInt(r["invoiced_amount_cents"]))
	}
	summary := businessTotals(rows, businessSupplierAmounts)
	summary["project_count"] = len(projects)
	summary["order_count"] = len(rows)
	return Row{"summary": summary, "orders": rows}, nil
}
func businessCustomerLedger(db DBTX, id int64) (Row, error) {
	rows, e := All(db, `SELECT p.id AS project_id,p.project_code,p.name AS project_name FROM projects p WHERE p.company_id=? OR EXISTS (SELECT 1 FROM contract_project_allocations a JOIN contracts c ON c.id=a.contract_id WHERE a.project_id=p.id AND c.customer_company_id=? AND (c.status IN ('signed','completed') OR(c.status='terminated' AND EXISTS(SELECT 1 FROM receipts r WHERE r.contract_allocation_id=a.id AND r.project_id=a.project_id AND r.status='active')))) ORDER BY p.project_code COLLATE NOCASE,p.id`, id, id)
	if e != nil {
		return nil, e
	}
	projects := map[int64]Row{}
	for _, r := range rows {
		for _, f := range businessCustomerAmounts {
			r[f] = int64(0)
		}
		r["contracts"] = []Row{}
		projects[businessInt(r["project_id"])] = r
	}
	allocations, e := All(db, `SELECT a.id AS allocation_id,a.project_id,a.amount_cents AS allocated_amount_cents,c.id AS contract_id,c.contract_no,c.title,c.status,c.signed_on FROM contract_project_allocations a JOIN contracts c ON c.id=a.contract_id WHERE c.customer_company_id=? AND c.status IN ('signed','completed','terminated') ORDER BY c.signed_on DESC,c.id DESC,a.id`, id)
	if e != nil {
		return nil, e
	}
	receipts, e := All(db, `SELECT r.contract_allocation_id,r.amount_cents FROM receipts r JOIN contract_project_allocations a ON a.id=r.contract_allocation_id AND a.project_id=r.project_id JOIN contracts c ON c.id=a.contract_id WHERE c.customer_company_id=? AND c.status IN ('signed','completed','terminated') AND r.status='active'`, id)
	if e != nil {
		return nil, e
	}
	received := map[int64]int64{}
	for _, r := range receipts {
		received[businessInt(r["contract_allocation_id"])] += businessInt(r["amount_cents"])
	}
	contracts := map[int64]bool{}
	for _, a := range allocations {
		paid := received[businessInt(a["allocation_id"])]
		terminated := a["status"] == "terminated"
		if terminated && paid == 0 {
			continue
		}
		r := projects[businessInt(a["project_id"])]
		owed := int64(0)
		if !terminated {
			owed = businessMax(businessInt(a["allocated_amount_cents"]) - paid)
			businessAdd(r, "contracted_amount_cents", businessInt(a["allocated_amount_cents"]))
		}
		v := Fields(a, "allocation_id", "contract_id", "contract_no", "title", "status", "signed_on", "allocated_amount_cents")
		v["received_amount_cents"] = paid
		v["unreceived_amount_cents"] = owed
		r["contracts"] = append(r["contracts"].([]Row), v)
		businessAdd(r, "allocated_received_amount_cents", paid)
		businessAdd(r, "unreceived_amount_cents", owed)
		contracts[businessInt(a["contract_id"])] = true
	}
	unallocated, e := All(db, `SELECT r.project_id,r.amount_cents FROM receipts r JOIN projects p ON p.id=r.project_id WHERE p.company_id=? AND r.status='active' AND r.contract_allocation_id IS NULL`, id)
	if e != nil {
		return nil, e
	}
	for _, r := range unallocated {
		businessAdd(projects[businessInt(r["project_id"])], "unallocated_received_amount_cents", businessInt(r["amount_cents"]))
	}
	invoices, e := All(db, `SELECT i.project_id,i.amount_cents FROM project_invoices i JOIN projects p ON p.id=i.project_id WHERE p.company_id=? AND i.status='recorded'`, id)
	if e != nil {
		return nil, e
	}
	for _, r := range invoices {
		businessAdd(projects[businessInt(r["project_id"])], "invoiced_amount_cents", businessInt(r["amount_cents"]))
	}
	summary := businessTotals(rows, businessCustomerAmounts)
	summary["project_count"] = len(rows)
	summary["contract_count"] = len(contracts)
	return Row{"summary": summary, "projects": rows}, nil
}
