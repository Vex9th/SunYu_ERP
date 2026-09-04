ALTER TABLE document_versions ADD COLUMN managed_filename TEXT;

UPDATE document_versions
SET managed_filename = CASE
    WHEN length(trim(original_filename)) > 0 THEN original_filename
    ELSE 'legacy_document_' || id
END
WHERE managed_filename IS NULL;

CREATE TRIGGER document_versions_fill_managed_filename
AFTER INSERT ON document_versions
WHEN NEW.managed_filename IS NULL
BEGIN
    UPDATE document_versions
    SET managed_filename = CASE
        WHEN length(trim(NEW.original_filename)) > 0 THEN NEW.original_filename
        ELSE 'legacy_document_' || NEW.id
    END
    WHERE id = NEW.id;
END;

CREATE TRIGGER document_versions_reject_blank_managed_filename_insert
BEFORE INSERT ON document_versions
WHEN NEW.managed_filename IS NOT NULL
    AND length(trim(NEW.managed_filename)) = 0
BEGIN
    SELECT RAISE(ABORT, 'managed_filename must not be blank');
END;

CREATE TRIGGER document_versions_reject_invalid_managed_filename_update
BEFORE UPDATE OF managed_filename ON document_versions
WHEN NEW.managed_filename IS NULL OR length(trim(NEW.managed_filename)) = 0
BEGIN
    SELECT RAISE(ABORT, 'managed_filename must not be blank');
END;
