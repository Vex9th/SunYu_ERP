package api

import (
	"errors"
	"log"
	"net/http"
	"strings"
)

func businessIdempotencyKey(r *http.Request, required bool) (string, error) {
	values := r.Header.Values("Idempotency-Key")
	if len(values) == 0 && !required {
		return "", nil
	}
	if len(values) != 1 || !uuidPattern.MatchString(values[0]) {
		e := E(422, "Invalid Idempotency-Key", "VALIDATION_ERROR")
		e.Headers = map[string]string{"X-Error-Code": "VALIDATION_ERROR"}
		return "", e
	}
	return strings.ToLower(values[0]), nil
}
func businessHandle(s *Server, pattern string, h Handler) {
	s.Handle(pattern, func(c *Context) (any, error) {
		value, e := h(c)
		if e == nil {
			return value, nil
		}
		var a *APIError
		if !errors.As(e, &a) {
			log.Printf("business operation failed: %v", e)
			switch {
			case strings.Contains(pattern, "/stages"):
				return nil, E(500, "Project stage operation failed", "PROJECT_STAGE_OPERATION_FAILED")
			case strings.Contains(pattern, "/companies"):
				subject := "Company"
				if strings.Contains(pattern, "/contacts") {
					subject = "Contact"
				}
				return nil, E(500, subject+" operation failed", "")
			case pattern == "GET /api/dashboard":
				return nil, E(500, "Dashboard operation failed", "DASHBOARD_OPERATION_FAILED")
			case strings.Contains(pattern, "/projects"):
				if pattern == "GET /api/projects" || pattern == "POST /api/projects" {
					return nil, E(500, "Project operation failed", "")
				}
				return nil, E(500, "Project operation failed", "PROJECT_OPERATION_FAILED")
			}
			return value, e
		}
		if a.Detail == "Invalid JSON object" {
			detail := "Invalid project payload"
			switch {
			case strings.Contains(pattern, "/contacts"):
				detail = "Invalid contact payload"
			case strings.Contains(pattern, "/companies"):
				detail = "Invalid company payload"
			case strings.Contains(pattern, "/stages"):
				detail = "Invalid stage payload"
				if strings.Contains(pattern, "/transition") {
					detail = "Invalid stage transition"
				}
			case strings.Contains(pattern, "/quotes"):
				detail = "Invalid quote payload"
				if strings.Contains(pattern, "/transition") {
					detail = "Invalid quote transition"
				}
			case strings.Contains(pattern, "/contracts"):
				detail = "Invalid contract payload"
				if strings.Contains(pattern, "/transition") {
					detail = "Invalid contract transition"
				}
			case strings.Contains(pattern, "/payment-terms"):
				detail = "Invalid payment term payload"
			case strings.Contains(pattern, "/receipts"):
				detail = "Invalid receipt payload"
				if strings.Contains(pattern, "/void") {
					detail = "Invalid receipt void payload"
				}
			case strings.HasSuffix(pattern, "/close"):
				detail = "Invalid project close payload"
			case strings.HasSuffix(pattern, "/restore"):
				detail = "Invalid project restore payload"
			}
			code := "VALIDATION_ERROR"
			if strings.HasPrefix(pattern, "DELETE /api/companies") {
				detail = "Invalid revision payload"
			} else if strings.HasPrefix(pattern, "POST /api/companies") || strings.HasPrefix(pattern, "PUT /api/companies") || pattern == "POST /api/projects" {
				code = ""
			}
			a = E(422, detail, code)
		}
		if strings.Contains(pattern, "/stages") {
			if a.Status == 422 {
				if a.Detail == "Invalid stage payload" {
					a.Code = "INVALID_STAGE_PAYLOAD"
				}
				if a.Detail == "Invalid stage transition" {
					a.Code = "INVALID_STAGE_TRANSITION"
				}
			}
			if a.Code == "IDEMPOTENCY_KEY_REUSED" {
				a.Code = "IDEMPOTENCY_CONFLICT"
				a.Detail = "Idempotency key was already used with different content"
			}
			a.Headers = nil
		} else if a.Code != "" && (a.Status == 409 || strings.Contains(pattern, "/projects/{project_code}") || strings.Contains(pattern, "/companies")) {
			if a.Headers == nil {
				a.Headers = map[string]string{}
			}
			a.Headers["X-Error-Code"] = a.Code
		}
		return value, a
	})
}
