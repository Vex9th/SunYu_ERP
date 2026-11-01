from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request

from backend.app.core.access import Principal, require_permission, require_principal
from backend.app.features.operation_catalog import (
    ACTION_FIELDS,
    AUDIT_FIELDS,
    FORBIDDEN_FIELDS,
    RESOURCE_TABLES,
    RESOURCE_VIEWS,
    action_label,
)


@dataclass(frozen=True)
class SystemActor:
    name: str = "系统自动"


def bind_backup_actor(connection, principal, request_id):
    """备份分阶段独立提交；每个阶段的记录随同一条 SQL 原子写入。"""
    user = isinstance(principal, Principal)
    values = {
        "request": request_id,
        "actor": principal.user_id if user else None,
        "name": principal.display_name if user else principal.name,
        "kind": "user" if user else "system",
        "group": principal.group_id if user else None,
        "group_name": principal.group_name if user else None,
    }
    for key, value in values.items():
        connection.create_function("backup_actor_" + key, 0, lambda value=value: value)
    for kind in ("INSERT", "UPDATE"):
        connection.execute(f"""CREATE TEMP TRIGGER IF NOT EXISTS audit_backup_{kind}
            AFTER {kind} ON main.backup_runs BEGIN
              INSERT OR IGNORE INTO operation_events
              (request_id,action,resource_type,resource_id,actor_kind,actor_id,actor_name,
               group_id,group_name,summary,reason,changes_json,occurred_at)
              VALUES(backup_actor_request(),'system.backup.'||NEW.status,'backup_job',CAST(NEW.id AS TEXT),
                backup_actor_kind(),backup_actor_actor(),backup_actor_name(),backup_actor_group(),
                backup_actor_group_name(),CASE NEW.status WHEN 'running' THEN '开始备份'
                WHEN 'success' THEN '备份完成' ELSE '备份失败' END,NULL,
                json_object('status',NEW.status),COALESCE(NEW.finished_at,NEW.started_at));
            END""")


def _safe_changes(value):
    if isinstance(value, dict):
        if any(str(key).casefold() in FORBIDDEN_FIELDS for key in value):
            raise ValueError(
                "credential or file content cannot be recorded in operation history"
            )
        return {key: _safe_changes(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_safe_changes(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise ValueError("operation changes must be JSON compatible")


def append_operation_event(
    connection: sqlite3.Connection,
    *,
    principal: Principal | SystemActor,
    request_id: str,
    action: str,
    resource_type: str,
    resource_id: int | str,
    project_ids: tuple[int, ...],
    summary: str,
    reason: str | None,
    changes: dict[str, object],
    occurred_at: str,
) -> int:
    if not connection.in_transaction:
        raise RuntimeError("operation history requires the business transaction")
    allowed = ACTION_FIELDS.get(action, AUDIT_FIELDS.get(resource_type, frozenset()))
    if changes.keys() - allowed:
        raise ValueError("unlisted fields cannot be recorded in operation history")
    changes_json = json.dumps(
        _safe_changes(changes), ensure_ascii=False, allow_nan=False
    )
    user = isinstance(principal, Principal)
    connection.execute(
        """INSERT OR IGNORE INTO operation_events
        (request_id,action,resource_type,resource_id,actor_kind,actor_id,actor_name,
         group_id,group_name,summary,reason,changes_json,occurred_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            request_id,
            action,
            resource_type,
            str(resource_id),
            "user" if user else "system",
            principal.user_id if user else None,
            principal.display_name if user else principal.name,
            principal.group_id if user else None,
            principal.group_name if user else None,
            summary,
            reason,
            changes_json,
            occurred_at,
        ),
    )
    event_id = connection.execute(
        """SELECT id FROM operation_events WHERE
        request_id=? AND action=? AND resource_type=? AND resource_id=?""",
        (request_id, action, resource_type, str(resource_id)),
    ).fetchone()[0]
    connection.executemany(
        "INSERT OR IGNORE INTO operation_event_projects(event_id,project_id) VALUES (?,?)",
        [(event_id, p) for p in sorted(set(project_ids))],
    )
    return event_id


def bind_operation_context(
    connection: sqlite3.Connection,
    *,
    principal: Principal | SystemActor,
    request_id: str,
    action: str,
    project_ids: tuple[int, ...],
    reason: str | None,
) -> None:
    """连接内临时触发器收集实际变更，在原业务事务提交前写入操作记录。

    只覆盖明确列出的业务实体；会话、凭据、缓存及历史事件表不参与。
    临时触发器不会修改持久化数据库结构。
    """
    connection.execute("""CREATE TEMP TABLE IF NOT EXISTS pending_operation_changes (
        resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
        before_json TEXT NOT NULL, after_json TEXT NOT NULL, project_ids_json TEXT NOT NULL,
        PRIMARY KEY(resource_type,resource_id))""")
    for resource, table in RESOURCE_TABLES.items():
        columns = [
            r["name"] for r in connection.execute(f'PRAGMA table_info("{table}")')
        ]
        if "id" not in columns or resource == "backup_job":
            continue
        allowed = [c for c in columns if c in AUDIT_FIELDS.get(resource, ())]

        def json_row(prefix, allowed=allowed):
            pairs = ",".join(f"'{c}',{prefix}.\"{c}\"" for c in allowed)
            return f"json_object({pairs})"

        for kind in ("INSERT", "UPDATE", "DELETE"):
            prefix = "OLD" if kind == "DELETE" else "NEW"
            old = "'{}'" if kind == "INSERT" else json_row("OLD")
            new = "'{}'" if kind == "DELETE" else json_row("NEW")
            row_project = (
                f"{prefix}.project_id"
                if "project_id" in columns
                else (f"{prefix}.id" if resource == "project" else "NULL")
            )
            connection.execute(f'''CREATE TEMP TRIGGER IF NOT EXISTS operation_{table}_{kind}
                AFTER {kind} ON main."{table}"
                BEGIN
                    INSERT INTO pending_operation_changes
                        (resource_type,resource_id,before_json,after_json,project_ids_json)
                    VALUES('{resource}',CAST({prefix}.id AS TEXT),{old},{new},json_array({row_project}))
                    ON CONFLICT(resource_type,resource_id) DO UPDATE SET after_json=excluded.after_json;
                END;''')

    def flush():
        # 同一业务事务中重复修改同一行时，合并为最初值和最终值。
        # 待记录变更与持久化事件都随业务写入一起回滚。
        rows = connection.execute("SELECT * FROM pending_operation_changes").fetchall()
        for row in rows:
            before, after = (
                json.loads(row["before_json"]),
                json.loads(row["after_json"]),
            )
            changes = {
                key: {"before": before.get(key), "after": after.get(key)}
                for key in before.keys() | after.keys()
                if before.get(key) != after.get(key)
            }
            if not changes:
                continue
            row_projects = set(project_ids) | {
                p for p in json.loads(row["project_ids_json"]) if p is not None
            }
            from backend.app.features.access_policy import resource_project_ids

            row_projects.update(
                resource_project_ids(
                    connection, row["resource_type"], row["resource_id"]
                )
                or ()
            )
            append_operation_event(
                connection,
                principal=principal,
                request_id=request_id,
                action=action,
                resource_type=row["resource_type"],
                resource_id=row["resource_id"],
                project_ids=tuple(sorted(row_projects)),
                summary=action_label(action),
                reason=reason,
                changes=changes,
                occurred_at=datetime.now(timezone.utc).isoformat(),
            )
        connection.execute("DELETE FROM pending_operation_changes")

    connection.before_commit = flush


def _require_history_access(connection, principal, resource_type, resource_id):
    if resource_type in {"account", "workgroup", "backup_job", "system_job"}:
        if not principal.is_owner:
            raise HTTPException(403, "仅主账号可查看管理记录")
        return
    view = RESOURCE_VIEWS.get(resource_type)
    if view is None:
        raise HTTPException(404, "未知业务记录")
    require_permission(principal, view)
    from backend.app.features.access_policy import (
        authorize_document,
        resource_project_ids,
    )

    if resource_type in {"document", "document_version"}:
        document_id = resource_id
        if resource_type == "document_version":
            row = connection.execute(
                "SELECT document_id FROM document_versions WHERE id=?", (resource_id,)
            ).fetchone()
            if row is None:
                raise HTTPException(404, "文件不存在")
            document_id = row[0]
        authorize_document(connection, principal, document_id)
    projects = resource_project_ids(connection, resource_type, str(resource_id))
    if projects is None:
        rows = connection.execute(
            """SELECT DISTINCT p.project_id FROM operation_events e
            JOIN operation_event_projects p ON p.event_id=e.id
            WHERE e.resource_type=? AND e.resource_id=?""",
            (resource_type, str(resource_id)),
        ).fetchall()
        projects = tuple(r[0] for r in rows)
        if not projects and not principal.is_owner:
            raise HTTPException(404, "记录不存在或不可访问")
    for project_id in projects:
        require_permission(principal, view, project_id=project_id)


def _event_visibility(connection, principal):
    if principal.is_owner:
        return "1", []
    from backend.app.features.access_policy import can_read_document

    checked = {}

    def document_visible(resource, identifier, changes_json):
        if resource not in {"document", "document_version", "workforce_document_link"}:
            return 1
        key = (resource, identifier)
        if key in checked:
            return checked[key]
        document_id = identifier if resource == "document" else None
        if resource == "document_version":
            row = connection.execute(
                "SELECT document_id FROM document_versions WHERE id=?", (identifier,)
            ).fetchone()
            document_id = row[0] if row else None
        elif resource == "workforce_document_link":
            changes = json.loads(changes_json)
            version = changes.get("document_version_id", {})
            version_id = version.get("after") or version.get("before")
            row = connection.execute(
                "SELECT document_id FROM document_versions WHERE id=?", (version_id,)
            ).fetchone()
            document_id = row[0] if row else None
        checked[key] = int(
            document_id is not None
            and can_read_document(connection, principal, document_id)
        )
        return checked[key]

    connection.create_function("history_document_visible", 3, document_visible)
    resources = [
        resource
        for resource, key in RESOURCE_VIEWS.items()
        if key in principal.permissions
    ]
    from backend.app.features.permission_catalog import PERMISSION_KEYS

    actions = [
        key
        for key in PERMISSION_KEYS
        if key.rsplit(".", 1)[0] + ".view" in principal.permissions
    ]
    if not resources or not actions:
        return "0", []
    projects = sorted(principal.project_ids)
    project_condition = (
        f"AND p.project_id NOT IN ({','.join('?' for _ in projects)})"
        if projects
        else ""
    )
    clause = f"""e.resource_type IN ({",".join("?" for _ in resources)})
        AND e.action IN ({",".join("?" for _ in actions)})
        AND history_document_visible(e.resource_type,e.resource_id,e.changes_json)
        AND NOT EXISTS (SELECT 1 FROM operation_event_projects p WHERE p.event_id=e.id
            {project_condition})"""
    return clause, [*resources, *actions, *projects]


_HISTORY_CHILDREN = {
    "company": (("contact", "company_id"),),
    "document": (("document_version", "document_id"),),
    "procurement_list": (("procurement_line", "procurement_list_id"),),
    "purchase_order": tuple(
        (resource, "purchase_order_id")
        for resource in (
            "purchase_order_line",
            "goods_receipt",
            "supplier_payment",
            "supplier_invoice",
        )
    ),
    "goods_receipt": (("goods_receipt_line", "goods_receipt_id"),),
    "inventory_issue": (("inventory_issue_line", "inventory_issue_id"),),
    "material_advance": (
        ("material_advance_item", "advance_id"),
        ("advance_reimbursement", "advance_id"),
    ),
    "contract": (("contract_allocation", "contract_id"),),
    "worker": (("crew_assignment", "worker_id"), ("labor_entry", "worker_id")),
}


def list_operation_events(
    connection, principal, resource_type, resource_id, before_id=None, limit=20
):
    _require_history_access(connection, principal, resource_type, resource_id)
    if resource_type == "project_stage" and ":" in str(resource_id):
        project_id, stage_code = str(resource_id).split(":", 1)
        stage = connection.execute(
            "SELECT id FROM project_stages WHERE project_id=? AND stage_code=?",
            (project_id, stage_code),
        ).fetchone()
        if stage is None:
            return {"items": [], "next_before_id": None}
        resource_id = stage[0]
    limit = max(1, min(50, limit))
    clauses = ["(e.resource_type=? AND e.resource_id=?)"]
    parameters = [resource_type, str(resource_id)]
    if resource_type == "project":
        clauses.append(
            "EXISTS (SELECT 1 FROM operation_event_projects p WHERE p.event_id=e.id AND p.project_id=?)"
        )
        parameters.append(resource_id)
    for child, foreign in _HISTORY_CHILDREN.get(resource_type, ()):
        clauses.append(f"""(e.resource_type=? AND
            (CAST(json_extract(e.changes_json,'$.{foreign}.before') AS TEXT)=?
             OR CAST(json_extract(e.changes_json,'$.{foreign}.after') AS TEXT)=?))""")
        parameters.extend((child, str(resource_id), str(resource_id)))
        table = RESOURCE_TABLES[child]
        clauses.append(
            f"(e.resource_type=? AND e.resource_id IN (SELECT CAST(id AS TEXT) FROM {table} WHERE {foreign}=?))"
        )
        parameters.extend((child, resource_id))
    visible, args = _event_visibility(connection, principal)
    rows = connection.execute(
        f"""SELECT e.* FROM operation_events e
        WHERE ({" OR ".join(clauses)}) AND ({visible}) AND (? IS NULL OR e.id<?)
        ORDER BY e.id DESC LIMIT ?""",
        (*parameters, *args, before_id, before_id, limit + 1),
    ).fetchall()
    from backend.app.features.access_policy import redact_fields

    items = []
    for row in rows[:limit]:
        item = {
            k: row[k]
            for k in (
                "id",
                "action",
                "actor_name",
                "group_name",
                "occurred_at",
                "summary",
                "reason",
            )
        }
        item["changes"] = redact_fields(
            json.loads(row["changes_json"]),
            principal,
            RESOURCE_VIEWS.get(row["resource_type"], ""),
            row["resource_type"],
        )
        items.append(item)
    return {
        "items": items,
        "next_before_id": items[-1]["id"] if len(rows) > limit else None,
    }


def load_activity_summaries(connection, principal, resource_type, resource_ids):
    ids = tuple(dict.fromkeys(str(i) for i in resource_ids))
    if not ids:
        return {}
    result = {}
    visible, args = _event_visibility(connection, principal)
    for start in range(0, len(ids), 400):
        part = ids[start : start + 400]
        rows = connection.execute(
            f"""WITH visible AS (
            SELECT e.* FROM operation_events e WHERE e.resource_type=?
                AND e.resource_id IN ({",".join("?" for _ in part)}) AND ({visible})
            ), bounds AS (
                SELECT resource_id,MAX(id) AS latest_id,
                    MIN(CASE WHEN json_extract(changes_json,'$.id.before') IS NULL
                        AND json_extract(changes_json,'$.id.after') IS NOT NULL THEN id END) AS creation_id
                FROM visible GROUP BY resource_id
            ) SELECT latest.*,creator.actor_name AS created_by FROM bounds
              JOIN visible latest ON latest.id=bounds.latest_id
              LEFT JOIN visible creator ON creator.id=bounds.creation_id""",
            (resource_type, *part, *args),
        ).fetchall()
        for row in rows:
            result[row["resource_id"]] = {
                "created_by": row["created_by"],
                "last_actor": row["actor_name"],
                "last_action": row["summary"],
                "last_at": row["occurred_at"],
            }
    return result


def create_operation_history_router(get_connection, get_settings):
    router = APIRouter(prefix="/api/operation-history", tags=["operation-history"])
    connection_dependency = Depends(get_connection)
    settings_dependency = Depends(get_settings)

    @router.get("/{resource_type}/{resource_id}")
    def history(
        resource_type: str,
        resource_id: str,
        request: Request,
        before_id: int | None = None,
        limit: int = 20,
        connection=connection_dependency,
        settings=settings_dependency,
    ):
        principal = require_principal(request, connection, settings.session_secret)
        return list_operation_events(
            connection, principal, resource_type, resource_id, before_id, limit
        )

    return router
