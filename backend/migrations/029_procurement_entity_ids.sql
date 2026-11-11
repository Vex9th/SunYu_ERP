-- 独立保存已分配 ID 上限，避免删除最高行后 SQLite 复用其身份。
-- 只增加辅助表，既有业务行、外键及不可变操作记录保持原样。
CREATE TABLE entity_id_sequences (
    table_name TEXT PRIMARY KEY
        CHECK (table_name IN ('procurement_lines', 'purchase_order_lines')),
    last_id INTEGER NOT NULL CHECK (typeof(last_id) = 'integer' AND last_id >= 0)
);

INSERT INTO entity_id_sequences(table_name, last_id)
SELECT 'procurement_lines', COALESCE(MAX(identifier), 0)
FROM (
    SELECT id AS identifier FROM procurement_lines
    UNION ALL
    SELECT procurement_line_id FROM quote_export_lines
    UNION ALL
    SELECT CAST(resource_id AS INTEGER) FROM operation_events
        WHERE resource_type = 'procurement_line'
    UNION ALL
    SELECT resource_id FROM idempotency_requests WHERE resource_type = 'procurement_line'
    UNION ALL
    SELECT CAST(json_extract(line.value, '$.id') AS INTEGER)
        FROM idempotency_requests AS requests, json_each(requests.response_json, '$.lines') AS line
        WHERE requests.resource_type = 'procurement_list'
    UNION ALL
    SELECT CAST(json_extract(line.value, '$.id') AS INTEGER)
        FROM idempotency_requests AS requests,
             json_each(requests.response_json, '$.procurement_list.lines') AS line
        WHERE requests.resource_type = 'procurement_import'
);

INSERT INTO entity_id_sequences(table_name, last_id)
SELECT 'purchase_order_lines', COALESCE(MAX(identifier), 0)
FROM (
    SELECT id AS identifier FROM purchase_order_lines
    UNION ALL
    SELECT CAST(resource_id AS INTEGER) FROM operation_events
        WHERE resource_type = 'purchase_order_line'
    UNION ALL
    SELECT CAST(json_extract(line.value, '$.id') AS INTEGER)
        FROM idempotency_requests AS requests, json_each(requests.response_json, '$.lines') AS line
        WHERE requests.resource_type = 'purchase_order'
);
