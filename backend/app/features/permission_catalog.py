from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Permission:
    key: str
    label: str
    module: str
    dependencies: tuple[str, ...] = ()


def _module(
    prefix: str, label: str, actions: tuple[tuple[str, str], ...]
) -> tuple[Permission, ...]:
    return (
        Permission(f"{prefix}.view", f"查看{label}", label),
        *(
            Permission(
                f"{prefix}.{action}",
                f"{action_label}{label}",
                label,
                (f"{prefix}.view",),
            )
            for action, action_label in actions
        ),
    )


PERMISSIONS = (
    *_module(
        "projects",
        "项目资料",
        (
            ("create", "新建"),
            ("edit", "修改"),
            ("delete", "删除"),
            ("archive", "归档"),
            ("restore", "恢复"),
            ("close", "结项"),
        ),
    ),
    *_module("project_stages", "项目阶段", (("manage", "维护"),)),
    *_module(
        "documents",
        "文件",
        (
            ("upload", "上传"),
            ("edit", "修改"),
            ("download", "下载"),
            ("archive", "归档"),
        ),
    ),
    *_module(
        "companies",
        "公司基础资料",
        (("create", "新建"), ("edit", "修改"), ("delete", "删除")),
    ),
    Permission(
        "company_ledger.view", "查看公司往来账", "公司往来账", ("companies.view",)
    ),
    *_module(
        "contracts",
        "合同",
        (
            ("create", "新建"),
            ("edit", "修改"),
            ("delete", "删除"),
            ("confirm", "确认"),
            ("cancel", "取消"),
            ("export", "导出"),
        ),
    ),
    *_module(
        "customer_receipts", "客户收款", (("register", "登记"), ("reverse", "冲销"))
    ),
    *_module(
        "customer_invoices", "客户发票", (("register", "登记"), ("reverse", "冲销"))
    ),
    *_module(
        "procurement.lines",
        "采购清单",
        (
            ("create", "新建"),
            ("edit", "修改"),
            ("delete", "删除"),
            ("confirm", "确认"),
            ("reopen", "撤回确认"),
            ("import", "导入"),
            ("export", "导出"),
        ),
    ),
    *_module(
        "procurement.orders",
        "采购单",
        (
            ("create", "新建"),
            ("edit", "修改"),
            ("delete", "删除"),
            ("confirm", "确认"),
            ("cancel", "取消"),
        ),
    ),
    *_module(
        "procurement.receipts", "到货", (("register", "登记"), ("reverse", "冲销"))
    ),
    *_module(
        "procurement.payments",
        "供应商付款",
        (("register", "登记"), ("reverse", "冲销")),
    ),
    *_module(
        "procurement.invoices", "进项发票", (("register", "登记"), ("reverse", "冲销"))
    ),
    *_module("inventory", "项目库存", (("manage", "管理"),)),
    Permission(
        "inventory.shared.view", "查看共享库存", "共享库存", ("inventory.view",)
    ),
    Permission(
        "inventory.shared.manage",
        "管理共享库存",
        "共享库存",
        ("inventory.shared.view",),
    ),
    *_module("workforce", "施工人员", (("manage", "管理"),)),
    *_module("dispatches", "派工", (("manage", "管理"),)),
    *_module("site_reports", "施工日报", (("manage", "管理"),)),
    *_module("acceptance", "验收", (("manage", "管理"),)),
    *_module("warranty", "质保", (("manage", "管理"),)),
    *_module("after_sales", "售后", (("manage", "管理"),)),
    *_module("engineering_changes", "工程变更", (("manage", "管理"),)),
    *_module(
        "quotes",
        "报价单",
        (
            ("create", "生成"),
            ("edit", "修改"),
            ("confirm", "确认"),
            ("cancel", "取消"),
            ("download", "下载"),
        ),
    ),
    *_module(
        "material_advances",
        "材料垫资",
        (
            ("create", "登记"),
            ("edit", "修改"),
            ("reimburse", "报销"),
            ("reverse", "冲销"),
            ("void", "作废"),
        ),
    ),
    Permission("sensitive.procurement_prices", "查看采购价格", "敏感数据"),
    Permission(
        "sensitive.salary_costs", "查看工资成本", "敏感数据", ("workforce.view",)
    ),
    Permission(
        "sensitive.company_banking", "查看公司银行资料", "敏感数据", ("companies.view",)
    ),
    Permission(
        "sensitive.profit_summary", "查看成本利润汇总", "敏感数据", ("projects.view",)
    ),
)
PERMISSION_BY_KEY = {permission.key: permission for permission in PERMISSIONS}
PERMISSION_KEYS = frozenset(PERMISSION_BY_KEY)

# 页面入口与表单选项的依赖。仅用于主账号配置时联动勾选，不改变旧组的实际权限。
# 敏感字段必须由主账号看见新增勾选并保存，不能在登录或升级时静默授权。
_WORKFLOW_DEPENDENCIES = {
    **{
        f"{module}.view": ("projects.view",)
        for module in (
            "project_stages", "documents", "contracts", "customer_receipts",
            "customer_invoices", "procurement.lines", "procurement.orders",
            "workforce", "dispatches", "site_reports", "acceptance", "warranty",
            "after_sales", "engineering_changes", "quotes", "material_advances",
        )
    },
    **{
        f"procurement.{module}.view": ("procurement.orders.view",)
        for module in ("receipts", "payments", "invoices")
    },
    **{
        f"procurement.orders.{action}": (
            "procurement.lines.view", "companies.view", "sensitive.procurement_prices",
        )
        for action in ("create", "edit")
    },
    **{
        f"procurement.lines.{action}": ("sensitive.procurement_prices",)
        for action in ("create", "edit", "import", "export")
    },
    "procurement.payments.register": ("sensitive.procurement_prices",),
    "procurement.invoices.register": ("sensitive.procurement_prices",),
    "inventory.manage": ("projects.view",),
    "inventory.shared.manage": ("sensitive.procurement_prices",),
}


def permission_catalog() -> list[dict[str, object]]:
    return [
        {
            "key": item.key,
            "label": item.label,
            "module": item.module,
            "dependencies": list(item.dependencies),
            "workflow_dependencies": list(_WORKFLOW_DEPENDENCIES.get(item.key, ())),
        }
        for item in PERMISSIONS
    ]


def validate_permission_keys(keys: object) -> list[str]:
    if not isinstance(keys, list) or any(not isinstance(key, str) for key in keys):
        raise ValueError("permission_keys must be a list of permission keys")
    selected = set(keys)
    if selected - PERMISSION_KEYS:
        raise ValueError("Unknown permission key")
    if any(set(PERMISSION_BY_KEY[key].dependencies) - selected for key in selected):
        raise ValueError("Permission dependencies are missing")
    return sorted(selected)
