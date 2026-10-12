package api

// SQL statements retain the validated SQLite schema and business joins from the original implementation.
var procSQL = map[string]string{
	"procurement:_receipt_line_value:0": `SELECT COALESCE(SUM(lines.value_cents), 0)
        FROM goods_receipt_lines AS lines
        JOIN goods_receipts AS receipts ON receipts.id = lines.goods_receipt_id
        WHERE lines.purchase_order_line_id = ? AND receipts.status = 'active'`,
	"procurement:_line_facts:0": `SELECT
            COALESCE((
                SELECT SUM(order_lines.quantity_milli)
                FROM purchase_order_lines AS order_lines
                JOIN purchase_orders AS orders
                    ON orders.id = order_lines.purchase_order_id
                WHERE order_lines.procurement_line_id = procurement_lines.id
                  AND orders.status IN (
                      'confirmed', 'partially_received', 'received'
                  )
            ), 0) AS ordered_quantity_milli,
            COALESCE((
                SELECT SUM(receipt_lines.quantity_milli)
                FROM goods_receipt_lines AS receipt_lines
                JOIN goods_receipts AS receipts
                    ON receipts.id = receipt_lines.goods_receipt_id
                JOIN purchase_order_lines AS order_lines
                    ON order_lines.id = receipt_lines.purchase_order_line_id
                WHERE order_lines.procurement_line_id = procurement_lines.id
                  AND receipts.status = 'active'
            ), 0) AS received_quantity_milli,
            COALESCE((
                SELECT SUM(issue_lines.quantity_milli)
                FROM inventory_issue_lines AS issue_lines
                JOIN inventory_issues AS issues
                    ON issues.id = issue_lines.inventory_issue_id
                WHERE issue_lines.procurement_line_id = procurement_lines.id
                  AND issues.status = 'active'
            ), 0) AS used_quantity_milli,
            COALESCE((
                SELECT SUM(allocations.amount_cents)
                FROM supplier_payment_allocations AS allocations
                JOIN supplier_payments AS payments
                    ON payments.id = allocations.supplier_payment_id
                JOIN purchase_order_lines AS order_lines
                    ON order_lines.id = allocations.purchase_order_line_id
                WHERE order_lines.procurement_line_id = procurement_lines.id
                  AND payments.status = 'active'
            ), 0) AS paid_amount_cents,
            COALESCE((
                SELECT SUM(allocations.amount_cents)
                FROM supplier_invoice_allocations AS allocations
                JOIN supplier_invoices AS invoices
                    ON invoices.id = allocations.supplier_invoice_id
                JOIN purchase_order_lines AS order_lines
                    ON order_lines.id = allocations.purchase_order_line_id
                WHERE order_lines.procurement_line_id = procurement_lines.id
                  AND invoices.status = 'active'
            ), 0) AS invoiced_amount_cents
        FROM procurement_lines
        WHERE procurement_lines.id = ?`,
	"procurement:_line_facts:1": `SELECT order_lines.unit_cost_cents, order_lines.quantity_milli,
               order_lines.tax_amount_cents
        FROM purchase_order_lines AS order_lines
        JOIN purchase_orders AS orders ON orders.id = order_lines.purchase_order_id
        WHERE order_lines.procurement_line_id = ?
          AND orders.status IN ('confirmed', 'partially_received', 'received')`,
	"procurement:_order_response:0": `SELECT name FROM companies WHERE id = ?`,
	"procurement:_order_response:1": `SELECT document_version_id FROM purchase_order_documents
        WHERE purchase_order_id = ? ORDER BY document_version_id`,
	"procurement:_order_response:2": `SELECT * FROM supplier_payments
            WHERE purchase_order_id = ? ORDER BY id`,
	"procurement:_order_response:3": `SELECT * FROM supplier_invoices
            WHERE purchase_order_id = ? ORDER BY id`,
	"procurement:_order_response:4": `SELECT * FROM goods_receipts
            WHERE purchase_order_id = ? ORDER BY id`,
	"procurement:_receipt_response:0": `SELECT receipt_lines.*,
               procurement_lines.name AS material_name,
               procurement_lines.model AS material_model,
               procurement_lines.unit
        FROM goods_receipt_lines AS receipt_lines
        JOIN purchase_order_lines AS order_lines
          ON order_lines.id = receipt_lines.purchase_order_line_id
        JOIN procurement_lines
          ON procurement_lines.id = order_lines.procurement_line_id
        WHERE receipt_lines.goods_receipt_id = ?
        ORDER BY receipt_lines.id`,
	"procurement:_payment_response:0": `SELECT purchase_order_line_id, amount_cents
        FROM supplier_payment_allocations
        WHERE supplier_payment_id = ? ORDER BY purchase_order_line_id`,
	"procurement:_invoice_response:0": `SELECT purchase_order_line_id, amount_cents
        FROM supplier_invoice_allocations
        WHERE supplier_invoice_id = ? ORDER BY purchase_order_line_id`,
	"procurement:_invoice_response:1": `SELECT document_version_id FROM supplier_invoice_documents
        WHERE supplier_invoice_id = ? ORDER BY document_version_id`,
	"procurement:_refresh_order_receipt_status:0": `UPDATE purchase_orders
        SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
	"procurement:_refresh_order_receipt_status:1": `SELECT SUM(quantity_milli) AS ordered,
               SUM(received_quantity_milli) AS received
        FROM purchase_order_lines WHERE purchase_order_id = ?`,
	"procurement:_project:0":        `SELECT * FROM projects WHERE project_code_key = ?`,
	"procurement:_order_supplier:0": `SELECT id, name FROM companies WHERE id = ?`,
	"procurement:_list_row:0":       `SELECT * FROM procurement_lists WHERE id = ? AND project_id = ?`,
	"procurement:_line_row:0": `SELECT * FROM procurement_lines
        WHERE id = ? AND procurement_list_id = ?`,
	"procurement:_list_line_rows:0": `SELECT * FROM procurement_lines
        WHERE procurement_list_id = ? ORDER BY sequence_no, id`,
	"procurement:_project_line_quantities:0": `WITH ordered AS (
            SELECT ol.procurement_line_id, SUM(ol.quantity_milli) AS quantity
            FROM purchase_order_lines AS ol
            JOIN purchase_orders AS orders ON orders.id = ol.purchase_order_id
            WHERE orders.project_id = ?
              AND orders.status IN ('confirmed', 'partially_received', 'received')
            GROUP BY ol.procurement_line_id
        )
        SELECT lines.*, COALESCE(ordered.quantity, 0) AS ordered_quantity_milli
        FROM procurement_lines AS lines
        JOIN procurement_lists AS lists ON lists.id = lines.procurement_list_id
        LEFT JOIN ordered ON ordered.procurement_line_id = lines.id
        WHERE lists.project_id = ? AND (? = 0 OR lists.status = 'confirmed')
        ORDER BY lists.id, lines.sequence_no, lines.id`,
	"procurement:_project_line_rows:0": `SELECT lines.*
        FROM procurement_lines AS lines
        JOIN procurement_lists AS lists ON lists.id = lines.procurement_list_id
        WHERE lists.project_id = ? AND lists.status = 'confirmed'
        ORDER BY lists.id, lines.sequence_no, lines.id`,
	"procurement:_confirmed_procurement_line:0": `SELECT lines.*
        FROM procurement_lines AS lines
        JOIN procurement_lists AS lists ON lists.id = lines.procurement_list_id
        WHERE lines.id = ? AND lists.project_id = ? AND lists.status = 'confirmed'`,
	"procurement:_order_row:0": `SELECT * FROM purchase_orders WHERE id = ? AND project_id = ?`,
	"procurement:_order_lines:0": `SELECT * FROM purchase_order_lines
        WHERE purchase_order_id = ? ORDER BY id`,
	"procurement:list_procurement_lists:0": `SELECT lists.*, COUNT(lines.id) AS line_count
            FROM procurement_lists AS lists
            LEFT JOIN procurement_lines AS lines
                ON lines.procurement_list_id = lists.id
            WHERE lists.project_id = ?
            GROUP BY lists.id
            ORDER BY lists.created_at DESC, lists.id DESC
            LIMIT ? OFFSET ?`,
	"procurement:list_procurement_lists:1": `SELECT COUNT(*) FROM procurement_lists WHERE project_id = ?`,
	"procurement:create_procurement_list:0": `INSERT INTO procurement_lists
                    (project_id, name, notes, status, revision,
                     create_idempotency_key, create_request_hash,
                     created_at, updated_at)
                VALUES (?, ?, ?, 'draft', 1, ?, ?, ?, ?)`,
	"procurement:update_procurement_list:0": `UPDATE procurement_lists
                SET name = ?, notes = ?, revision = revision + 1, updated_at = ?
                WHERE id = ? AND revision = ?`,
	"procurement:create_procurement_line:0": `INSERT INTO procurement_lines
                        (procurement_list_id, inventory_item_id, sequence_no,
                         category, name, specification, brand, model,
                         quantity_milli, unit, unit_cost_cents,
                         quoted_unit_price_cents, revision,
                         create_idempotency_key, create_request_hash,
                         created_at, updated_at)
                    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
	"procurement:create_procurement_line:1": `UPDATE procurement_lists
                    SET revision = revision + 1, updated_at = ? WHERE id = ?`,
	"procurement:update_procurement_line:0": `UPDATE procurement_lines
                    SET inventory_item_id = ?, sequence_no = ?, category = ?, name = ?,
                        specification = ?, brand = ?, model = ?,
                        quantity_milli = ?, unit = ?, unit_cost_cents = ?,
                        quoted_unit_price_cents = ?, revision = revision + 1,
                        updated_at = ?
                    WHERE id = ? AND revision = ?`,
	"procurement:update_procurement_line:1": `UPDATE procurement_lists
                    SET revision = revision + 1, updated_at = ? WHERE id = ?`,
	"procurement:delete_procurement_line:0": `DELETE FROM procurement_lines
                WHERE id = ? AND procurement_list_id = ?`,
	"procurement:delete_procurement_line:1": `UPDATE procurement_lists
                SET revision = revision + 1, updated_at = ? WHERE id = ?`,
	"procurement:confirm_procurement_list:0": `UPDATE procurement_lists
                SET status = 'confirmed', confirmed_at = ?,
                    confirm_idempotency_key = ?, confirm_request_hash = ?,
                    revision = revision + 1, updated_at = ?
                WHERE id = ?`,
	"procurement:confirm_procurement_list:1": `SELECT 1 FROM procurement_lines WHERE procurement_list_id = ? LIMIT 1`,
	"procurement:copy_procurement_list_as_draft:0": `INSERT INTO procurement_lists
                    (project_id, name, notes, status, revision,
                     create_idempotency_key, create_request_hash,
                     created_at, updated_at)
                VALUES (?, ?, ?, 'draft', 1, ?, ?, ?, ?)`,
	"procurement:copy_procurement_list_as_draft:1": `INSERT INTO procurement_lines
                        (procurement_list_id, inventory_item_id, sequence_no,
                         category, name, specification, brand, model,
                         quantity_milli, unit, unit_cost_cents,
                         quoted_unit_price_cents, revision,
                         create_idempotency_key, create_request_hash,
                         created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
	"procurement:create_purchase_order:0": `INSERT INTO purchase_orders
                            (project_id, order_no, supplier_company_id, ordered_on,
                             expected_delivery_on, notes, tax_rate_bps, status, revision,
                             create_idempotency_key, create_request_hash,
                             created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?)`,
	"procurement:create_purchase_order:1": `INSERT INTO purchase_order_lines
                                (purchase_order_id, procurement_line_id,
                                 quantity_milli, received_quantity_milli,
                                 unit_cost_cents, tax_amount_cents, overage_reason, created_at)
                            VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
	"procurement:create_purchase_order:2": `INSERT INTO purchase_order_documents
                                (purchase_order_id, document_version_id)
                            VALUES (?, ?)`,
	"procurement:confirm_purchase_order:0": `UPDATE purchase_orders
                SET status = 'confirmed', confirmed_at = ?,
                    confirm_idempotency_key = ?, confirm_request_hash = ?,
                    revision = revision + 1, updated_at = ?
                WHERE id = ?`,
	"procurement:confirm_purchase_order:1": `SELECT COALESCE(SUM(order_lines.quantity_milli), 0)
                    FROM purchase_order_lines AS order_lines
                    JOIN purchase_orders AS orders
                        ON orders.id = order_lines.purchase_order_id
                    WHERE order_lines.procurement_line_id = ?
                      AND orders.status IN (
                          'confirmed', 'partially_received', 'received'
                      )`,
	"procurement:confirm_purchase_order:2": `SELECT quantity_milli FROM procurement_lines WHERE id = ?`,
	"procurement:create_goods_receipt:0": `INSERT INTO goods_receipts
                    (purchase_order_id, received_on, warehouse_name, notes,
                     status, revision, idempotency_key, request_hash,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
	"procurement:create_goods_receipt:1": `INSERT INTO goods_receipt_lines
                        (goods_receipt_id, purchase_order_line_id,
                         inventory_item_id, quantity_milli, value_cents,
                         movement_id)
                    VALUES (?, ?, ?, ?, ?, ?)`,
	"procurement:create_goods_receipt:2": `UPDATE purchase_order_lines
                    SET received_quantity_milli = received_quantity_milli + ?
                    WHERE id = ?`,
	"procurement:create_goods_receipt:3": `SELECT * FROM goods_receipts WHERE id = ?`,
	"procurement:create_goods_receipt:4": `SELECT order_lines.*, procurement_lines.inventory_item_id,
                           procurement_lines.name, procurement_lines.unit,
                           procurement_lines.brand, procurement_lines.model,
                           procurement_lines.specification
                    FROM purchase_order_lines AS order_lines
                    JOIN procurement_lines
                        ON procurement_lines.id = order_lines.procurement_line_id
                    WHERE order_lines.id = ?
                      AND order_lines.purchase_order_id = ?`,
	"procurement:get_procurement_options:0": `SELECT id, name, status, revision FROM procurement_lists WHERE project_id = ? ORDER BY id`,
	"procurement:get_procurement_overview:0": `SELECT order_lines.unit_cost_cents, order_lines.quantity_milli,
                   order_lines.tax_amount_cents
            FROM purchase_order_lines AS order_lines
            JOIN purchase_orders AS orders ON orders.id = order_lines.purchase_order_id
            WHERE orders.project_id = ?
              AND orders.status IN ('confirmed', 'partially_received', 'received')`,
	"procurement:get_procurement_overview:1": `SELECT COALESCE(SUM(receipt_lines.value_cents), 0)
            FROM goods_receipt_lines AS receipt_lines
            JOIN goods_receipts AS receipts
                ON receipts.id = receipt_lines.goods_receipt_id
            JOIN purchase_orders AS orders
                ON orders.id = receipts.purchase_order_id
            WHERE orders.project_id = ? AND receipts.status = 'active'`,
	"procurement:get_procurement_overview:2": `SELECT COALESCE(SUM(payments.amount_cents), 0)
            FROM supplier_payments AS payments
            JOIN purchase_orders AS orders ON orders.id = payments.purchase_order_id
            WHERE orders.project_id = ? AND payments.status = 'active'`,
	"procurement:get_procurement_overview:3": `SELECT COALESCE(SUM(invoices.amount_cents), 0)
            FROM supplier_invoices AS invoices
            JOIN purchase_orders AS orders ON orders.id = invoices.purchase_order_id
            WHERE orders.project_id = ? AND invoices.status = 'active'`,
	"procurement:get_procurement_overview:4": `SELECT COALESCE(SUM(total_cost_cents), 0)
            FROM inventory_issues
            WHERE project_id = ? AND status = 'active'`,
	"procurement_extensions:_reject_confirmed_import:0": `SELECT 1 FROM procurement_imports
        WHERE project_id = ? AND sha256 = ? AND status = 'confirmed'`,
	"procurement_extensions:_import_row:0":                `SELECT * FROM procurement_imports WHERE id = ? AND project_id = ?`,
	"procurement_extensions:_inventory_exact_matches:0":   `SELECT id, brand, name, model, specification, unit FROM inventory_items`,
	"procurement_extensions:_validate_order_references:0": `SELECT 1 FROM companies WHERE id = ?`,
	"procurement_extensions:_insert_order_lines:0": `INSERT INTO purchase_order_lines
                (purchase_order_id, procurement_line_id, quantity_milli,
                 received_quantity_milli, unit_cost_cents, tax_amount_cents, overage_reason, created_at)
            VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
	"procurement_extensions:_order_has_active_facts:0": `SELECT
            EXISTS(SELECT 1 FROM goods_receipts
                   WHERE purchase_order_id = ? AND status = 'active')
            OR EXISTS(SELECT 1 FROM supplier_payments
                      WHERE purchase_order_id = ? AND status = 'active')
            OR EXISTS(SELECT 1 FROM supplier_invoices
                      WHERE purchase_order_id = ? AND status = 'active')`,
	"procurement_extensions:_validate_allocation_capacity:0": `SELECT * FROM purchase_order_lines
            WHERE id = ? AND purchase_order_id = ?`,
	"procurement_extensions:_payment_row:0": `SELECT payments.*
        FROM supplier_payments AS payments
        JOIN purchase_orders AS orders ON orders.id = payments.purchase_order_id
        WHERE payments.id = ? AND orders.project_id = ?`,
	"procurement_extensions:_invoice_row:0": `SELECT invoices.*
        FROM supplier_invoices AS invoices
        JOIN purchase_orders AS orders ON orders.id = invoices.purchase_order_id
        WHERE invoices.id = ? AND orders.project_id = ?`,
	"procurement_extensions:_receipt_row:0": `SELECT receipts.*
        FROM goods_receipts AS receipts
        JOIN purchase_orders AS orders ON orders.id = receipts.purchase_order_id
        WHERE receipts.id = ? AND orders.project_id = ?`,
	"procurement_extensions:_reverse_receipt_inventory:0": `INSERT INTO inventory_movements
                (inventory_item_id, project_id, procurement_line_id,
                 movement_type, quantity_delta_milli, value_delta_cents,
                 quantity_after_milli, value_after_cents, source_type,
                 source_id, occurred_on, reason, created_at)
            VALUES (?, ?, ?, 'reversal', ?, ?, ?, ?,
                    'goods_receipt_reversal', ?, ?, ?, ?)`,
	"procurement_extensions:_reverse_receipt_inventory:1": `UPDATE inventory_items
            SET quantity_milli = ?, inventory_value_cents = ?,
                revision = revision + 1, updated_at = ?
            WHERE id = ? AND revision = ?`,
	"procurement_extensions:_reverse_receipt_inventory:2": `UPDATE purchase_order_lines
            SET received_quantity_milli = received_quantity_milli - ?
            WHERE id = ? AND received_quantity_milli >= ?`,
	"procurement_extensions:_reverse_receipt_inventory:3": `SELECT receipt_lines.*, order_lines.procurement_line_id
        FROM goods_receipt_lines AS receipt_lines
        JOIN purchase_order_lines AS order_lines
          ON order_lines.id = receipt_lines.purchase_order_line_id
        WHERE receipt_lines.goods_receipt_id = ? ORDER BY receipt_lines.id`,
	"procurement_extensions:_reverse_receipt_inventory:4": `SELECT * FROM inventory_items WHERE id = ?`,
	"procurement_extensions:_refresh_order_status_after_reversal:0": `UPDATE purchase_orders
        SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
	"procurement_extensions:_refresh_order_status_after_reversal:1": `SELECT COALESCE(SUM(quantity_milli), 0) AS ordered,
               COALESCE(SUM(received_quantity_milli), 0) AS received
        FROM purchase_order_lines WHERE purchase_order_id = ?`,
	"procurement_extensions:_quote_row:0": `SELECT exports.*, companies.name AS customer_company_name
        FROM quote_exports AS exports
        JOIN companies ON companies.id = exports.customer_company_id
        WHERE exports.id = ? AND exports.project_id = ?`,
	"procurement_extensions:_quote_workbook:0": `SELECT sequence_no, category, name, specification, brand, model,
               quantity_milli, unit, quoted_unit_price_cents
        FROM procurement_lines
        WHERE procurement_list_id = ? ORDER BY sequence_no, id`,
	"procurement_extensions:preview_procurement_import:0": `INSERT INTO procurement_imports
                            (project_id, filename, sha256, preview_json, status,
                             revision, expires_at, confirmed_list_id, created_at, updated_at)
                        VALUES (?, ?, ?, ?, 'preview', 1, ?, NULL, ?, ?)`,
	"procurement_extensions:preview_procurement_import:1": `SELECT * FROM procurement_imports
                    WHERE project_id = ? AND sha256 = ? AND status = 'preview'`,
	"procurement_extensions:preview_procurement_import:2": `UPDATE procurement_imports
                            SET filename = ?, preview_json = ?, revision = revision + 1,
                                expires_at = ?, updated_at = ?
                            WHERE id = ?`,
	"procurement_extensions:confirm_procurement_import:0": `INSERT INTO procurement_lists
                    (project_id, name, notes, status, revision,
                     create_idempotency_key, create_request_hash,
                     created_at, updated_at)
                VALUES (?, ?, NULL, 'draft', 1, ?, ?, ?, ?)`,
	"procurement_extensions:confirm_procurement_import:1": `UPDATE procurement_imports
                SET status = 'confirmed', revision = revision + 1,
                    confirmed_list_id = ?, updated_at = ?
                WHERE id = ? AND revision = ?`,
	"procurement_extensions:confirm_procurement_import:2": `INSERT INTO procurement_lines
                        (procurement_list_id, inventory_item_id, sequence_no,
                         category, name, specification, brand, model,
                         quantity_milli, unit, unit_cost_cents,
                         quoted_unit_price_cents, revision,
                         create_idempotency_key, create_request_hash,
                         created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
	"procurement_extensions:update_purchase_order:0": `UPDATE purchase_orders
                    SET order_no = ?, supplier_company_id = ?, ordered_on = ?,
                        expected_delivery_on = ?, notes = ?, tax_rate_bps = ?, revision = revision + 1,
                        updated_at = ?
                    WHERE id = ? AND revision = ?`,
	"procurement_extensions:update_purchase_order:1": `DELETE FROM purchase_order_documents WHERE purchase_order_id = ?`,
	"procurement_extensions:update_purchase_order:2": `DELETE FROM purchase_order_lines WHERE purchase_order_id = ?`,
	"procurement_extensions:update_purchase_order:3": `INSERT INTO purchase_order_documents
                            (purchase_order_id, document_version_id)
                        VALUES (?, ?)`,
	"procurement_extensions:cancel_purchase_order:0": `UPDATE purchase_orders
                SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?,
                    revision = revision + 1, updated_at = ?
                WHERE id = ? AND revision = ?`,
	"procurement_extensions:create_supplier_payment:0": `INSERT INTO supplier_payments
                    (purchase_order_id, paid_on, amount_cents, payment_method,
                     reference_no, notes, status, revision, idempotency_key,
                     request_hash, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
	"procurement_extensions:create_supplier_payment:1": `INSERT INTO supplier_payment_allocations
                        (supplier_payment_id, purchase_order_line_id, amount_cents)
                    VALUES (?, ?, ?)`,
	"procurement_extensions:reverse_supplier_payment:0": `UPDATE supplier_payments
                SET status = 'reversed', reversal_reason = ?, reversed_at = ?,
                    revision = revision + 1, updated_at = ?
                WHERE id = ? AND revision = ?`,
	"procurement_extensions:create_supplier_invoice:0": `INSERT INTO supplier_invoices
                            (purchase_order_id, invoice_no, invoiced_on, amount_cents,
                             status, revision, idempotency_key, request_hash,
                             created_at, updated_at)
                        VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
	"procurement_extensions:create_supplier_invoice:1": `INSERT INTO supplier_invoice_allocations
                                (supplier_invoice_id, purchase_order_line_id, amount_cents)
                            VALUES (?, ?, ?)`,
	"procurement_extensions:create_supplier_invoice:2": `INSERT INTO supplier_invoice_documents
                                (supplier_invoice_id, document_version_id)
                            VALUES (?, ?)`,
	"procurement_extensions:reverse_supplier_invoice:0": `UPDATE supplier_invoices
                SET status = 'reversed', reversal_reason = ?, reversed_at = ?,
                    revision = revision + 1, updated_at = ?
                WHERE id = ? AND revision = ?`,
	"procurement_extensions:reverse_goods_receipt:0": `UPDATE goods_receipts
                SET status = 'reversed', reversal_reason = ?, reversed_at = ?,
                    revision = revision + 1, updated_at = ?
                WHERE id = ? AND revision = ?`,
	"procurement_extensions:create_quote_export:0": `INSERT INTO quote_exports
                    (project_id, procurement_list_id, title, customer_company_id,
                     notes, document_version_id, idempotency_key, request_hash,
                     created_at)
                VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
	"procurement_extensions:create_quote_export:1": `SELECT 1 FROM companies WHERE id = ?`,
	"procurement_extensions:list_quote_exports:0": `SELECT exports.*, companies.name AS customer_company_name
            FROM quote_exports AS exports
            JOIN companies ON companies.id = exports.customer_company_id
            WHERE exports.project_id = ?
            ORDER BY exports.created_at DESC, exports.id DESC
            LIMIT ? OFFSET ?`,
	"procurement_extensions:list_quote_exports:1": `SELECT COUNT(*) FROM quote_exports WHERE project_id = ?`,
	"procurement_extensions:process_workbook:0": `INSERT INTO procurement_imports
                            (project_id, filename, sha256, preview_json, status,
                             revision, expires_at, confirmed_list_id, created_at, updated_at)
                        VALUES (?, ?, ?, ?, 'preview', 1, ?, NULL, ?, ?)`,
	"procurement_extensions:process_workbook:1": `SELECT * FROM procurement_imports
                    WHERE project_id = ? AND sha256 = ? AND status = 'preview'`,
	"procurement_extensions:process_workbook:2": `UPDATE procurement_imports
                            SET filename = ?, preview_json = ?, revision = revision + 1,
                                expires_at = ?, updated_at = ?
                            WHERE id = ?`,
	"inventory:ensure_receipt_inventory_item:0": `UPDATE procurement_lines SET inventory_item_id = ? WHERE id = ?`,
	"inventory:ensure_receipt_inventory_item:1": `INSERT INTO inventory_items
                (brand, name, model, specification, unit, notes,
                 quantity_milli, inventory_value_cents, revision,
                 create_idempotency_key, create_request_hash,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, NULL, 0, 0, 1, ?, ?, ?, ?)`,
	"inventory:ensure_receipt_inventory_item:2": `SELECT * FROM inventory_items
        WHERE name = ? COLLATE NOCASE
          AND unit = ? COLLATE NOCASE
          AND brand IS ?
          AND model IS ?
          AND specification IS ?
        ORDER BY id
        LIMIT 2`,
	"inventory:_reverse_issue_inventory:0": `SELECT * FROM inventory_issue_lines
        WHERE inventory_issue_id = ? ORDER BY id`,
	"inventory:_post_issue_line:0": `INSERT INTO inventory_issue_lines
            (inventory_issue_id, inventory_item_id, procurement_line_id,
             quantity_milli, cost_cents, movement_id)
        VALUES (?, ?, ?, ?, ?, ?)`,
	"inventory:_post_issue_line:1": `SELECT lines.id, lines.quantity_milli, lines.inventory_item_id
            FROM procurement_lines AS lines
            JOIN procurement_lists AS lists ON lists.id = lines.procurement_list_id
            WHERE lines.id = ? AND lists.project_id = ?`,
	"inventory:_post_issue_line:2": `SELECT COALESCE(SUM(lines.quantity_milli), 0)
            FROM inventory_issue_lines AS lines
            JOIN inventory_issues AS issues ON issues.id = lines.inventory_issue_id
            WHERE lines.procurement_line_id = ? AND issues.status = 'active'`,
	"inventory:_insert_movement:0": `INSERT INTO inventory_movements
            (inventory_item_id, project_id, procurement_line_id, movement_type,
             quantity_delta_milli, value_delta_cents, quantity_after_milli,
             value_after_cents, source_type, source_id, occurred_on, reason,
             created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	"inventory:_update_balance:0": `UPDATE inventory_items
        SET quantity_milli = ?, inventory_value_cents = ?,
            revision = revision + 1, updated_at = ?
        WHERE id = ?`,
	"inventory:_adjustment_response:0": `SELECT * FROM inventory_movements WHERE id = ?`,
	"inventory:_adjustment_response:1": `SELECT * FROM inventory_movements WHERE id = ?`,
	"inventory:_issue_response:0": `SELECT * FROM inventory_issue_lines
        WHERE inventory_issue_id = ? ORDER BY id`,
	"inventory:_item_row:0":          `SELECT * FROM inventory_items WHERE id = ?`,
	"inventory:_adjustment_row:0":    `SELECT * FROM inventory_adjustments WHERE id = ?`,
	"inventory:_project_issue_row:0": `SELECT * FROM inventory_issues WHERE id = ? AND project_id = ?`,
	"inventory:_active_project:0":    `SELECT id, status FROM projects WHERE project_code_key = ?`,
	"inventory:_table_exists:0":      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
	"inventory:create_inventory_item:0": `INSERT INTO inventory_items
                    (brand, name, model, specification, unit, notes,
                     quantity_milli, inventory_value_cents, revision,
                     create_idempotency_key, create_request_hash,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
	"inventory:get_inventory_item:0": `SELECT movements.*, projects.project_code,
                   issues.status AS issue_status,
                   issues.revision AS issue_revision,
                   adjustments.status AS adjustment_status,
                   adjustments.revision AS adjustment_revision
            FROM inventory_movements AS movements
            LEFT JOIN projects ON projects.id = movements.project_id
            LEFT JOIN inventory_issues AS issues
              ON issues.id = movements.source_id
             AND movements.source_type IN (
                 'inventory_issue', 'inventory_issue_reversal'
             )
            LEFT JOIN inventory_adjustments AS adjustments
              ON adjustments.id = movements.source_id
             AND movements.source_type = 'inventory_adjustment'
            WHERE movements.inventory_item_id = ?
            ORDER BY movements.created_at DESC, movements.id DESC
            LIMIT 20`,
	"inventory:update_inventory_item:0": `UPDATE inventory_items
                SET brand = ?, name = ?, model = ?, specification = ?,
                    unit = ?, notes = ?, revision = revision + 1, updated_at = ?
                WHERE id = ? AND revision = ?`,
	"inventory:list_inventory_movements:0": `SELECT movements.*, projects.project_code,
                   issues.status AS issue_status,
                   issues.revision AS issue_revision,
                   adjustments.status AS adjustment_status,
                   adjustments.revision AS adjustment_revision
            FROM inventory_movements AS movements
            LEFT JOIN projects ON projects.id = movements.project_id
            LEFT JOIN inventory_issues AS issues
              ON issues.id = movements.source_id
             AND movements.source_type IN (
                 'inventory_issue', 'inventory_issue_reversal'
             )
            LEFT JOIN inventory_adjustments AS adjustments
              ON adjustments.id = movements.source_id
             AND movements.source_type = 'inventory_adjustment'
            WHERE movements.inventory_item_id = ?
            ORDER BY movements.created_at DESC, movements.id DESC
            LIMIT ? OFFSET ?`,
	"inventory:list_inventory_movements:1": `SELECT COUNT(*) FROM inventory_movements WHERE inventory_item_id = ?`,
	"inventory:create_inventory_adjustment:0": `INSERT INTO inventory_adjustments
                    (inventory_item_id, quantity_delta_milli, unit_cost_cents,
                     value_delta_cents, occurred_on, reason, idempotency_key,
                     request_hash, movement_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
	"inventory:create_inventory_adjustment:1": `UPDATE inventory_adjustments SET movement_id = ? WHERE id = ?`,
	"inventory:create_inventory_adjustment:2": `SELECT * FROM inventory_adjustments WHERE idempotency_key = ?`,
	"inventory:create_inventory_adjustment:3": `SELECT * FROM inventory_adjustments WHERE id = ?`,
	"inventory:reverse_inventory_adjustment:0": `UPDATE inventory_adjustments
                SET status = 'reversed', reversal_reason = ?, reversed_at = ?,
                    reversal_movement_id = ?, revision = revision + 1
                WHERE id = ? AND status = 'active' AND revision = ?`,
	"inventory:create_project_issue:0": `INSERT INTO inventory_issues
                    (project_id, issued_on, worker_id, notes, status,
                     total_cost_cents, revision, idempotency_key, request_hash,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, 'active', 0, 1, ?, ?, ?, ?)`,
	"inventory:create_project_issue:1": `UPDATE inventory_issues SET total_cost_cents = ? WHERE id = ?`,
	"inventory:create_project_issue:2": `SELECT * FROM inventory_issues WHERE id = ?`,
	"inventory:create_project_issue:3": `SELECT 1 FROM workers WHERE id = ?`,
	"inventory:reverse_project_issue:0": `UPDATE inventory_issues
                SET status = 'reversed', revision = revision + 1, updated_at = ?
                WHERE id = ? AND status = 'active' AND revision = ?`,
}
