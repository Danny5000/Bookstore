CREATE OR REPLACE FUNCTION reject_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_reject_update
BEFORE UPDATE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_reject_delete
BEFORE DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();
