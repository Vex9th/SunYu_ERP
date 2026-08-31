CREATE INDEX idx_documents_project_active_category
    ON documents(project_code COLLATE NOCASE, archived_at, category COLLATE NOCASE);

CREATE INDEX idx_project_stages_project_status_sequence
    ON project_stages(project_id, status, sequence);

CREATE INDEX idx_project_stages_planned_end
    ON project_stages(status, planned_end_on, project_id);

CREATE INDEX idx_project_stage_events_stage_created
    ON project_stage_events(project_stage_id, created_at DESC, id DESC);

CREATE INDEX idx_quotes_project_status_version
    ON quotes(project_id, status, version_number DESC);

CREATE INDEX idx_contracts_status_delivery
    ON contracts(status, final_delivery_on, id);

CREATE INDEX idx_contract_allocations_project_contract
    ON contract_project_allocations(project_id, contract_id);

CREATE INDEX idx_payment_terms_project_due
    ON payment_terms(project_id, due_on, milestone);

CREATE INDEX idx_receipts_project_status_received
    ON receipts(project_id, status, received_on DESC, id DESC);

CREATE INDEX idx_receipts_allocation_status
    ON receipts(contract_allocation_id, status, id);

