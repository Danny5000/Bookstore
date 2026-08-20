DO $$
DECLARE
  resolver_oid oid;
BEGIN
  SELECT function_row.oid INTO resolver_oid
  FROM pg_catalog.pg_proc function_row
  WHERE function_row.oid = pg_catalog.to_regprocedure(
      'public.resolve_financial_reconciliation_issue(uuid,uuid,public.audit_actor_type,text,text)'
    )
    AND function_row.prokind = 'f';
  IF resolver_oid IS NOT NULL THEN
    EXECUTE pg_catalog.format('DROP FUNCTION %s', resolver_oid::pg_catalog.regprocedure);
  END IF;
END;
$$;
