from __future__ import annotations

from backend.app.features.api_common import ApiError
from backend.app.features.inventory import line_value

_SQLITE_MAX_INTEGER = 2**63 - 1


def validate_tax_rate(value: object) -> int | None:
    if value is None:
        return None
    if type(value) is not int or not 0 <= value <= 10000:
        raise ApiError(422, "Invalid purchase order payload", "VALIDATION_ERROR")
    return value


def gross_line_value(
    unit_cost_cents: int,
    quantity_milli: int,
    tax_amount_cents: int = 0,
    gross_unit_cost_cents: int | None = None,
) -> int:
    gross = (
        line_value(gross_unit_cost_cents, quantity_milli)
        if gross_unit_cost_cents is not None
        else line_value(unit_cost_cents, quantity_milli) + tax_amount_cents
    )
    if not 0 <= gross <= _SQLITE_MAX_INTEGER:
        raise ApiError(422, "Invalid purchase order payload", "VALIDATION_ERROR")
    return gross


def calculate_line_amounts(
    unit_cost_cents: int,
    quantity_milli: int,
    tax_rate_bps: int | None,
    gross_unit_cost_cents: int | None = None,
) -> dict[str, int]:
    rate = validate_tax_rate(tax_rate_bps)
    if gross_unit_cost_cents is not None:
        if (
            type(gross_unit_cost_cents) is not int
            or not 0 <= gross_unit_cost_cents <= _SQLITE_MAX_INTEGER
        ):
            raise ApiError(422, "Invalid purchase order payload", "VALIDATION_ERROR")
        divisor = 10000 + (rate or 0)
        expected_unit = (2 * gross_unit_cost_cents * 10000 + divisor) // (2 * divisor)
        if unit_cost_cents != expected_unit:
            raise ApiError(422, "Invalid purchase order payload", "VALIDATION_ERROR")
        # 含税报价是金额依据；不能将两位小数的未税单价再次加税。
        gross = line_value(gross_unit_cost_cents, quantity_milli)
        net = (2 * gross * 10000 + divisor) // (2 * divisor)
        return {
            "net_amount_cents": net,
            "tax_amount_cents": gross - net,
            "line_amount_cents": gross,
        }
    net = line_value(unit_cost_cents, quantity_milli)
    tax = (net * (rate or 0) + 5000) // 10000
    return {
        "net_amount_cents": net,
        "tax_amount_cents": tax,
        "line_amount_cents": gross_line_value(unit_cost_cents, quantity_milli, tax),
    }
