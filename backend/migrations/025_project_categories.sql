ALTER TABLE projects ADD COLUMN project_category TEXT NOT NULL DEFAULT 'standard'
    CHECK (project_category IN ('standard', 'trade'));

DROP TRIGGER initialize_project_stages_after_insert;

CREATE TRIGGER initialize_project_stages_after_insert
AFTER INSERT ON projects
BEGIN
    INSERT INTO project_stages
        (project_id, stage_code, sequence, status, revision, created_at, updated_at)
    SELECT NEW.id, stage_code, sequence, 'pending', 1, NEW.created_at, NEW.updated_at
    FROM (
        SELECT 'planning' AS stage_code, 1 AS sequence
        UNION ALL SELECT 'site_survey', 2
        UNION ALL SELECT 'quotation', 3
        UNION ALL SELECT 'technical_agreement', 4
        UNION ALL SELECT 'contract', 5
        UNION ALL SELECT 'advance_payment', 6
        UNION ALL SELECT 'mechanical_design', 7
        UNION ALL SELECT 'electrical_design', 8
        UNION ALL SELECT 'procurement', 9
        UNION ALL SELECT 'staffing', 10
        UNION ALL SELECT 'mechanical_signoff', 11
        UNION ALL SELECT 'electrical_signoff', 12
        UNION ALL SELECT 'construction', 13
        UNION ALL SELECT 'progress_payment', 14
        UNION ALL SELECT 'commissioning', 15
        UNION ALL SELECT 'acceptance', 16
        UNION ALL SELECT 'final_payment', 17
        UNION ALL SELECT 'closeout', 18
    )
    WHERE NEW.project_category = 'standard';

    INSERT INTO project_stages
        (project_id, stage_code, sequence, status, revision, created_at, updated_at)
    SELECT NEW.id, stage_code, sequence, 'pending', 1, NEW.created_at, NEW.updated_at
    FROM (
        SELECT 'contract' AS stage_code, 1 AS sequence
        UNION ALL SELECT 'advance_payment', 2
        UNION ALL SELECT 'procurement', 3
        UNION ALL SELECT 'acceptance', 4
        UNION ALL SELECT 'final_payment', 5
    )
    WHERE NEW.project_category = 'trade';
END;
