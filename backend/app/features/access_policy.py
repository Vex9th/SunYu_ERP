"""Explicit route permissions, object scope, and public response boundaries."""

from __future__ import annotations

import json
from dataclasses import dataclass
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from fastapi import HTTPException
from fastapi.routing import APIRoute
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.routing import request_response

from backend.app.core.access import require_permission, require_principal
from backend.app.core.database import connect_database
from backend.app.core.storage_paths import normalize_project_code, project_code_identity
from backend.app.features.operation_catalog import RESOURCE_TABLES, RESOURCE_VIEWS


@dataclass(frozen=True)
class Policy:
    permission: str
    resource: str | None = None


POLICIES: dict[str, Policy] = {}


def _routes(permission, resource, names):
    for name in names.split():
        if name in POLICIES:
            raise RuntimeError(f"duplicate route policy: {name}")
        POLICIES[name] = Policy(permission, resource)


_routes(
    "projects.view",
    "project",
    "list_projects get_project_detail get_project_dashboard get_global_dashboard",
)
for action, names in {
    "create": "create_project",
    "edit": "update_project",
    "archive": "archive_project",
    "close": "close_project",
    "restore": "restore_project",
}.items():
    _routes("projects." + action, "project", names)
_routes("project_stages.view", "project_stage", "list_project_stages")
_routes(
    "project_stages.manage",
    "project_stage",
    "update_project_stage transition_project_stage",
)
_routes("companies.view", "company", "list_companies get_company")
_routes("company_ledger.view", None, "get_company_ledger")
_routes("companies.create", "company", "create_company")
_routes("companies.edit", "company", "replace_company")
_routes("companies.delete", "company", "delete_company")
_routes("companies.edit", "contact", "create_contact replace_contact delete_contact")
_routes("documents.view", "document", "list_documents get_document")
_routes("documents.view", "document_version", "list_document_version_options")
_routes("documents.upload", "document", "create_document")
_routes("documents.upload", "document_version", "add_document_version")
_routes("documents.edit", "document", "update_document")
_routes("documents.archive", "document", "archive_document")
_routes(
    "documents.download",
    "document_version",
    "download_document_version download_document_version_by_id",
)
for resource, prefix, actions in (
    (
        "quote",
        "quotes",
        {
            "view": "list_quotes get_quote",
            "create": "create_quote",
            "edit": "update_quote",
            "confirm": "transition_quote",
        },
    ),
    (
        "contract",
        "contracts",
        {
            "view": "list_contracts get_contract",
            "create": "create_contract",
            "edit": "update_contract",
            "confirm": "transition_contract",
        },
    ),
    (
        "customer_receipt",
        "customer_receipts",
        {
            "view": "get_payments",
            "register": "create_receipt update_receipt",
            "reverse": "void_receipt",
        },
    ),
    ("payment_term", "customer_receipts", {"register": "put_payment_term"}),
    (
        "procurement_list",
        "procurement.lines",
        {
            "view": "list_procurement_lists get_procurement_list",
            "create": "create_procurement_list copy_procurement_list_as_draft",
            "edit": "update_procurement_list",
            "confirm": "confirm_procurement_list",
            "import": "download_procurement_template preview_procurement_import confirm_procurement_import",
        },
    ),
    (
        "procurement_line",
        "procurement.lines",
        {
            "create": "create_procurement_line",
            "edit": "update_procurement_line",
            "delete": "delete_procurement_line",
            "confirm": "confirm_procurement_line",
            "reopen": "reopen_procurement_line",
        },
    ),
    (
        "purchase_order",
        "procurement.orders",
        {
            "view": "list_purchase_orders get_purchase_order get_procurement_overview",
            "create": "create_purchase_order preview_purchase_order_number",
            "edit": "update_purchase_order",
            "confirm": "confirm_purchase_order",
            "cancel": "cancel_purchase_order",
        },
    ),
    (
        "goods_receipt",
        "procurement.receipts",
        {"register": "create_goods_receipt", "reverse": "reverse_goods_receipt"},
    ),
    (
        "supplier_payment",
        "procurement.payments",
        {"register": "create_supplier_payment", "reverse": "reverse_supplier_payment"},
    ),
    (
        "supplier_invoice",
        "procurement.invoices",
        {"register": "create_supplier_invoice", "reverse": "reverse_supplier_invoice"},
    ),
    (
        "quote_export",
        "procurement.lines",
        {
            "view": "list_quote_exports",
            "export": "create_quote_export download_quote_export",
        },
    ),
    (
        "inventory_item",
        "inventory",
        {"view": "list_inventory_items get_inventory_item"},
    ),
    ("inventory_movement", "inventory", {"view": "list_inventory_movements"}),
    (
        "inventory_adjustment",
        "inventory.shared",
        {"manage": "create_inventory_adjustment reverse_inventory_adjustment"},
    ),
    (
        "inventory_issue",
        "inventory",
        {"manage": "create_project_issue reverse_project_issue"},
    ),
    (
        "worker",
        "workforce",
        {
            "view": "list_workers get_worker",
            "manage": "create_worker update_worker deactivate_worker reactivate_worker",
        },
    ),
    (
        "crew_assignment",
        "dispatches",
        {
            "view": "list_assignments",
            "manage": "create_assignment update_assignment transition_assignment",
        },
    ),
    (
        "labor_entry",
        "workforce",
        {
            "view": "list_labor_entries",
            "manage": "create_labor_entry update_single_labor_entry void_labor_entry save_labor_batch",
        },
    ),
    (
        "site_daily_report",
        "site_reports",
        {
            "view": "list_reports",
            "manage": "upsert_report confirm_report reopen_report",
        },
    ),
    (
        "material_advance",
        "material_advances",
        {
            "view": "list_advances get_advance",
            "create": "create_advance",
            "edit": "update_advance",
            "void": "void_advance",
        },
    ),
    (
        "advance_reimbursement",
        "material_advances",
        {"reimburse": "reimburse_advance", "reverse": "void_reimbursement"},
    ),
    (
        "drawing_signoff",
        "engineering_changes",
        {"view": "list_signoffs", "manage": "put_signoff"},
    ),
    (
        "commissioning_session",
        "engineering_changes",
        {
            "view": "list_commissioning",
            "manage": "create_commissioning update_commissioning",
        },
    ),
    (
        "engineering_change",
        "engineering_changes",
        {
            "view": "list_changes",
            "manage": "create_change update_change transition_change",
        },
    ),
    (
        "acceptance",
        "acceptance",
        {
            "view": "list_acceptances",
            "manage": "create_acceptance reschedule_acceptance cancel_acceptance complete_acceptance",
        },
    ),
    ("warranty", "warranty", {"view": "get_warranty", "manage": "put_warranty"}),
    (
        "project_invoice",
        "customer_invoices",
        {
            "view": "list_invoices",
            "register": "create_invoice update_invoice",
            "reverse": "void_invoice",
        },
    ),
    (
        "after_sales_case",
        "after_sales",
        {
            "view": "list_after_sales",
            "manage": "create_after_sales update_after_sales transition_after_sales",
        },
    ),
):
    for action, names in actions.items():
        _routes(prefix + "." + action, resource, names)
_routes("procurement.lines.view", None, "get_procurement_options")
_routes(
    "inventory.shared.manage",
    "inventory_item",
    "create_inventory_item update_inventory_item",
)
_routes("projects.view", None, "delivery_summary")
_routes(
    "owner",
    None,
    "get_overview put_backup_settings post_backup start_backup_task get_backup_task status check install",
)


def policy_for_route(route):
    if route.path.startswith("/api/auth/") or route.path == "/api/health":
        return Policy("public")
    if route.path.startswith(("/api/accounts", "/api/workgroups", "/api/permissions/")):
        return Policy("owner")
    if route.path.startswith("/api/operation-history/"):
        return Policy("authenticated")
    return POLICIES.get(route.name)


# Foreign-key paths for resources whose project is on the owning document.
_PARENT = {
    "procurement_line": ("procurement_list_id", "procurement_list"),
    "goods_receipt": ("purchase_order_id", "purchase_order"),
    "supplier_payment": ("purchase_order_id", "purchase_order"),
    "supplier_invoice": ("purchase_order_id", "purchase_order"),
    "advance_reimbursement": ("advance_id", "material_advance"),
    "document_version": ("document_id", "document"),
    "contact": ("company_id", "company"),
    "purchase_order_line": ("purchase_order_id", "purchase_order"),
    "goods_receipt_line": ("goods_receipt_id", "goods_receipt"),
    "inventory_issue_line": ("inventory_issue_id", "inventory_issue"),
    "material_advance_item": ("advance_id", "material_advance"),
}


def resource_project_ids(connection, resource_type, resource_id):
    table = RESOURCE_TABLES.get(resource_type)
    if table is None:
        return None
    if resource_type == "project_stage" and ":" in str(resource_id):
        project_id, stage = str(resource_id).split(":", 1)
        row = connection.execute(
            "SELECT * FROM project_stages WHERE project_id=? AND stage_code=?",
            (project_id, stage),
        ).fetchone()
    else:
        row = connection.execute(
            f'SELECT * FROM "{table}" WHERE id=?', (resource_id,)
        ).fetchone()
    if row is None:
        return None
    if resource_type == "project":
        return (int(row["id"]),)
    if resource_type == "document":
        projects = connection.execute(
            "SELECT id FROM projects WHERE project_code=? COLLATE NOCASE",
            (row["project_code"],),
        ).fetchall()
        return tuple(r[0] for r in projects)
    if resource_type == "contract":
        return tuple(
            r[0]
            for r in connection.execute(
                "SELECT project_id FROM contract_project_allocations WHERE contract_id=?",
                (resource_id,),
            )
        )
    if "project_id" in row.keys():  # noqa: SIM118 - sqlite3.Row membership tests values
        return (row["project_id"],) if row["project_id"] is not None else ()
    if resource_type in _PARENT:
        column, parent = _PARENT[resource_type]
        return resource_project_ids(connection, parent, row[column])
    return ()


DOCUMENT_PERMISSIONS = {
    "quotation": ("quotes.view",),
    "contract": ("contracts.view",),
    "procurement_list": ("procurement.lines.view", "sensitive.procurement_prices"),
    "procurement_contract": ("procurement.orders.view", "sensitive.procurement_prices"),
    "construction": ("site_reports.view",),
    "commissioning": ("engineering_changes.view",),
    "acceptance": ("acceptance.view",),
    "invoice": ("customer_invoices.view",),
    "warranty": ("warranty.view",),
    "after_sales": ("after_sales.view",),
}


def can_read_document(connection, principal, document_id):
    try:
        authorize_document(connection, principal, document_id)
        return True
    except HTTPException:
        return False


def authorize_document(connection, principal, document_id):
    row = connection.execute(
        "SELECT category FROM documents WHERE id=?", (document_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(404, "文件不存在")
    require_permission(principal, "documents.view")
    supplier_source = connection.execute(
        """SELECT 1 FROM supplier_invoice_documents l
        JOIN document_versions v ON v.id=l.document_version_id WHERE v.document_id=? LIMIT 1""",
        (document_id,),
    ).fetchone()
    procurement_quote = connection.execute(
        """SELECT 1 FROM quote_exports q
        JOIN document_versions v ON v.id=q.document_version_id WHERE v.document_id=? LIMIT 1""",
        (document_id,),
    ).fetchone()
    category_permissions = DOCUMENT_PERMISSIONS.get(row["category"], ())
    if row["category"] == "invoice" and supplier_source:
        category_permissions = (
            "procurement.invoices.view",
            "sensitive.procurement_prices",
        )
    elif row["category"] == "quotation" and procurement_quote:
        category_permissions = (
            "procurement.lines.view",
            "sensitive.procurement_prices",
        )
    for key in category_permissions:
        require_permission(principal, key)
    for export in connection.execute(
        """SELECT q.project_id FROM quote_exports q
        JOIN document_versions v ON v.id=q.document_version_id WHERE v.document_id=?""",
        (document_id,),
    ):
        require_permission(principal, "procurement.lines.view", project_id=export[0])
    projects = resource_project_ids(connection, "document", document_id)
    for project_id in projects or ():
        require_permission(principal, "documents.view", project_id=project_id)
    # Contract attachments may belong to several projects, even if stored under one project.
    for row in connection.execute(
        """SELECT DISTINCT a.project_id FROM contract_document_versions cd
        JOIN document_versions v ON v.id=cd.document_version_id
        JOIN contract_project_allocations a ON a.contract_id=cd.contract_id WHERE v.document_id=?""",
        (document_id,),
    ):
        require_permission(principal, "contracts.view", project_id=row[0])
    # Business attachments cannot bypass the permission on their originating record.
    for table, parent, foreign, permission in (
        (
            "supplier_invoice_documents",
            "supplier_invoice",
            "supplier_invoice_id",
            "procurement.invoices.view",
        ),
        (
            "purchase_order_documents",
            "purchase_order",
            "purchase_order_id",
            "procurement.orders.view",
        ),
        ("quote_document_versions", "quote", "quote_id", "quotes.view"),
    ):
        for link in connection.execute(
            f"""SELECT DISTINCT l.{foreign} FROM {table} l
             JOIN document_versions v ON v.id=l.document_version_id WHERE v.document_id=?""",
            (document_id,),
        ):
            require_permission(principal, permission)
            for project_id in resource_project_ids(connection, parent, link[0]) or ():
                require_permission(principal, permission, project_id=project_id)
    for link in connection.execute(
        """SELECT DISTINCT l.resource_type FROM workforce_document_links l
        JOIN document_versions v ON v.id=l.document_version_id WHERE v.document_id=?""",
        (document_id,),
    ):
        resource = {
            "invoice": "project_invoice",
            "after_sales": "after_sales_case",
        }.get(link[0], link[0])
        permission = RESOURCE_VIEWS.get(resource)
        if permission:
            require_permission(principal, permission)


_PATH_RESOURCES = {
    "list_id": "procurement_list",
    "line_id": "procurement_line",
    "order_id": "purchase_order",
    "receipt_id": "goods_receipt",
    "payment_id": "supplier_payment",
    "invoice_id": "supplier_invoice",
    "export_id": "quote_export",
    "document_id": "document",
    "version_id": "document_version",
    "quote_id": "quote",
    "contract_id": "contract",
    "assignment_id": "crew_assignment",
    "entry_id": "labor_entry",
    "advance_id": "material_advance",
    "reimbursement_id": "advance_reimbursement",
    "acceptance_id": "acceptance",
    "case_id": "after_sales_case",
    "change_id": "engineering_change",
    "session_id": "commissioning_session",
    "issue_id": "inventory_issue",
}
_REFERENCE_RESOURCES = {
    "document_version_id": "document_version",
    "document_version_ids": "document_version",
    "procurement_line_id": "procurement_line",
    "procurement_line_ids": "procurement_line",
    "procurement_list_id": "procurement_list",
    "purchase_order_id": "purchase_order",
    "assignment_id": "crew_assignment",
    "acceptance_id": "acceptance",
}


def _authorize_references(connection, principal, value):
    if isinstance(value, list):
        for child in value:
            _authorize_references(connection, principal, child)
    elif isinstance(value, dict):
        for key, child in value.items():
            resource = _REFERENCE_RESOURCES.get(key)
            if resource:
                for item in child if isinstance(child, list) else [child]:
                    if isinstance(item, int) and not isinstance(item, bool):
                        projects = resource_project_ids(connection, resource, item)
                        if projects is None:
                            continue  # The business validator supplies the field error.
                        view = RESOURCE_VIEWS[resource]
                        for project_id in projects:
                            require_permission(principal, view, project_id=project_id)
                        if resource == "document_version":
                            row = connection.execute(
                                "SELECT document_id FROM document_versions WHERE id=?",
                                (item,),
                            ).fetchone()
                            if row:
                                authorize_document(connection, principal, row[0])
            elif (
                key == "project_id"
                and isinstance(child, int)
                and not isinstance(child, bool)
            ):
                require_permission(principal, "projects.view", project_id=child)
            elif key == "project_code" and isinstance(child, str):
                try:
                    project_key = project_code_identity(normalize_project_code(child))
                except (ValueError, TypeError, UnicodeError):
                    continue
                row = connection.execute(
                    "SELECT id FROM projects WHERE project_code_key=?", (project_key,)
                ).fetchone()
                if row:
                    require_permission(principal, "projects.view", project_id=row[0])
            else:
                _authorize_references(connection, principal, child)


def authorize_request(connection, request, policy, payload):
    settings = request.app.state.settings.get()
    principal = require_principal(request, connection, settings.session_secret)
    connection.principal = principal
    if policy.permission == "owner":
        if not principal.is_owner:
            raise HTTPException(403, "仅主账号可操作系统或账号管理")
        return principal, ()
    if policy.permission == "authenticated":
        return principal, ()
    permission = policy.permission
    transition = (
        payload.get("status", payload.get("to_status"))
        if isinstance(payload, dict)
        else None
    )
    if (
        request.scope["endpoint"].__name__ == "transition_contract"
        and transition == "terminated"
    ):
        permission = "contracts.cancel"
    if request.scope["endpoint"].__name__ == "transition_quote" and transition in {
        "rejected",
        "withdrawn",
    }:
        permission = "quotes.cancel"
    require_permission(principal, permission)
    if permission == "procurement.lines.export":
        require_permission(principal, "sensitive.procurement_prices")
    projects = set()
    code = request.path_params.get("project_code")
    if code:
        try:
            key = project_code_identity(normalize_project_code(code))
        except (ValueError, TypeError, UnicodeError):
            raise HTTPException(422, "项目编号无效") from None
        row = connection.execute(
            "SELECT id FROM projects WHERE project_code_key=?", (key,)
        ).fetchone()
        if row is None:
            raise HTTPException(404, "项目不存在")
        projects.add(row[0])
    for project_id in projects:
        require_permission(principal, permission, project_id=project_id)
    for key, value in request.path_params.items():
        resource = _PATH_RESOURCES.get(key)
        # Shared parameter names use the route's actual resource.
        if key in {"receipt_id", "invoice_id"} and policy.resource in {
            "customer_receipt",
            "project_invoice",
        }:
            resource = policy.resource
        if resource:
            scoped = resource_project_ids(connection, resource, value)
            if scoped is None:
                continue
            for project_id in scoped:
                if resource == "contract" and request.method == "GET":
                    continue
                require_permission(principal, permission, project_id=project_id)
            projects.update(scoped)
            if resource in {"document", "document_version"}:
                document_id = value
                if resource == "document_version":
                    document_id = connection.execute(
                        "SELECT document_id FROM document_versions WHERE id=?", (value,)
                    ).fetchone()[0]
                authorize_document(connection, principal, document_id)
    if isinstance(payload, dict):
        _authorize_references(connection, principal, payload)
        _authorize_sensitive_input(principal, payload, permission)
        category = payload.get("category")
        if policy.resource in {"document", "document_version"} and isinstance(
            category, str
        ):
            for key in DOCUMENT_PERMISSIONS.get(category, ()):
                require_permission(principal, key)
    request.state.operation_action = permission
    request.state.operation_projects = tuple(sorted(projects))
    return principal, tuple(sorted(projects))


def _authorize_sensitive_input(principal, value, module):
    if principal.is_owner:
        return
    if isinstance(value, list):
        for child in value:
            _authorize_sensitive_input(principal, child, module)
    elif isinstance(value, dict):
        for key, child in value.items():
            if key in {"bank_name", "bank_account"} and child is not None:
                require_permission(principal, "sensitive.company_banking")
            if module.startswith(("procurement.", "inventory.")) and key in {
                "unit_cost_cents",
                "gross_unit_cost_cents",
                "quoted_unit_price_cents",
                "tax_rate_bps",
                "amount_cents",
            }:
                require_permission(principal, "sensitive.procurement_prices")
            if module.startswith(("workforce.", "dispatches.")) and key in {
                "rate_cents",
                "pay_basis",
            }:
                require_permission(principal, "sensitive.salary_costs")
            _authorize_sensitive_input(principal, child, module)


def authorize_parsed_payload(request, payload, *, has_uploads=False):
    """Called after the existing bounded multipart parser, before staging any file."""
    policy = getattr(request.state, "access_policy", None)
    if policy is None:
        return
    settings = request.app.state.settings.get()
    connection = connect_database(settings.data_dir / "iapm.sqlite")
    try:
        principal, _ = authorize_request(connection, request, policy, payload)
        if has_uploads:
            require_permission(principal, "documents.upload")
        request.state.access_payload = payload
        request.state.operation_reason = next(
            (
                payload[key]
                for key in (
                    "reason",
                    "cancel_reason",
                    "void_reason",
                    "reversal_reason",
                    "status_reason",
                )
                if isinstance(payload.get(key), str)
            ),
            None,
        )
    finally:
        connection.close()


_BANK_FIELDS = {"bank_name", "bank_account", "bank_account_number"}
_PRICE_FIELDS = {
    "unit_cost_cents",
    "quoted_unit_price_cents",
    "gross_unit_cost_cents",
    "tax_amount_cents",
    "tax_rate_bps",
    "unit_price_cents",
    "ordered_amount_cents",
    "paid_amount_cents",
    "unpaid_amount_cents",
    "total_cost_cents",
    "inventory_value_cents",
    "value_cents",
    "value_delta_cents",
    "value_after_cents",
    "value_after_movement_cents",
}
_SALARY_FIELDS = {
    "rate_cents",
    "cost_cents",
    "labor_cost_cents",
    "labor_total_cents",
    "salary_cents",
    "pay_basis",
}
_PROFIT_FIELDS = {
    "actual_profit_cents",
    "estimated_profit_cents",
    "profit_cents",
    "cost_summary",
    "actual_total_cost_cents",
    "planned_total_cost_cents",
    "estimated_cost_delta_cents",
    "margin_basis_points",
}


def redact_fields(value, principal, module="", resource_type=None):
    if principal.is_owner:
        return value
    if isinstance(value, list):
        return [redact_fields(v, principal, module, resource_type) for v in value]
    if not isinstance(value, dict):
        return value
    result = {}
    hidden = []
    for key, child in value.items():
        needed = None
        if "inventory.shared.view" not in principal.permissions and (
            (
                resource_type == "inventory_item"
                and key in {"quantity_milli", "inventory_value_cents"}
            )
            or (
                resource_type == "inventory_movement"
                and key in {"quantity_after_milli", "value_after_cents"}
            )
        ):
            needed = "inventory.shared.view"
        elif key in _BANK_FIELDS:
            needed = "sensitive.company_banking"
        elif key in _SALARY_FIELDS and (
            key != "cost_cents" or module.startswith(("workforce.", "dispatches."))
        ):
            needed = "sensitive.salary_costs"
        elif key in _PROFIT_FIELDS:
            needed = "sensitive.profit_summary"
        elif key in _PRICE_FIELDS or (
            module.startswith(("procurement.", "inventory."))
            and key.endswith(("_cents", "_bps"))
        ):
            needed = "sensitive.procurement_prices"
        if needed and needed not in principal.permissions:
            result[key] = None
            hidden.append(key)
        else:
            child_module = (
                "procurement.orders.view"
                if key == "supplier"
                else ("customer_receipts.view" if key == "customer" else module)
            )
            result[key] = redact_fields(child, principal, child_module, resource_type)
    if hidden:
        result["restricted_fields"] = hidden
    return result


def _transform_idempotency_header(request, principal):
    # Legacy tables also store UUID keys outside the shared cache. Scope those keys by stable
    # account ID before any dependency reads them, including multipart and older endpoints.
    raw = request.headers.get("idempotency-key")
    if raw is None:
        return
    try:
        canonical = str(UUID(raw))
    except (ValueError, TypeError):
        return
    scoped = str(uuid5(NAMESPACE_URL, f"sunyu-account:{principal.user_id}:{canonical}"))
    request.scope["headers"] = [
        (key, scoped.encode() if key.lower() == b"idempotency-key" else value)
        for key, value in request.scope["headers"]
    ]
    request._headers = Headers(scope=request.scope)


def protect_application_routes(router):
    for route in router.routes:
        if not isinstance(route, APIRoute) or not route.path.startswith("/api/"):
            continue
        policy = policy_for_route(route)
        if policy is None:
            raise RuntimeError(f"Unclassified API route: {route.name} {route.path}")
        if policy.permission == "public":
            continue
        original_factory = route.get_route_handler

        # Preserve FastAPI's route-handler construction hook for both direct and included routers.
        def factory(original_factory=original_factory, policy=policy):
            return secure_route_handler(original_factory(), policy)

        route.get_route_handler = factory
        route.app = request_response(factory())


def secure_route_handler(original, policy):
    async def secured(request):
        settings = request.app.state.settings.get()
        connection = connect_database(settings.data_dir / "iapm.sqlite")
        try:
            payload = {}
            if request.method not in {
                "GET",
                "HEAD",
                "OPTIONS",
            } and "application/json" in request.headers.get("content-type", ""):
                try:
                    payload = await request.json()
                except (ValueError, UnicodeError):
                    pass  # Original route validation retains its error contract.
            principal, _projects = authorize_request(
                connection, request, policy, payload
            )
            request.state.access_policy = policy
            request.state.access_payload = payload
            request.state.operation_request_id = uuid4().hex
            request.state.operation_reason = next(
                (
                    payload[k]
                    for k in (
                        "reason",
                        "cancel_reason",
                        "void_reason",
                        "reversal_reason",
                        "status_reason",
                    )
                    if isinstance(payload, dict) and isinstance(payload.get(k), str)
                ),
                None,
            )
            _transform_idempotency_header(request, principal)
            response = await original(request)
            response.headers["X-Access-Revision"] = str(
                request.state.principal.access_revision
            )
            if (
                response.status_code < 400
                and response.headers.get("content-type", "").startswith(
                    "application/json"
                )
                and hasattr(response, "body")
            ):
                body = json.loads(response.body)
                body = enrich_response(
                    connection, request.state.principal, policy, body, request
                )
                headers = dict(response.headers)
                headers.pop("content-length", None)
                return JSONResponse(
                    body, status_code=response.status_code, headers=headers
                )
            return response
        finally:
            connection.close()

    return secured


def bind_request_connection(connection, request):
    policy = getattr(request.state, "access_policy", None)
    if policy is None:
        return
    payload = request.state.access_payload
    principal, projects = authorize_request(connection, request, policy, payload)
    connection.principal = principal
    if request.scope["endpoint"].__name__ == "post_backup":
        from backend.app.features.operation_history import bind_backup_actor

        bind_backup_actor(connection, principal, request.state.operation_request_id)

    def validate():
        current, current_projects = authorize_request(
            connection, request, policy, request.state.access_payload
        )
        connection.principal = current
        if getattr(connection, "before_commit", None) is not None:
            from backend.app.features.operation_history import bind_operation_context

            bind_operation_context(
                connection,
                principal=current,
                request_id=request.state.operation_request_id,
                action=request.state.operation_action,
                project_ids=current_projects,
                reason=request.state.operation_reason,
            )

    connection.before_transaction = validate
    if request.method not in {"GET", "HEAD", "OPTIONS"} and policy.permission not in {
        "owner",
        "authenticated",
    }:
        from backend.app.features.operation_history import bind_operation_context

        bind_operation_context(
            connection,
            principal=principal,
            request_id=request.state.operation_request_id,
            action=request.state.operation_action,
            project_ids=projects,
            reason=request.state.operation_reason,
        )


def _module_parts(body, principal, policy, endpoint):
    if principal.is_owner:
        return body

    def allowed(key):
        return key in principal.permissions

    if endpoint == "delivery_summary" and isinstance(body, dict):
        mapping = {
            "commissioning": "engineering_changes.view",
            "latest_acceptance": "acceptance.view",
            "warranty": "warranty.view",
            "final_payment": "customer_receipts.view",
            "invoices": "customer_invoices.view",
            "after_sales": "after_sales.view",
        }
        for key, permission in mapping.items():
            if not allowed(permission):
                body[key] = None
        construction = body.get("construction", {})
        for key in list(construction):
            permission = (
                "workforce.view"
                if key.startswith("labor_")
                else (
                    "material_advances.view"
                    if key == "material_cost_cents"
                    else "site_reports.view"
                )
            )
            if not allowed(permission):
                construction[key] = None
        todo_permissions = {
            "final_payment_outstanding": "customer_receipts.view",
            "warranty_expiring": "warranty.view",
            "after_sales_open": "after_sales.view",
        }
        body["todos"] = [
            todo
            for todo in body.get("todos", [])
            if allowed(todo_permissions.get(todo, ""))
        ]

    def visit(value, module):
        if isinstance(value, list):
            return [visit(item, module) for item in value]
        if not isinstance(value, dict):
            return value
        result = {}
        for key, child in value.items():
            required = None
            if module.startswith("procurement."):
                if key in {
                    "payments",
                    "supplier_payments",
                    "payment_status",
                    "paid_amount_cents",
                    "unpaid_amount_cents",
                    "procurement_paid_cents",
                }:
                    required = "procurement.payments.view"
                elif key in {
                    "invoices",
                    "supplier_invoices",
                    "invoice_status",
                    "invoiced_amount_cents",
                    "uninvoiced_amount_cents",
                    "procurement_invoiced_cents",
                }:
                    required = "procurement.invoices.view"
                elif key in {
                    "receipts",
                    "goods_receipts",
                    "receipt_status",
                    "received_quantity",
                    "received_quantity_milli",
                    "procurement_received_cents",
                    "received_amount_cents",
                }:
                    required = "procurement.receipts.view"
                elif module.startswith("procurement.lines.") and key in {
                    "ordered_quantity",
                    "ordered_quantity_milli",
                    "order_status",
                    "ordered_amount_cents",
                }:
                    required = "procurement.orders.view"
                elif key in {
                    "issued_quantity",
                    "used_quantity",
                    "used_quantity_milli",
                    "usage_status",
                    "material_consumed_cents",
                }:
                    required = "inventory.view"
            if (
                key in {"document_version_ids", "documents", "versions"}
                and module != "documents.view"
            ):
                required = "documents.view"
            if required and not allowed(required):
                result[key] = [] if isinstance(child, list) else None
                result.setdefault("restricted_fields", []).append(key)
            else:
                result[key] = visit(child, module)
        return result

    return visit(body, policy.permission)


def enrich_response(connection, principal, policy, body, request):
    from backend.app.features.operation_history import load_activity_summaries

    body = _module_parts(body, principal, policy, request.scope["endpoint"].__name__)
    body = redact_fields(body, principal, policy.permission)
    objects: dict[str, list[dict]] = {}

    def collect(value, resource):
        if isinstance(value, list):
            for child in value:
                collect(child, resource)
        elif isinstance(value, dict):
            if resource and "id" in value:
                objects.setdefault(resource, []).append(value)
            for key, child in value.items():
                nested = {
                    "contacts": "contact",
                    "lines": "procurement_line",
                    "orders": "purchase_order",
                    "receipts": "goods_receipt",
                    "payments": "supplier_payment",
                    "invoices": "supplier_invoice",
                    "goods_receipts": "goods_receipt",
                    "supplier_payments": "supplier_payment",
                    "supplier_invoices": "supplier_invoice",
                    "versions": "document_version",
                    "documents": "document",
                    "project": "project",
                    "stages": "project_stage",
                }.get(key)
                if key == "lines" and resource == "purchase_order":
                    nested = None
                if key == "receipts" and policy.resource == "customer_receipt":
                    nested = "customer_receipt"
                if key in {"items", "data", "lists"}:
                    nested = resource
                if nested:
                    collect(child, nested)

    collect(body, policy.resource)
    for resource, rows in objects.items():
        summaries = load_activity_summaries(
            connection, principal, resource, [row["id"] for row in rows]
        )
        for row in rows:
            row["activity_summary"] = summaries.get(str(row["id"]))
    return body
