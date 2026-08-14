\set ON_ERROR_STOP on
\set QUIET on

create temporary table restore_row_counts (
  schema_name text not null,
  table_name text not null,
  row_count bigint not null,
  primary key (schema_name, table_name)
);

begin;
set transaction read only;
set local search_path = pg_catalog, public, drizzle;

do $capture$
declare
  relation record;
  exact_count bigint;
begin
  for relation in
    select n.nspname::text as schema_name, c.relname::text as table_name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'drizzle')
      and c.relkind in ('r', 'p')
    order by n.nspname::text collate "C", c.relname::text collate "C"
  loop
    execute format('select count(*) from %I.%I', relation.schema_name, relation.table_name)
      into exact_count;
    insert into restore_row_counts (schema_name, table_name, row_count)
    values (relation.schema_name, relation.table_name, exact_count);
  end loop;
end
$capture$;

copy (
  select schema_name, table_name, row_count
  from restore_row_counts
  order by schema_name collate "C", table_name collate "C"
) to stdout with (format csv, header true);

rollback;
