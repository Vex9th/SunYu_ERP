package api

import (
	"math"
	"strings"
	"time"
)

const dlSignoffFields = "status confirmed_on not_required_reason notes document_version_ids expected_revision"
const dlCommissionFields = "started_at ended_at status summary issues next_action notes document_version_ids"
const dlChangeFields = "source title description reason contract_delta_cents estimated_cost_delta_cents schedule_delta_days proposed_on notes document_version_ids"
const dlInvoiceFields = "invoice_type status requested_on recorded_on invoice_number amount_cents counterparty_name notes document_version_ids"
const dlAfterFields = "reported_on service_on reason contact_name contact_phone coverage_type notes"
const dlAcceptanceFields = "performed_on result notes document_version_ids warranty expected_revision"
const dlCommissionStates = "planned|in_progress|blocked|completed|cancelled"
const dlChangeStates = "proposed|approved|rejected|implemented|cancelled"
const dlInvoiceTypes = "contract_payment|additional_work|warranty_service|other"
const dlAfterStates = "open|in_progress|completed|cancelled"

func dlExpected(r, p Row, code string, nullable bool) {
	if r["expected_revision"] == nil && nullable {
		p["expected_revision"] = nil
	} else {
		p["expected_revision"] = dInteger(r["expected_revision"], "expected_revision", code, 1)
	}
}
func dlSignoffPayload(r Row) Row {
	code := "INVALID_SIGNOFF_PAYLOAD"
	p := Row{"status": dEnum(r["status"], "status", code, "pending|confirmed|not_required"), "confirmed_on": dDate(r["confirmed_on"], "confirmed_on", code, true), "not_required_reason": dText(r["not_required_reason"], "not_required_reason", code, false), "notes": dText(r["notes"], "notes", code, false), "document_version_ids": dIDs(r["document_version_ids"], code)}
	switch p["status"] {
	case "pending":
		if p["confirmed_on"] != nil || p["not_required_reason"] != nil {
			dInvalid(code, "status", "does not match fields")
		}
	case "confirmed":
		if p["confirmed_on"] == nil || p["not_required_reason"] != nil {
			dInvalid(code, "status", "does not match fields")
		}
	case "not_required":
		if p["confirmed_on"] != nil || p["not_required_reason"] == nil {
			dInvalid(code, "status", "does not match fields")
		}
	}
	dlExpected(r, p, code, true)
	return p
}
func dlCommissionPayload(r Row, update bool) Row {
	code := "INVALID_COMMISSIONING_PAYLOAD"
	p := Row{"started_at": dDatetime(r["started_at"], "started_at", code, false), "ended_at": dDatetime(r["ended_at"], "ended_at", code, true), "status": dEnum(r["status"], "status", code, dlCommissionStates), "document_version_ids": dIDs(r["document_version_ids"], code)}
	if p["ended_at"] != nil && Str(p["ended_at"]) < Str(p["started_at"]) {
		dInvalid(code, "ended_at", "must not be before started_at")
	}
	if (p["status"] == "completed" || p["status"] == "cancelled") && p["ended_at"] == nil {
		dInvalid(code, "ended_at", "is required for a closed session")
	}
	for _, f := range strings.Fields("summary issues next_action notes") {
		p[f] = dText(r[f], f, code, false)
	}
	if update {
		dlExpected(r, p, code, false)
	}
	return p
}
func dlChangePayload(r Row, update bool) Row {
	code := "INVALID_CHANGE_PAYLOAD"
	p := Row{"source": dEnum(r["source"], "source", code, "commissioning|customer_request|site_condition|technical_agreement|other"), "proposed_on": dDate(r["proposed_on"], "proposed_on", code, false), "document_version_ids": dIDs(r["document_version_ids"], code)}
	for _, f := range []string{"title", "description", "reason", "notes"} {
		p[f] = dText(r[f], f, code, f == "title" || f == "description")
	}
	for _, f := range []string{"contract_delta_cents", "estimated_cost_delta_cents", "schedule_delta_days"} {
		p[f] = dInteger(r[f], f, code, -math.MaxInt64)
	}
	if update {
		dlExpected(r, p, code, false)
	}
	return p
}
func dlWarrantyPayload(v any, code string, revision bool) Row {
	r, ok := v.(map[string]any)
	if !ok {
		dInvalid(code, "warranty", "has invalid fields")
	}
	fields := "starts_on duration_months renewal_price_cents notes"
	if revision {
		fields += " expected_revision"
	}
	dExact(r, fields, code)
	months := dInteger(r["duration_months"], "duration_months", code, 1)
	if months > 240 {
		dInvalid(code, "duration_months", "must not exceed 240")
	}
	var renewal any
	if r["renewal_price_cents"] != nil {
		renewal = dInteger(r["renewal_price_cents"], "renewal_price_cents", code, 0)
	}
	p := Row{"starts_on": dDate(r["starts_on"], "starts_on", code, false), "duration_months": months, "renewal_price_cents": renewal, "notes": dText(r["notes"], "notes", code, false)}
	if revision {
		dlExpected(r, p, code, true)
	}
	return p
}
func dlInvoicePayload(r Row, update bool) Row {
	code := "INVALID_INVOICE_PAYLOAD"
	p := Row{"invoice_type": dEnum(r["invoice_type"], "invoice_type", code, dlInvoiceTypes), "status": dEnum(r["status"], "status", code, "planned|requested|recorded"), "requested_on": dDate(r["requested_on"], "requested_on", code, true), "recorded_on": dDate(r["recorded_on"], "recorded_on", code, true), "invoice_number": dText(r["invoice_number"], "invoice_number", code, false), "amount_cents": nil, "counterparty_name": dText(r["counterparty_name"], "counterparty_name", code, false), "notes": dText(r["notes"], "notes", code, false), "document_version_ids": dIDs(r["document_version_ids"], code)}
	if r["amount_cents"] != nil {
		p["amount_cents"] = dInteger(r["amount_cents"], "amount_cents", code, 0)
	}
	if (p["status"] == "requested" || p["status"] == "recorded") && p["requested_on"] == nil {
		dInvalid(code, "requested_on", "is required")
	}
	if p["status"] == "recorded" && (p["recorded_on"] == nil || p["invoice_number"] == nil || p["amount_cents"] == nil) {
		dInvalid(code, "status", "recorded invoice requires date, number and amount")
	}
	if p["requested_on"] != nil && p["recorded_on"] != nil && Str(p["recorded_on"]) < Str(p["requested_on"]) {
		dInvalid(code, "recorded_on", "must not be before requested_on")
	}
	if update {
		dlExpected(r, p, code, false)
	}
	return p
}
func dlAfterPayload(r Row, update bool) Row {
	code := "INVALID_AFTER_SALES_PAYLOAD"
	p := Row{"reported_on": dDate(r["reported_on"], "reported_on", code, false), "service_on": dDate(r["service_on"], "service_on", code, true), "coverage_type": dEnum(r["coverage_type"], "coverage_type", code, "warranty|paid|goodwill")}
	if p["service_on"] != nil && Str(p["service_on"]) < Str(p["reported_on"]) {
		dInvalid(code, "service_on", "must not be before reported_on")
	}
	for _, f := range strings.Fields("reason contact_name contact_phone notes") {
		p[f] = dText(r[f], f, code, f == "reason")
	}
	if update {
		dlExpected(r, p, code, false)
	}
	return p
}
func dlAddMonths(date string, months int64) string {
	start := dTry(time.Parse("2006-01-02", date))
	y, m, day := start.Date()
	target := time.Date(y, m+time.Month(months), 1, 0, 0, 0, 0, time.UTC)
	last := time.Date(target.Year(), target.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
	if day > last {
		day = last
	}
	result := time.Date(target.Year(), target.Month(), day, 0, 0, 0, 0, time.UTC)
	if result.Year() > 9999 {
		dInvalid("INVALID_WARRANTY_PAYLOAD", "duration_months", "is out of range")
	}
	return result.Format("2006-01-02")
}
func dlWarrantyResponse(c *Context, r Row) Row {
	out := dFields(r, "id project_id acceptance_id starts_on duration_months ends_on renewal_price_cents notes revision created_at updated_at")
	today := c.S.Now().In(time.FixedZone("Asia/Shanghai", 8*3600)).Format("2006-01-02")
	end := dTry(time.Parse("2006-01-02", Str(r["ends_on"])))
	current := dTry(time.Parse("2006-01-02", today))
	remaining := (end.Unix() - current.Unix()) / 86400
	status := "active"
	if today < Str(r["starts_on"]) {
		status = "not_started"
	} else if remaining < 0 {
		status = "expired"
	} else if remaining <= 30 {
		status = "expiring"
	}
	out["status"] = status
	out["days_remaining"] = remaining
	return out
}
