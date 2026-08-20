\set ON_ERROR_STOP on
\set QUIET on

create temporary table restore_financial_checks (
  check_name text primary key,
  violation_count bigint not null
);

begin;
set transaction read only;
set local search_path = pg_catalog, public, drizzle;

-- BEGIN financial_schema_object_manifest
-- Versioned exact catalog contract for journal entries with idx >= 7 through current.
-- Standalone explicit CREATE INDEX objects are pinned below. Every protected table descriptor
-- also pins sorted full constraint, non-constraint-owned index, and noninternal trigger
-- inventories. Constraint-owned indexes are represented by their constraints, with the
-- primary key repeated as a dedicated table-shape field.
insert into restore_financial_checks (check_name, violation_count)
with catalog_contract_version(contract_version) as (values
  ('plan6b-financial-catalog-v1')
), required_catalog_objects(
  object_kind, schema_name, parent_name, object_name, identity_arguments,
  expected_fingerprint_sha256, expected_catalog
) as (values
  ('column', 'public', 'disputes', 'financial_evidence_status', null, '0da968cc4001f7b9aab6eb56921d27a8622523b09a2c1596319dc79b897e700b', $catalog${"acl": [], "name": "financial_evidence_status", "type": "financial_evidence_status", "default": "'pending'::financial_evidence_status", "identity": "", "not_null": true, "collation": null, "generated": ""}$catalog$::jsonb),
  ('column', 'public', 'entitlement_grants', 'recovery_refund_allocation_id', null, '755c40d87e841356d6ed6f03cf84cee896d4b5b4ec740428b3c60eb56c685c9d', $catalog${"acl": [], "name": "recovery_refund_allocation_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}$catalog$::jsonb),
  ('column', 'public', 'entitlement_grants', 'source', null, 'e4659ec2dbf5361dd9f6f61f10c9ab104d1a8af3c5ffcd4bce4bfadb24e2cc99', $catalog${"acl": [], "name": "source", "type": "entitlement_grant_source", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}$catalog$::jsonb),
  ('column', 'public', 'jobs', 'rerun_requested_at', null, '0c5f8a495f0d8d4604fae7db003eee8f180641a1e4daf2d3499fcc0677c5ebaa', $catalog${"acl": [], "name": "rerun_requested_at", "type": "timestamp with time zone", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}$catalog$::jsonb),
  ('column', 'public', 'payments', 'financial_evidence_status', null, '0da968cc4001f7b9aab6eb56921d27a8622523b09a2c1596319dc79b897e700b', $catalog${"acl": [], "name": "financial_evidence_status", "type": "financial_evidence_status", "default": "'pending'::financial_evidence_status", "identity": "", "not_null": true, "collation": null, "generated": ""}$catalog$::jsonb),
  ('column', 'public', 'refunds', 'allocation_status', null, '7c086a1fa1583e8bb4116eff85250b6199e56da2de16b98164156aa1c4cfb9e7', $catalog${"acl": [], "name": "allocation_status", "type": "refund_allocation_status", "default": "'not_applicable'::refund_allocation_status", "identity": "", "not_null": true, "collation": null, "generated": ""}$catalog$::jsonb),
  ('column', 'public', 'refunds', 'financial_evidence_status', null, '0da968cc4001f7b9aab6eb56921d27a8622523b09a2c1596319dc79b897e700b', $catalog${"acl": [], "name": "financial_evidence_status", "type": "financial_evidence_status", "default": "'pending'::financial_evidence_status", "identity": "", "not_null": true, "collation": null, "generated": ""}$catalog$::jsonb),
  ('constraint', 'public', 'commerce_claim_issuances', 'commerce_claim_issuances_anchor_order_id_orders_id_fk', null, 'd0e33017c8b08185f6e0f430303113b9721e9e25cd230745c381648a4c8ab08d', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (anchor_order_id) REFERENCES orders(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'commerce_claim_issuances', 'commerce_claim_issuances_auth_token_sha256_valid', null, '48968956eadb306e911c5710eb987f450b64bce0b6f38fe4d40efa8422f27433', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((auth_token_sha256 IS NULL) OR (auth_token_sha256 ~ '^[a-f0-9]{64}$'::text)))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'commerce_claim_issuances', 'commerce_claim_issuances_authorized_user_id_user_id_fk', null, '6cb5a1fe31ac834ecce43523db07d1ab60de09905e00db40b4a18c149ce926d7', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (authorized_user_id) REFERENCES \"user\"(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'commerce_claim_issuances', 'commerce_claim_issuances_claim_proof_sha256_valid', null, '3a0ee01aba40ac69eb77660ed637dfe11325becac903cbc2cec1fae3b0b53155', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((claim_proof_sha256 ~ '^[a-f0-9]{64}$'::text))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'commerce_claim_issuances', 'commerce_claim_issuances_email_normalized', null, '65c514525abca807f7a02df1b3c51c62084ace45102b59b373710e6bcffdc410', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((normalized_email IS NULL) OR (normalized_email = lower(btrim(normalized_email)))))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'commerce_claim_issuances', 'commerce_claim_issuances_kind_valid', null, '94e5c5bf8899bda4893c1e2a65bc82e05bdc1a93cca317e9e02b3e85d263f2cd', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((kind = ANY (ARRAY['password-reset'::text, 'commerce-magic'::text])))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'commerce_claim_issuances', 'commerce_claim_issuances_lifecycle_consistent', null, '83243ba28fc89228de3f7974686a82cadcfaed32aab18c0da1ebcebf8bb9de92', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((state = 'issued'::text) AND (auth_token_sha256 IS NOT NULL) AND (normalized_email IS NOT NULL) AND (anchor_order_id IS NOT NULL) AND (authorized_user_id IS NULL) AND (authorized_at IS NULL) AND (consumed_at IS NULL) AND (result_disposition IS NULL) AND (result_changed IS NULL) AND (result_order_count IS NULL) AND (result_title_count IS NULL)) OR ((state = 'authorized'::text) AND (auth_token_sha256 IS NOT NULL) AND (normalized_email IS NOT NULL) AND (anchor_order_id IS NOT NULL) AND (authorized_user_id IS NOT NULL) AND (authorized_at IS NOT NULL) AND (consumed_at IS NULL) AND (result_disposition IS NULL) AND (result_changed IS NULL) AND (result_order_count IS NULL) AND (result_title_count IS NULL)) OR ((state = 'consumed'::text) AND (auth_token_sha256 IS NULL) AND (normalized_email IS NULL) AND (anchor_order_id IS NULL) AND (authorized_user_id IS NULL) AND (authorized_at IS NOT NULL) AND (consumed_at IS NOT NULL) AND (result_disposition IS NOT NULL) AND (result_changed IS NOT NULL) AND (result_order_count IS NOT NULL) AND (result_title_count IS NOT NULL))))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'commerce_claim_issuances', 'commerce_claim_issuances_pkey', null, 'c5f0b80ad0785302d6ad9c8962f258e0d48af669fa9209c153d0a863501dda5b', $catalog${"type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (claim_proof_sha256)", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'commerce_claim_issuances', 'commerce_claim_issuances_result_valid', null, '520c3aa60d619666a1f1dd3e1e49a5462e7fd97907dfdc49379ac98433114f70', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((result_disposition IS NULL) AND (result_changed IS NULL) AND (result_order_count IS NULL) AND (result_title_count IS NULL)) OR ((result_disposition = ANY (ARRAY['claimed'::text, 'not_eligible'::text, 'definitive_invalid'::text, 'identity_conflict'::text])) AND (result_changed IS NOT NULL) AND (result_order_count IS NOT NULL) AND (result_order_count >= 0) AND (result_title_count IS NOT NULL) AND (result_title_count >= 0) AND (((result_disposition = 'claimed'::text) AND (result_order_count > 0) AND (result_title_count > 0)) OR ((result_disposition <> 'claimed'::text) AND (NOT result_changed) AND (result_order_count = 0) AND (result_title_count = 0))))))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'commerce_claim_issuances', 'commerce_claim_issuances_timestamp_order', null, '44343ce75929544983c8a204a1c068a6660fcc811e610fc41bb5bc73ea8b6711', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((expires_at > issued_at) AND ((authorized_at IS NULL) OR (authorized_at >= issued_at)) AND ((consumed_at IS NULL) OR (consumed_at >= authorized_at))))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'dispute_item_allocations', 'dispute_item_allocations_dispute_id_disputes_id_fk', null, '030387d8d638ad2cd81bf033ceaa7f88abc3d237a7d57feba092a6e0e9c7d362', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (dispute_id) REFERENCES disputes(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'dispute_item_allocations', 'dispute_item_allocations_gross_set_graph_fk', null, 'd6740fe6fbadc66ae952536c6fb8cdb2f97a7d59e1a9d378249c05d2fa7feb62', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (gross_allocation_set_id, dispute_id) REFERENCES financial_allocation_sets(id, source_internal_id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'dispute_item_allocations', 'dispute_item_allocations_order_item_id_order_items_id_fk', null, '29d049861fb32946783cfb172c3540f8d096f75a5a10b2c36c3a70d1caaa788f', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'dispute_item_allocations', 'dispute_item_allocations_reverses_allocation_id_dispute_item_allocations_id_fk', null, 'ef48e99fb72acc27eabbd17358cfaf70188f2634106fc703f9fdbcf54f53c56e', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (reverses_allocation_id) REFERENCES dispute_item_allocations(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'disputes', 'disputes_amount_positive', null, '4290ffbdbfc129d258c54c67f4815ff6b4a646c84c0653f52fed5e80630a1772', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((amount_minor > 0))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'entitlement_grants', 'entitlement_grants_purchase_provenance_unique', null, 'ed4bd3458d2080deb3eb89ddd9bd3a998662c3af108ecec4a2bde56e20c86d79', $catalog${"type": "u", "enforced": true, "validated": true, "deferrable": false, "definition": "UNIQUE (id, order_item_id)", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'entitlement_grants', 'entitlement_grants_recovery_refund_allocation_id_refund_allocations_id_fk', null, 'b48d8213b6a0a73d9e75f4e1d04c88fea0a3ad3d4a05026bb1afca6d1604b01f', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (recovery_refund_allocation_id) REFERENCES refund_allocations(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'entitlement_grants', 'grants_source_consistent', null, '80134c4aae4a7ff25d5d5bfdfffd68430d855d0a655611de6d09e6737a7ef041', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((source = 'purchase'::entitlement_grant_source) AND (order_item_id IS NOT NULL) AND (recovery_refund_allocation_id IS NULL) AND ((state_reason)::text <> 'refund_allocation_recovery'::text)) OR ((source = 'preserved'::entitlement_grant_source) AND (user_id IS NOT NULL) AND (order_item_id IS NULL) AND (recovery_refund_allocation_id IS NULL) AND ((state_reason)::text <> 'refund_allocation_recovery'::text)) OR ((source = 'administrative'::entitlement_grant_source) AND (user_id IS NOT NULL) AND (order_item_id IS NULL) AND (recovery_refund_allocation_id IS NOT NULL) AND ((state_reason)::text = 'refund_allocation_recovery'::text) AND (state = ANY (ARRAY['active'::entitlement_grant_status, 'revoked'::entitlement_grant_status])))))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'financial_allocation_sets', 'financial_allocation_sets_balance_transaction_id_stripe_balance_transactions_id_fk', null, '1fcf82ba3524564a78d842ed11ae229a05d06dd59869f9e922f3faf9049b7a3c', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (balance_transaction_id) REFERENCES stripe_balance_transactions(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'financial_allocation_sets', 'financial_allocation_sets_reversal_graph_fk', null, '9bf1e1bb34f3b0dbdf6866d1405b50570be6749da658ff222315b16ea9fc1640', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (reversal_of_set_id, source_kind, source_internal_id, basis, currency) REFERENCES financial_allocation_sets(id, source_kind, source_internal_id, basis, currency) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'financial_allocation_sets', 'financial_allocation_sets_reversal_of_set_id_financial_allocation_sets_id_fk', null, '2feaeb58f8b13be91749324f62952cb446dd6cb955f7622af7923b18f87fd987', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (reversal_of_set_id) REFERENCES financial_allocation_sets(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'financial_allocation_sets', 'financial_allocation_sets_supersedes_graph_fk', null, '8072b580943baa585ade1eb255b7d408f915993e8dfb69b08d4828a40f659a2a', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (supersedes_set_id, balance_transaction_id, basis, currency, expected_effect_minor, source_fingerprint_sha256) REFERENCES financial_allocation_sets(id, balance_transaction_id, basis, currency, expected_effect_minor, source_fingerprint_sha256) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'financial_allocation_sets', 'financial_allocation_sets_supersedes_set_id_financial_allocation_sets_id_fk', null, '70bd101224356ad350ef5191a07b0eb2642b15e5d2480a7bb4b86215c4a40d1e', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (supersedes_set_id) REFERENCES financial_allocation_sets(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'financial_item_allocations', 'financial_item_allocations_allocation_set_id_financial_allocation_sets_id_fk', null, '9c32963597e533e2b9f29e3ba9dadab727b1d34a252b7581da97c49087347bfd', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (allocation_set_id) REFERENCES financial_allocation_sets(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'financial_item_allocations', 'financial_item_allocations_order_item_id_order_items_id_fk', null, '29d049861fb32946783cfb172c3540f8d096f75a5a10b2c36c3a70d1caaa788f', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'financial_reconciliation_issues', 'financial_reconciliation_issues_immutable_classification_open', null, '02c416dd408cd255d1be65cf5c3884c504cdbece8a1673d730b893f303655b4f', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((resource_type)::text <> 'financial_classification'::text) OR ((safe_code)::text <> 'unsupported_category'::text) OR (state = 'open'::financial_issue_state)))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'financial_reconciliation_issues', 'financial_reconciliation_issues_observation_order', null, 'ef99e794e0dd0a436db5e59dfe04c079425e217a2ac54f6285fa1a13bfc6a3cb', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((last_observed_at >= first_observed_at))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'financial_reconciliation_issues', 'financial_reconciliation_issues_occurrence_positive', null, 'b874ee3d952463c128d000170204b487f9a3eb94ed8e29b4bc9394f97824e0e0', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((occurrence_count > 0))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'financial_reconciliation_issues', 'financial_reconciliation_issues_resolution_consistent', null, '17588bf1708e33c6dee952e249b2ccd623e2371960ddedccf8c0234357e7a7f8', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((state = 'resolved'::financial_issue_state) = (resolved_at IS NOT NULL)) AND ((resolved_by_admin_id IS NULL) OR (state = 'resolved'::financial_issue_state))))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'financial_reconciliation_issues', 'financial_reconciliation_issues_resolved_by_admin_id_user_id_fk', null, '02794ed0b6a4c3f8ff664e65dc976bb593d46c7e1a27f95cb36258072043cc8f', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (resolved_by_admin_id) REFERENCES \"user\"(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'financial_reconciliation_issues', 'financial_reconciliation_issues_safe_vocabulary', null, 'a316c30225d3fc7cce55a670d34f0c1f6e5f91e70518e6e7831599d95f1674f3', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((resource_type)::text ~ '^[a-z0-9_]{1,50}$'::text) AND ((safe_code)::text ~ '^[a-z0-9_]{1,100}$'::text) AND ((char_length((correlation_id)::text) >= 1) AND (char_length((correlation_id)::text) <= 100))))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'financial_reconciliation_issues', 'financial_reconciliation_issues_semantic_identity', null, '9e059f4cec379243bf7163d01d550dbfcf85d9b97c03efe53b5159374d60a655', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((((resource_type)::text = ANY ((ARRAY['payment'::character varying, 'refund'::character varying, 'dispute'::character varying, 'allocation_set'::character varying])::text[])) AND ((safe_code)::text = ANY ((ARRAY['allocation_fork'::character varying, 'allocation_incomplete'::character varying, 'allocation_mismatch'::character varying, 'classification_fork'::character varying, 'correction_rebase_required'::character varying, 'currency_mismatch'::character varying, 'immutable_mismatch'::character varying, 'missing_source'::character varying, 'source_linkage_mismatch'::character varying, 'unsupported_category'::character varying])::text[]))) OR (((resource_type)::text = 'payout'::text) AND ((safe_code)::text = ANY ((ARRAY['currency_mismatch'::character varying, 'generation_exhausted'::character varying, 'immutable_mismatch'::character varying, 'payout_membership_conflict'::character varying, 'payout_reversal_incomplete'::character varying])::text[]))) OR (((resource_type)::text = 'balance_transaction'::text) AND ((safe_code)::text = ANY ((ARRAY['classification_fork'::character varying, 'immutable_mismatch'::character varying])::text[]))) OR (((resource_type)::text = 'financial_classification'::text) AND ((safe_code)::text = 'unsupported_category'::text))))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'financial_reconciliation_issues', 'financial_reconciliation_issues_semantic_impact', null, 'c580522ccccd156b91d3f2c8cf4772f022d8aaa3d223564efd1b43c39de46604', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((((safe_code)::text = ANY ((ARRAY['allocation_incomplete'::character varying, 'missing_source'::character varying])::text[])) AND (impact = 'pending'::financial_issue_impact)) OR (((safe_code)::text <> ALL ((ARRAY['allocation_incomplete'::character varying, 'missing_source'::character varying])::text[])) AND (impact = 'exception'::financial_issue_impact))))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'jobs', 'jobs_rerun_requires_running', null, 'b3bdc8edeed28d10af09d955ca836a641232200c475f83173a25579f69499cc6', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((rerun_requested_at IS NULL) OR (status = 'running'::job_status)))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'payout_import_run_entries', 'payout_import_run_entries_balance_transaction_id_stripe_balance_transactions_id_fk', null, '1fcf82ba3524564a78d842ed11ae229a05d06dd59869f9e922f3faf9049b7a3c', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (balance_transaction_id) REFERENCES stripe_balance_transactions(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'payout_import_run_entries', 'payout_import_run_entries_run_id_payout_import_runs_id_fk', null, '519fc54a27a8da2583fab534983aad38cf5dab8b3132669c2601a060b73e69db', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (run_id) REFERENCES payout_import_runs(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'payout_import_runs', 'payout_import_runs_payout_id_stripe_payouts_id_fk', null, 'dbc53ab0c9e90975b83e70acfca63511ed6276ac7e0a905ecee3a9181e8be543', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (payout_id) REFERENCES stripe_payouts(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_allocation_components', 'refund_allocation_components_graph_fk', null, '61514d236f4f284ae4b5fc7049bb074442635b5940b69422d32221ec2f03dff9', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (refund_allocation_id, refund_id, order_item_id) REFERENCES refund_allocations(id, refund_id, order_item_id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_allocation_draft_items', 'refund_allocation_draft_items_draft_id_refund_allocation_drafts_id_fk', null, '375898d6bc9eb808adfba0620e1ef4ce9a664d24620f383e1ce214bd0eaeaf30', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (draft_id) REFERENCES refund_allocation_drafts(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_allocation_draft_items', 'refund_allocation_draft_items_order_item_id_order_items_id_fk', null, '29d049861fb32946783cfb172c3540f8d096f75a5a10b2c36c3a70d1caaa788f', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_allocation_drafts', 'refund_allocation_drafts_created_by_admin_id_user_id_fk', null, 'c0a4eba1c20bbf52c33fce43f3877e7c8a839101cae13970be0943afd795a01f', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (created_by_admin_id) REFERENCES \"user\"(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_allocation_drafts', 'refund_allocation_drafts_refund_id_refunds_id_fk', null, '02244c102ecaf6697139b3fc075e8fc59e2045c2699c91ac74921aa2efd94fe5', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (refund_id) REFERENCES refunds(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_allocation_drafts', 'refund_allocation_drafts_updated_by_admin_id_user_id_fk', null, 'fff2bab6edba0a26e81a7cd02766e348895e4d3fae00ba361fdad7784ef31938', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (updated_by_admin_id) REFERENCES \"user\"(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_allocation_finalization_effects', 'refund_allocation_finalization_effects_allocation_graph_fk', null, '61514d236f4f284ae4b5fc7049bb074442635b5940b69422d32221ec2f03dff9', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (refund_allocation_id, refund_id, order_item_id) REFERENCES refund_allocations(id, refund_id, order_item_id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_allocation_finalization_effects', 'refund_allocation_finalization_effects_draft_item_fk', null, '61cf86ffc891b3e99abf3b5603bcb9b73c0dfd5bb3a173c84ba0398ae07b8b14', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (draft_id, order_item_id) REFERENCES refund_allocation_draft_items(draft_id, order_item_id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_allocation_finalization_effects', 'refund_allocation_finalization_effects_draft_version_fk', null, 'd18ca09bd92741fe561d6970644e320209809261bfcd81e511a1cb609ac14a5c', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (draft_id, refund_id, draft_version) REFERENCES refund_allocation_drafts(id, refund_id, version) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_allocation_finalization_effects', 'refund_allocation_finalization_effects_purchase_grant_fk', null, '5a88885f803d73c256aeebb98bec43dbdaa2008b429c56a4eb6e3ea1c81e4782', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (purchase_grant_id, order_item_id) REFERENCES entitlement_grants(id, order_item_id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_allocations', 'refund_allocations_amount_positive', null, '4290ffbdbfc129d258c54c67f4815ff6b4a646c84c0653f52fed5e80630a1772', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((amount_minor > 0))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_allocations', 'refund_allocations_provenance_unique', null, 'edc3f39ca2f093574fd770bd31c8fa7e9b1e1882eff41630f7d02f0234996b00', $catalog${"type": "u", "enforced": true, "validated": true, "deferrable": false, "definition": "UNIQUE (id, refund_id, order_item_id)", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_reporting_correction_items', 'refund_reporting_correction_items_correction_set_id_refund_reporting_correction_sets_id_fk', null, 'ba6e0d0a98afdde28e50c473192ade276b11ca2c919cc7ff4e3f3c4b2272d6a8', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (correction_set_id) REFERENCES refund_reporting_correction_sets(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_reporting_correction_items', 'refund_reporting_correction_items_order_item_id_order_items_id_fk', null, '29d049861fb32946783cfb172c3540f8d096f75a5a10b2c36c3a70d1caaa788f', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_reporting_correction_items', 'refund_reporting_correction_items_source_allocation_set_id_financial_allocation_sets_id_fk', null, 'e1fe346be0ab50bdad2d6c63756adb1ad6f319011511012db203e397b7caa59a', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (source_allocation_set_id) REFERENCES financial_allocation_sets(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_reporting_correction_sets', 'refund_reporting_correction_sets_approved_by_admin_id_user_id_fk', null, '17a6e16782c952f6c95732a4abe23976cd781c4651b9d52e89b7e7479610ec7f', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (approved_by_admin_id) REFERENCES \"user\"(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_reporting_correction_sets', 'refund_reporting_correction_sets_base_allocation_set_id_financial_allocation_sets_id_fk', null, '71e0effaecf0b4148d96e9dd80e3818b0ec4b8895a28320e7684e39c5e0fac30', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (base_allocation_set_id) REFERENCES financial_allocation_sets(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_reporting_correction_sets', 'refund_reporting_correction_sets_created_by_admin_id_user_id_fk', null, 'c0a4eba1c20bbf52c33fce43f3877e7c8a839101cae13970be0943afd795a01f', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (created_by_admin_id) REFERENCES \"user\"(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_reporting_correction_sets', 'refund_reporting_correction_sets_predecessor_graph_fk', null, 'c47072a74bf5bba0128b2523d37a5ccf5533c70cf22949ec15a31e769412d98b', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (predecessor_correction_set_id, refund_id) REFERENCES refund_reporting_correction_sets(id, refund_id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refund_reporting_correction_sets', 'refund_reporting_correction_sets_refund_id_refunds_id_fk', null, '02244c102ecaf6697139b3fc075e8fc59e2045c2699c91ac74921aa2efd94fe5', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (refund_id) REFERENCES refunds(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'refunds', 'refunds_amount_positive', null, '4290ffbdbfc129d258c54c67f4815ff6b4a646c84c0653f52fed5e80630a1772', $catalog${"type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((amount_minor > 0))", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'stripe_balance_transaction_fee_details', 'stripe_balance_transaction_fee_details_balance_transaction_id_stripe_balance_transactions_id_fk', null, '1fcf82ba3524564a78d842ed11ae229a05d06dd59869f9e922f3faf9049b7a3c', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (balance_transaction_id) REFERENCES stripe_balance_transactions(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'stripe_payout_balance_transactions', 'stripe_payout_balance_transactions_balance_transaction_id_stripe_balance_transactions_id_fk', null, '1fcf82ba3524564a78d842ed11ae229a05d06dd59869f9e922f3faf9049b7a3c', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (balance_transaction_id) REFERENCES stripe_balance_transactions(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'stripe_payout_balance_transactions', 'stripe_payout_balance_transactions_payout_id_stripe_payouts_id_fk', null, 'dbc53ab0c9e90975b83e70acfca63511ed6276ac7e0a905ecee3a9181e8be543', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (payout_id) REFERENCES stripe_payouts(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'stripe_payout_balance_transactions', 'stripe_payout_balance_transactions_run_payout_fk', null, 'b5352998a34f973686395318efd250b94950e3240744a9e3407e9c21f5536196', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (published_from_run_id, payout_id) REFERENCES payout_import_runs(id, payout_id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'stripe_payouts', 'stripe_payouts_balance_transaction_id_stripe_balance_transactions_id_fk', null, '1fcf82ba3524564a78d842ed11ae229a05d06dd59869f9e922f3faf9049b7a3c', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (balance_transaction_id) REFERENCES stripe_balance_transactions(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('constraint', 'public', 'stripe_payouts', 'stripe_payouts_failure_balance_transaction_id_stripe_balance_transactions_id_fk', null, 'cb6ff0c0c6e6b890d9c2fcbf0f9e7f6859a9b620aecddc986eefa1a4e2be141b', $catalog${"type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (failure_balance_transaction_id) REFERENCES stripe_balance_transactions(id) ON DELETE RESTRICT", "initially_deferred": false}$catalog$::jsonb),
  ('enum', 'public', null, 'dispute_allocation_effect', null, '736b36f3241c8d8109719de724168cf763d5d7175ac2a080b15ef780b32105fe', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["withdrawal", "reinstatement"]}$catalog$::jsonb),
  ('enum', 'public', null, 'entitlement_grant_source', null, '093c4a06151b3050bf4e501ae6d045622bb564f91a09ac4dce8ea41986cd75c5', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["purchase", "preserved", "administrative"]}$catalog$::jsonb),
  ('enum', 'public', null, 'financial_allocation_basis', null, 'fa85541e3fe6c7ee0f5f2b6b6b4ac9b6bf8dab12859a7d6b605b629159585e91', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["gross_amount", "fee"]}$catalog$::jsonb),
  ('enum', 'public', null, 'financial_allocation_scope', null, '58a294bf7282625f4b6e14518bf1b159119a47d0cedc4a9455a48f8efce0bb94', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["title", "account", "unresolved"]}$catalog$::jsonb),
  ('enum', 'public', null, 'financial_allocation_source_kind', null, 'f8480792b89315452b6b0c9f4df32c5bae6b2c3eaa86da69f541910250601538', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["payment", "refund", "dispute", "payout", "adjustment"]}$catalog$::jsonb),
  ('enum', 'public', null, 'financial_classification', null, '65299def21ae56f0cbb5995a461e119092d32550182de74da7fca6fe49cf053b', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["charge", "refund", "refund_failure", "dispute_withdrawal", "dispute_reinstatement", "payout", "processing_fee", "refund_fee", "dispute_fee", "provider_fee_tax", "fee_credit", "other", "unknown"]}$catalog$::jsonb),
  ('enum', 'public', null, 'financial_classification_subject_type', null, 'f8107037361ad91132479083f07143dbdfe943fe81ed9c6e06f27a85c53aaf2f', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["balance_transaction", "fee_detail"]}$catalog$::jsonb),
  ('enum', 'public', null, 'financial_component', null, 'ad13090085850332fd94ae3a2bfd6b6c2b2466eb6b4bae37f256478211b95cc7', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["sale_subtotal", "sale_tax", "processing_fee", "refund_subtotal", "refund_tax", "refund_fee", "refund_failure_reversal", "dispute_subtotal", "dispute_tax", "dispute_fee", "dispute_reinstatement", "provider_fee_tax", "fee_credit", "other"]}$catalog$::jsonb),
  ('enum', 'public', null, 'financial_evidence_status', null, '86d0ceb934ebe3b9f494a3437fc03b5c5c0d43319948c764ec29c99667408f4e', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["pending", "fee_reconciled", "exception"]}$catalog$::jsonb),
  ('enum', 'public', null, 'financial_finalization_transition', null, 'c57516714b2124b2ccfd85bf6c9d2e07c3516f872f7f8c68c5247f5b2fb9413e', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["unchanged", "revoked_by_finalization"]}$catalog$::jsonb),
  ('enum', 'public', null, 'financial_issue_impact', null, 'e0dee796594d14e015445c8b063948468d9e71e19ca3ca24392dfd50341b4e12', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["pending", "exception", "informational"]}$catalog$::jsonb),
  ('enum', 'public', null, 'financial_issue_state', null, 'faab9174dc3c0da327b1fc491ec216a0fd2c4b844d043e1831f368b31c5a4a08', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["open", "resolved"]}$catalog$::jsonb),
  ('enum', 'public', null, 'financial_scan_state', null, '48bd8da7f6fc630d8005bcebb80c07bbf12c908fa5d37157414ad75c2df56af6', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["running", "completed", "exception"]}$catalog$::jsonb),
  ('enum', 'public', null, 'payout_import_state', null, '45edf308d5443c214bf8ebaafbee1c814d4b4ccd331d6ee363e33587f8edeed6', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["collecting", "publishable", "published", "abandoned", "exception"]}$catalog$::jsonb),
  ('enum', 'public', null, 'refund_allocation_draft_state', null, '2a5f9fe4370d7989b1e773f7a6ccf737788e44d26d4883c82a782b951a7d5435', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["active", "finalized", "discarded"]}$catalog$::jsonb),
  ('enum', 'public', null, 'refund_allocation_status', null, '0f2723d99c24c9f847d1caa203f3ea8f5e425ad90e77086d6d2bdabe72979e11', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["not_applicable", "needs_review", "draft", "finalized", "exception"]}$catalog$::jsonb),
  ('enum', 'public', null, 'refund_correction_domain', null, 'efeed1438e377b99d365927caf9e02efe5e81bc6ec222e6e294adc8651143011', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["presentment", "settlement"]}$catalog$::jsonb),
  ('enum', 'public', null, 'refund_correction_kind', null, 'd21025208f96bd30801314ad5093a95d851ca87ad7c6b76e97e344fe2d7915eb', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["allocation_attribution_correction", "classifier_rebase"]}$catalog$::jsonb),
  ('enum', 'public', null, 'stripe_balance_transaction_source_family', null, 'c12a3e46c86e0b97187c5161f3b62501b8333bd33e171afe7f665da1d48e1a8e', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["charge", "refund", "dispute", "payout", "adjustment", "unknown"]}$catalog$::jsonb),
  ('enum', 'public', null, 'stripe_balance_transaction_status', null, 'f9965692a6d9f005b49ef455bd45c65e28409dbef478cc83f88c6c1eac73b4db', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["pending", "available"]}$catalog$::jsonb),
  ('enum', 'public', null, 'stripe_payout_method', null, '5d111b819b6e2e3afb139603b921cd9e1fe0f04f35c64db49ce6e43ac3a79a58', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["standard", "instant", "unknown"]}$catalog$::jsonb),
  ('enum', 'public', null, 'stripe_payout_reconciliation_status', null, '69308ae216645263e050d0a312a35af4d8c86f0eb1ee29d54d4f340188161401', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["completed", "in_progress", "not_applicable"]}$catalog$::jsonb),
  ('enum', 'public', null, 'stripe_payout_status', null, '2eabc9b767e6c89470a6d385bfaad6a4e88442707b56ee50d506997c3dfc6c8a', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}, {"grantee": "PUBLIC", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "USAGE"}], "owner": "DATABASE_OWNER", "labels": ["pending", "in_transit", "paid", "failed", "canceled"]}$catalog$::jsonb),
  ('function', 'public', null, 'authorize_commerce_claim_issuance', 'text, text', 'bc2dbd002f5f068a1016f3de91c4a15a464462618baff194521808d9c057c03d', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": ["search_path=pg_catalog"], "result": "boolean", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.authorize_commerce_claim_issuance(p_raw_claim_proof text, p_raw_auth_token text)\n RETURNS boolean\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog'\nAS $function$\nDECLARE\n  claim_digest text;\n  auth_digest text;\n  candidate \"public\".\"commerce_claim_issuances\"%ROWTYPE;\n  locked_issuance \"public\".\"commerce_claim_issuances\"%ROWTYPE;\n  locked_identity \"public\".\"guest_identities\"%ROWTYPE;\n  locked_order \"public\".\"orders\"%ROWTYPE;\n  locked_user \"public\".\"user\"%ROWTYPE;\n  locked_authority \"public\".\"credential_authority\"%ROWTYPE;\n  user_candidate_id uuid;\n  identity_candidate_id uuid;\n  has_authority boolean := false;\n  credential_count integer;\n  credential_password text;\n  promotion_at timestamp with time zone := pg_catalog.clock_timestamp();\nBEGIN\n  IF p_raw_claim_proof IS NULL OR p_raw_claim_proof !~ '^[A-Za-z0-9_-]{43}$' OR\n    p_raw_auth_token IS NULL OR pg_catalog.char_length(p_raw_auth_token) NOT BETWEEN 1 AND 256 THEN\n    RETURN false;\n  END IF;\n  claim_digest := pg_catalog.encode(\n    pg_catalog.sha256(pg_catalog.convert_to(p_raw_claim_proof, 'UTF8')), 'hex'\n  );\n  auth_digest := pg_catalog.encode(\n    pg_catalog.sha256(pg_catalog.convert_to(p_raw_auth_token, 'UTF8')), 'hex'\n  );\n\n  SELECT * INTO candidate\n  FROM \"public\".\"commerce_claim_issuances\" issuance\n  WHERE issuance.claim_proof_sha256 = claim_digest;\n  IF NOT FOUND OR candidate.state NOT IN ('issued', 'authorized') OR\n    candidate.normalized_email IS NULL OR candidate.anchor_order_id IS NULL OR\n    candidate.auth_token_sha256 IS DISTINCT FROM auth_digest THEN\n    RETURN false;\n  END IF;\n\n  SELECT identity.id INTO identity_candidate_id\n  FROM \"public\".\"guest_identities\" identity\n  WHERE identity.email = candidate.normalized_email;\n  IF NOT FOUND THEN RETURN false; END IF;\n  SELECT * INTO locked_identity\n  FROM \"public\".\"guest_identities\" identity\n  WHERE identity.id = identity_candidate_id\n  FOR UPDATE;\n  IF NOT FOUND OR locked_identity.email <> candidate.normalized_email THEN\n    RETURN false;\n  END IF;\n\n  SELECT * INTO locked_order\n  FROM \"public\".\"orders\" purchase_order\n  WHERE purchase_order.id = candidate.anchor_order_id\n  FOR UPDATE;\n  IF NOT FOUND OR locked_order.guest_identity_id <> locked_identity.id OR\n    locked_order.status <> 'paid' OR locked_order.initiating_user_id IS NOT NULL OR\n    locked_order.purchase_email IS DISTINCT FROM candidate.normalized_email THEN\n    RETURN false;\n  END IF;\n\n  SELECT claimant.id INTO user_candidate_id\n  FROM \"public\".\"user\" claimant\n  WHERE claimant.email = candidate.normalized_email;\n  IF NOT FOUND THEN RETURN false; END IF;\n  SELECT * INTO locked_user\n  FROM \"public\".\"user\" claimant\n  WHERE claimant.id = user_candidate_id\n  FOR UPDATE;\n  IF NOT FOUND OR NOT locked_user.email_verified OR\n    locked_user.email <> candidate.normalized_email OR\n    locked_user.email <> pg_catalog.lower(pg_catalog.btrim(locked_user.email)) THEN\n    RETURN false;\n  END IF;\n\n  SELECT * INTO locked_authority\n  FROM \"public\".\"credential_authority\" authority\n  WHERE authority.user_id = locked_user.id\n  FOR UPDATE;\n  has_authority := FOUND;\n  PERFORM 1\n  FROM \"public\".\"account\" account_row\n  WHERE account_row.user_id = locked_user.id\n  ORDER BY account_row.id\n  FOR UPDATE;\n  SELECT pg_catalog.count(*)::integer, pg_catalog.max(account_row.password)\n  INTO credential_count, credential_password\n  FROM \"public\".\"account\" account_row\n  WHERE account_row.user_id = locked_user.id AND account_row.provider_id = 'credential';\n\n  SELECT * INTO locked_issuance\n  FROM \"public\".\"commerce_claim_issuances\" issuance\n  WHERE issuance.claim_proof_sha256 = claim_digest\n  FOR UPDATE;\n  IF NOT FOUND OR locked_issuance.state NOT IN ('issued', 'authorized') OR\n    locked_issuance.normalized_email <> locked_user.email OR\n    locked_issuance.anchor_order_id <> locked_order.id OR\n    locked_issuance.auth_token_sha256 IS DISTINCT FROM auth_digest OR\n    locked_issuance.expires_at <= promotion_at OR\n    (locked_issuance.state = 'authorized' AND\n      locked_issuance.authorized_user_id IS DISTINCT FROM locked_user.id) THEN\n    RETURN false;\n  END IF;\n\n  IF locked_issuance.kind = 'commerce-magic' THEN\n    IF credential_count <> 0 OR has_authority THEN RETURN false; END IF;\n  ELSIF locked_issuance.kind = 'password-reset' THEN\n    IF credential_count <> 1 OR credential_password IS NULL OR NOT has_authority OR\n      locked_authority.authorized_password_hash IS DISTINCT FROM credential_password OR\n      locked_authority.reset_epoch_sha256 IS NOT NULL THEN\n      RETURN false;\n    END IF;\n  ELSE\n    RETURN false;\n  END IF;\n\n  IF locked_issuance.state = 'issued' THEN\n    UPDATE \"public\".\"commerce_claim_issuances\"\n    SET state = 'authorized', authorized_user_id = locked_user.id,\n      authorized_at = promotion_at\n    WHERE claim_proof_sha256 = claim_digest;\n  END IF;\n  RETURN true;\nEND;\n$function$\n", "volatility": "v", "security_definer": true, "identity_arguments": "p_raw_claim_proof text, p_raw_auth_token text"}$catalog$::jsonb),
  ('function', 'public', null, 'claim_guest_purchases_after_authorization', 'text, text', 'cbc77a2079bacac27cddb51ed57759f3fec30287247098a438374c0021298506', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": ["search_path=pg_catalog"], "result": "TABLE(claimed boolean, changed boolean, claimed_order_count integer, claimed_title_count integer, definitive_invalid boolean, conflict_code text)", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.claim_guest_purchases_after_authorization(p_raw_claim_proof text, p_correlation_id text)\n RETURNS TABLE(claimed boolean, changed boolean, claimed_order_count integer, claimed_title_count integer, definitive_invalid boolean, conflict_code text)\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog'\nAS $function$\nDECLARE\n  claim_digest text;\n  candidate \"public\".\"commerce_claim_issuances\"%ROWTYPE;\n  locked_issuance \"public\".\"commerce_claim_issuances\"%ROWTYPE;\n  locked_identity \"public\".\"guest_identities\"%ROWTYPE;\n  locked_user \"public\".\"user\"%ROWTYPE;\n  locked_authority \"public\".\"credential_authority\"%ROWTYPE;\n  locked_entitlement \"public\".\"entitlements\"%ROWTYPE;\n  identity_candidate_id uuid;\n  order_ids uuid[] := ARRAY[]::uuid[];\n  payment_ids uuid[] := ARRAY[]::uuid[];\n  refund_ids uuid[] := ARRAY[]::uuid[];\n  item_ids uuid[] := ARRAY[]::uuid[];\n  title_ids uuid[] := ARRAY[]::uuid[];\n  current_title_id uuid;\n  grant_fact record;\n  credential_count integer;\n  credential_password text;\n  has_authority boolean := false;\n  has_entitlement boolean;\n  has_active_grant boolean;\n  has_lost_dispute boolean;\n  has_open_dispute boolean;\n  eligible boolean := false;\n  identity_conflict boolean := false;\n  identity_changed boolean := false;\n  any_changed boolean := false;\n  allocated_minor bigint;\n  next_state text;\n  next_reason text;\n  order_count integer := 0;\n  title_count integer := 0;\n  claim_at timestamp with time zone := pg_catalog.clock_timestamp();\nBEGIN\n  IF p_raw_claim_proof IS NULL OR p_raw_claim_proof !~ '^[A-Za-z0-9_-]{43}$' OR\n    p_correlation_id IS NULL OR\n    p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' THEN\n    RETURN QUERY SELECT false, false, 0, 0, true, NULL::text;\n    RETURN;\n  END IF;\n  claim_digest := pg_catalog.encode(\n    pg_catalog.sha256(pg_catalog.convert_to(p_raw_claim_proof, 'UTF8')), 'hex'\n  );\n  SELECT * INTO candidate\n  FROM \"public\".\"commerce_claim_issuances\" issuance\n  WHERE issuance.claim_proof_sha256 = claim_digest;\n  IF FOUND AND candidate.state = 'consumed' THEN\n    IF candidate.result_disposition = 'claimed' THEN\n      RETURN QUERY SELECT true, candidate.result_changed,\n        candidate.result_order_count, candidate.result_title_count, false, NULL::text;\n    ELSIF candidate.result_disposition = 'not_eligible' THEN\n      RETURN QUERY SELECT false, false, 0, 0, false, NULL::text;\n    ELSIF candidate.result_disposition = 'definitive_invalid' THEN\n      RETURN QUERY SELECT false, false, 0, 0, true, NULL::text;\n    ELSIF candidate.result_disposition = 'identity_conflict' THEN\n      RETURN QUERY SELECT false, false, 0, 0, false,\n        'IDENTITY_ALREADY_CLAIMED'::text;\n    ELSE\n      RAISE EXCEPTION USING ERRCODE = '55000',\n        MESSAGE = 'consumed commerce claim has no replayable result';\n    END IF;\n    RETURN;\n  END IF;\n  IF NOT FOUND OR candidate.state <> 'authorized' OR\n    candidate.normalized_email IS NULL OR candidate.anchor_order_id IS NULL OR\n    candidate.authorized_user_id IS NULL THEN\n    RETURN QUERY SELECT false, false, 0, 0, true, NULL::text;\n    RETURN;\n  END IF;\n\n  SELECT identity.id INTO identity_candidate_id\n  FROM \"public\".\"guest_identities\" identity\n  WHERE identity.email = candidate.normalized_email;\n  IF NOT FOUND THEN\n    RAISE EXCEPTION USING ERRCODE = '55000',\n      MESSAGE = 'authorized commerce claim lost its guest identity';\n  END IF;\n  SELECT * INTO locked_identity\n  FROM \"public\".\"guest_identities\" identity\n  WHERE identity.id = identity_candidate_id\n  FOR UPDATE;\n  IF NOT FOUND OR locked_identity.email <> candidate.normalized_email THEN\n    RAISE EXCEPTION USING ERRCODE = '55000',\n      MESSAGE = 'authorized commerce claim guest identity changed';\n  END IF;\n  identity_conflict := locked_identity.claimed_by_user_id IS NOT NULL AND\n    locked_identity.claimed_by_user_id <> candidate.authorized_user_id;\n\n  PERFORM 1\n  FROM \"public\".\"orders\" purchase_order\n  WHERE purchase_order.guest_identity_id = locked_identity.id\n    AND purchase_order.status = 'paid'\n    AND purchase_order.initiating_user_id IS NULL\n  ORDER BY purchase_order.id\n  FOR UPDATE;\n  SELECT coalesce(pg_catalog.array_agg(purchase_order.id ORDER BY purchase_order.id),\n      ARRAY[]::uuid[]), pg_catalog.count(*)::integer\n  INTO order_ids, order_count\n  FROM \"public\".\"orders\" purchase_order\n  WHERE purchase_order.guest_identity_id = locked_identity.id\n    AND purchase_order.status = 'paid'\n    AND purchase_order.initiating_user_id IS NULL;\n  eligible := order_count > 0 AND candidate.anchor_order_id = ANY(order_ids);\n\n  IF eligible AND NOT identity_conflict THEN\n    IF EXISTS (\n      SELECT 1 FROM \"public\".\"orders\" purchase_order\n      WHERE purchase_order.id = ANY(order_ids)\n        AND purchase_order.purchase_email IS DISTINCT FROM candidate.normalized_email\n    ) THEN\n      RAISE EXCEPTION USING ERRCODE = '55000',\n        MESSAGE = 'commerce claim order email is inconsistent';\n    END IF;\n\n    PERFORM 1 FROM \"public\".\"payments\" payment\n    WHERE payment.order_id = ANY(order_ids)\n    ORDER BY payment.id\n    FOR UPDATE;\n    SELECT coalesce(pg_catalog.array_agg(payment.id ORDER BY payment.id),\n        ARRAY[]::uuid[])\n    INTO payment_ids\n    FROM \"public\".\"payments\" payment\n    WHERE payment.order_id = ANY(order_ids);\n\n    PERFORM 1 FROM \"public\".\"refunds\" refund\n    WHERE refund.payment_id = ANY(payment_ids)\n    ORDER BY refund.id\n    FOR UPDATE;\n    SELECT coalesce(pg_catalog.array_agg(refund.id ORDER BY refund.id),\n        ARRAY[]::uuid[])\n    INTO refund_ids\n    FROM \"public\".\"refunds\" refund\n    WHERE refund.payment_id = ANY(payment_ids);\n\n    PERFORM 1 FROM \"public\".\"refund_allocations\" allocation\n    WHERE allocation.refund_id = ANY(refund_ids)\n    ORDER BY allocation.id\n    FOR UPDATE;\n    PERFORM 1 FROM \"public\".\"disputes\" dispute\n    WHERE dispute.payment_id = ANY(payment_ids)\n    ORDER BY dispute.id\n    FOR UPDATE;\n\n    PERFORM 1 FROM \"public\".\"order_items\" item\n    WHERE item.order_id = ANY(order_ids)\n    ORDER BY item.id\n    FOR UPDATE;\n    SELECT\n      coalesce(pg_catalog.array_agg(item.id ORDER BY item.id), ARRAY[]::uuid[]),\n      coalesce(pg_catalog.array_agg(DISTINCT item.title_id ORDER BY item.title_id),\n        ARRAY[]::uuid[])\n    INTO item_ids, title_ids\n    FROM \"public\".\"order_items\" item\n    WHERE item.order_id = ANY(order_ids);\n    title_count := pg_catalog.cardinality(title_ids);\n\n    FOR current_title_id IN SELECT pg_catalog.unnest(title_ids) ORDER BY 1 LOOP\n      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(\n        'pale-orbit:commerce:entitlement:' || candidate.authorized_user_id::text ||\n          ':' || current_title_id::text,\n        0\n      ));\n    END LOOP;\n  END IF;\n\n  SELECT * INTO locked_user\n  FROM \"public\".\"user\" claimant\n  WHERE claimant.id = candidate.authorized_user_id\n  FOR UPDATE;\n  IF NOT FOUND OR NOT locked_user.email_verified OR\n    locked_user.email <> candidate.normalized_email OR\n    locked_user.email <> pg_catalog.lower(pg_catalog.btrim(locked_user.email)) THEN\n    RAISE EXCEPTION USING ERRCODE = '55000',\n      MESSAGE = 'authorized commerce claim user changed';\n  END IF;\n\n  IF eligible AND NOT identity_conflict THEN\n    PERFORM 1\n    FROM \"public\".\"entitlement_grants\" grant_row\n    WHERE grant_row.order_item_id = ANY(item_ids) OR\n      (grant_row.user_id = locked_user.id AND grant_row.title_id = ANY(title_ids))\n    ORDER BY grant_row.id\n    FOR UPDATE;\n  END IF;\n\n  SELECT * INTO locked_authority\n  FROM \"public\".\"credential_authority\" authority\n  WHERE authority.user_id = locked_user.id\n  FOR UPDATE;\n  has_authority := FOUND;\n  PERFORM 1\n  FROM \"public\".\"account\" account_row\n  WHERE account_row.user_id = locked_user.id\n  ORDER BY account_row.id\n  FOR UPDATE;\n  SELECT pg_catalog.count(*)::integer, pg_catalog.max(account_row.password)\n  INTO credential_count, credential_password\n  FROM \"public\".\"account\" account_row\n  WHERE account_row.user_id = locked_user.id AND account_row.provider_id = 'credential';\n\n  SELECT * INTO locked_issuance\n  FROM \"public\".\"commerce_claim_issuances\" issuance\n  WHERE issuance.claim_proof_sha256 = claim_digest\n  FOR UPDATE;\n  IF FOUND AND locked_issuance.state = 'consumed' THEN\n    IF locked_issuance.result_disposition = 'claimed' THEN\n      RETURN QUERY SELECT true, locked_issuance.result_changed,\n        locked_issuance.result_order_count, locked_issuance.result_title_count,\n        false, NULL::text;\n    ELSIF locked_issuance.result_disposition = 'not_eligible' THEN\n      RETURN QUERY SELECT false, false, 0, 0, false, NULL::text;\n    ELSIF locked_issuance.result_disposition = 'definitive_invalid' THEN\n      RETURN QUERY SELECT false, false, 0, 0, true, NULL::text;\n    ELSIF locked_issuance.result_disposition = 'identity_conflict' THEN\n      RETURN QUERY SELECT false, false, 0, 0, false,\n        'IDENTITY_ALREADY_CLAIMED'::text;\n    ELSE\n      RAISE EXCEPTION USING ERRCODE = '55000',\n        MESSAGE = 'consumed commerce claim has no replayable result';\n    END IF;\n    RETURN;\n  END IF;\n  IF NOT FOUND OR locked_issuance.state <> 'authorized' OR\n    locked_issuance.normalized_email <> locked_user.email OR\n    locked_issuance.authorized_user_id <> locked_user.id OR\n    locked_issuance.expires_at <= claim_at THEN\n    RETURN QUERY SELECT false, false, 0, 0, true, NULL::text;\n    RETURN;\n  END IF;\n  IF locked_issuance.kind = 'commerce-magic' THEN\n    IF credential_count <> 0 OR has_authority THEN\n      UPDATE \"public\".\"commerce_claim_issuances\"\n      SET state = 'consumed', auth_token_sha256 = NULL, normalized_email = NULL,\n        anchor_order_id = NULL, authorized_user_id = NULL, consumed_at = claim_at,\n        result_disposition = 'definitive_invalid', result_changed = false,\n        result_order_count = 0, result_title_count = 0\n      WHERE claim_proof_sha256 = claim_digest;\n      RETURN QUERY SELECT false, false, 0, 0, true, NULL::text;\n      RETURN;\n    END IF;\n  ELSIF locked_issuance.kind = 'password-reset' THEN\n    IF credential_count <> 1 OR credential_password IS NULL OR NOT has_authority OR\n      locked_authority.authorized_password_hash IS DISTINCT FROM credential_password OR\n      locked_authority.reset_epoch_sha256 IS NOT NULL THEN\n      UPDATE \"public\".\"commerce_claim_issuances\"\n      SET state = 'consumed', auth_token_sha256 = NULL, normalized_email = NULL,\n        anchor_order_id = NULL, authorized_user_id = NULL, consumed_at = claim_at,\n        result_disposition = 'definitive_invalid', result_changed = false,\n        result_order_count = 0, result_title_count = 0\n      WHERE claim_proof_sha256 = claim_digest;\n      RETURN QUERY SELECT false, false, 0, 0, true, NULL::text;\n      RETURN;\n    END IF;\n  ELSE\n    UPDATE \"public\".\"commerce_claim_issuances\"\n    SET state = 'consumed', auth_token_sha256 = NULL, normalized_email = NULL,\n      anchor_order_id = NULL, authorized_user_id = NULL, consumed_at = claim_at,\n      result_disposition = 'definitive_invalid', result_changed = false,\n      result_order_count = 0, result_title_count = 0\n    WHERE claim_proof_sha256 = claim_digest;\n    RETURN QUERY SELECT false, false, 0, 0, true, NULL::text;\n    RETURN;\n  END IF;\n\n  IF identity_conflict THEN\n    UPDATE \"public\".\"commerce_claim_issuances\"\n    SET state = 'consumed', auth_token_sha256 = NULL, normalized_email = NULL,\n      anchor_order_id = NULL, authorized_user_id = NULL, consumed_at = claim_at,\n      result_disposition = 'identity_conflict', result_changed = false,\n      result_order_count = 0, result_title_count = 0\n    WHERE claim_proof_sha256 = claim_digest;\n    RETURN QUERY SELECT false, false, 0, 0, false, 'IDENTITY_ALREADY_CLAIMED'::text;\n    RETURN;\n  END IF;\n  IF NOT eligible THEN\n    UPDATE \"public\".\"commerce_claim_issuances\"\n    SET state = 'consumed', auth_token_sha256 = NULL, normalized_email = NULL,\n      anchor_order_id = NULL, authorized_user_id = NULL, consumed_at = claim_at,\n      result_disposition = 'not_eligible', result_changed = false,\n      result_order_count = 0, result_title_count = 0\n    WHERE claim_proof_sha256 = claim_digest;\n    RETURN QUERY SELECT false, false, 0, 0, false, NULL::text;\n    RETURN;\n  END IF;\n\n  IF pg_catalog.cardinality(payment_ids) <> order_count OR EXISTS (\n    SELECT 1 FROM \"public\".\"payments\" payment\n    WHERE payment.id = ANY(payment_ids) AND payment.status <> 'succeeded'\n  ) OR pg_catalog.cardinality(item_ids) = 0 OR EXISTS (\n    SELECT 1 FROM \"public\".\"order_items\" item\n    WHERE item.id = ANY(item_ids) AND (item.total_minor IS NULL OR item.total_minor < 1)\n  ) OR (SELECT pg_catalog.count(*) FROM \"public\".\"entitlement_grants\" grant_row\n        WHERE grant_row.order_item_id = ANY(item_ids) AND grant_row.source = 'purchase')\n       <> pg_catalog.cardinality(item_ids) OR EXISTS (\n    SELECT 1 FROM \"public\".\"entitlement_grants\" grant_row\n    WHERE grant_row.order_item_id = ANY(item_ids) AND grant_row.source = 'purchase'\n      AND grant_row.user_id IS NOT NULL AND grant_row.user_id <> locked_user.id\n  ) THEN\n    RAISE EXCEPTION USING ERRCODE = '55000',\n      MESSAGE = 'commerce claim financial or grant facts are inconsistent';\n  END IF;\n\n  FOR grant_fact IN\n    SELECT grant_row.id AS grant_id, grant_row.user_id, grant_row.state,\n      grant_row.state_reason, grant_row.granted_at, grant_row.suspended_at,\n      grant_row.revoked_at, item.id AS item_id, item.title_id, item.total_minor,\n      payment.id AS payment_id\n    FROM \"public\".\"order_items\" item\n    JOIN \"public\".\"payments\" payment ON payment.order_id = item.order_id\n    JOIN \"public\".\"entitlement_grants\" grant_row\n      ON grant_row.order_item_id = item.id AND grant_row.source = 'purchase'\n    WHERE item.id = ANY(item_ids)\n    ORDER BY grant_row.id\n  LOOP\n    IF grant_fact.user_id = locked_user.id THEN CONTINUE; END IF;\n    SELECT coalesce(pg_catalog.sum(allocation.amount_minor), 0)\n    INTO allocated_minor\n    FROM \"public\".\"refund_allocations\" allocation\n    JOIN \"public\".\"refunds\" refund ON refund.id = allocation.refund_id\n    WHERE allocation.order_item_id = grant_fact.item_id\n      AND refund.status = 'succeeded';\n    IF allocated_minor < 0 OR allocated_minor > grant_fact.total_minor THEN\n      RAISE EXCEPTION USING ERRCODE = '55000',\n        MESSAGE = 'commerce claim refund allocation is inconsistent';\n    END IF;\n    SELECT coalesce(pg_catalog.bool_or(dispute.status = 'lost'), false),\n      coalesce(pg_catalog.bool_or(dispute.status = 'open'), false)\n    INTO has_lost_dispute, has_open_dispute\n    FROM \"public\".\"disputes\" dispute\n    WHERE dispute.payment_id = grant_fact.payment_id;\n\n    IF grant_fact.state = 'revoked' THEN\n      next_state := 'revoked';\n      next_reason := grant_fact.state_reason;\n    ELSIF allocated_minor = grant_fact.total_minor THEN\n      next_state := 'revoked';\n      next_reason := 'refund_fully_allocated';\n    ELSIF has_lost_dispute THEN\n      next_state := 'revoked';\n      next_reason := 'dispute_lost';\n    ELSIF has_open_dispute THEN\n      next_state := 'suspended';\n      next_reason := 'dispute_open';\n    ELSE\n      next_state := 'active';\n      next_reason := 'payment_succeeded';\n    END IF;\n\n    UPDATE \"public\".\"entitlement_grants\"\n    SET user_id = locked_user.id,\n      state = next_state::\"public\".\"entitlement_grant_status\",\n      state_reason = next_reason,\n      suspended_at = CASE WHEN next_state = 'suspended'\n        THEN coalesce(grant_fact.suspended_at,\n          greatest(claim_at, grant_fact.granted_at)) ELSE NULL END,\n      revoked_at = CASE WHEN next_state = 'revoked'\n        THEN coalesce(grant_fact.revoked_at,\n          greatest(claim_at, grant_fact.granted_at)) ELSE NULL END,\n      updated_at = claim_at\n    WHERE id = grant_fact.grant_id;\n    any_changed := true;\n  END LOOP;\n\n  identity_changed := locked_identity.claimed_by_user_id IS NULL;\n  IF identity_changed THEN\n    UPDATE \"public\".\"guest_identities\"\n    SET claimed_by_user_id = locked_user.id, claimed_at = claim_at, updated_at = claim_at\n    WHERE id = locked_identity.id;\n    any_changed := true;\n  END IF;\n\n  FOR current_title_id IN SELECT pg_catalog.unnest(title_ids) ORDER BY 1 LOOP\n    SELECT * INTO locked_entitlement\n    FROM \"public\".\"entitlements\" entitlement\n    WHERE entitlement.user_id = locked_user.id\n      AND entitlement.title_id = current_title_id\n    FOR UPDATE;\n    has_entitlement := FOUND;\n    SELECT EXISTS (\n      SELECT 1 FROM \"public\".\"entitlement_grants\" grant_row\n      WHERE grant_row.user_id = locked_user.id\n        AND grant_row.title_id = current_title_id\n        AND grant_row.state = 'active'\n    ) INTO has_active_grant;\n    IF has_active_grant AND NOT has_entitlement THEN\n      INSERT INTO \"public\".\"entitlements\" (\n        user_id, title_id, granted_at, revoked_at, created_at, updated_at\n      ) VALUES (\n        locked_user.id, current_title_id, claim_at, NULL, claim_at, claim_at\n      );\n      any_changed := true;\n    ELSIF has_active_grant AND locked_entitlement.revoked_at IS NOT NULL THEN\n      UPDATE \"public\".\"entitlements\"\n      SET revoked_at = NULL, updated_at = claim_at\n      WHERE id = locked_entitlement.id;\n      any_changed := true;\n    ELSIF NOT has_active_grant AND has_entitlement AND\n      locked_entitlement.revoked_at IS NULL THEN\n      UPDATE \"public\".\"entitlements\"\n      SET revoked_at = greatest(claim_at, locked_entitlement.granted_at),\n        updated_at = claim_at\n      WHERE id = locked_entitlement.id;\n      any_changed := true;\n    END IF;\n  END LOOP;\n\n  IF any_changed THEN\n    INSERT INTO \"public\".\"audit_events\" (\n      actor_type, actor_id, action, outcome, resource_type, resource_id,\n      correlation_id, after\n    ) VALUES (\n      'user', locked_user.id::text, 'commerce.guest_claimed', 'succeeded',\n      'guest_identity', locked_identity.id::text, p_correlation_id,\n      pg_catalog.jsonb_build_object(\n        'claimedOrderCount', order_count,\n        'claimedTitleCount', title_count\n      )\n    );\n  END IF;\n\n  UPDATE \"public\".\"commerce_claim_issuances\"\n  SET state = 'consumed', auth_token_sha256 = NULL, normalized_email = NULL,\n    anchor_order_id = NULL, authorized_user_id = NULL, consumed_at = claim_at,\n    result_disposition = 'claimed', result_changed = any_changed,\n    result_order_count = order_count, result_title_count = title_count\n  WHERE claim_proof_sha256 = claim_digest;\n  RETURN QUERY SELECT true, any_changed, order_count, title_count, false, NULL::text;\nEND;\n$function$\n", "volatility": "v", "security_definer": true, "identity_arguments": "p_raw_claim_proof text, p_correlation_id text"}$catalog$::jsonb),
  ('function', 'public', null, 'enforce_financial_allocation_supersession_lineage', '', 'd357155cc4a8aa384aae80919cac4c3abd118ef6697ae7f581b626cb9b5827f5', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": [], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.enforce_financial_allocation_supersession_lineage()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nDECLARE\n  predecessor \"financial_allocation_sets\"%ROWTYPE;\n  reversal_target \"financial_allocation_sets\"%ROWTYPE;\n  parent_classification text;\n  parent_classification_count integer;\n  parent_amount_minor integer;\n  parent_balance_transaction_count integer;\n  valid_lineage boolean := false;\nBEGIN\n  IF NEW.reversal_of_set_id IS NOT NULL THEN\n    SELECT * INTO reversal_target\n    FROM \"financial_allocation_sets\"\n    WHERE id = NEW.reversal_of_set_id;\n    IF NOT FOUND\n      OR reversal_target.source_kind <> NEW.source_kind\n      OR reversal_target.source_internal_id <> NEW.source_internal_id\n      OR reversal_target.basis <> NEW.basis\n      OR reversal_target.currency <> NEW.currency\n      OR reversal_target.reversal_of_set_id IS NOT NULL\n      OR reversal_target.classifier_version <> NEW.classifier_version\n      OR reversal_target.algorithm_version <> NEW.algorithm_version THEN\n      RAISE EXCEPTION 'invalid financial allocation reversal target'\n        USING ERRCODE = '23514',\n          CONSTRAINT = 'financial_allocation_sets_supersession_lineage_check';\n    END IF;\n  END IF;\n\n  IF NEW.supersedes_set_id IS NULL THEN\n    RETURN NEW;\n  END IF;\n\n  SELECT * INTO predecessor\n  FROM \"financial_allocation_sets\"\n  WHERE id = NEW.supersedes_set_id;\n  IF NOT FOUND\n    OR predecessor.balance_transaction_id <> NEW.balance_transaction_id\n    OR predecessor.basis <> NEW.basis\n    OR predecessor.currency <> NEW.currency\n    OR predecessor.expected_effect_minor <> NEW.expected_effect_minor\n    OR predecessor.source_fingerprint_sha256 <> NEW.source_fingerprint_sha256\n    OR predecessor.classifier_version > NEW.classifier_version\n    OR predecessor.algorithm_version > NEW.algorithm_version THEN\n    RAISE EXCEPTION 'invalid financial allocation predecessor'\n      USING ERRCODE = '23514',\n        CONSTRAINT = 'financial_allocation_sets_supersession_lineage_check';\n  END IF;\n\n  valid_lineage := COALESCE(predecessor.source_kind = NEW.source_kind\n    AND predecessor.source_internal_id = NEW.source_internal_id\n    AND (\n      predecessor.reversal_of_set_id IS NOT DISTINCT FROM NEW.reversal_of_set_id\n      OR (\n        predecessor.reversal_of_set_id IS NOT NULL\n        AND NEW.reversal_of_set_id IS NOT NULL\n        AND reversal_target.supersedes_set_id = predecessor.reversal_of_set_id\n      )\n    ), false);\n\n  IF NOT valid_lineage\n    AND predecessor.source_kind = 'adjustment'\n    AND predecessor.source_internal_id = NEW.balance_transaction_id\n    AND predecessor.scope = 'account'\n    AND predecessor.reversal_of_set_id IS NULL\n    AND NEW.source_kind IN ('payment', 'refund', 'dispute') THEN\n    SELECT min(classification::text), count(*)::integer\n      INTO parent_classification, parent_classification_count\n    FROM \"financial_classification_versions\"\n    WHERE subject_type = 'balance_transaction'\n      AND subject_id = NEW.balance_transaction_id\n      AND classifier_version = NEW.classifier_version\n      AND source_fingerprint_sha256 = NEW.source_fingerprint_sha256;\n    SELECT min(amount_minor), count(*)::integer\n      INTO parent_amount_minor, parent_balance_transaction_count\n    FROM \"stripe_balance_transactions\"\n    WHERE id = NEW.balance_transaction_id;\n    valid_lineage := COALESCE(\n      parent_classification_count = 1\n      AND parent_balance_transaction_count = 1\n      AND CASE\n        WHEN NEW.reversal_of_set_id IS NULL THEN\n          (NEW.source_kind = 'payment' AND parent_classification = 'charge'\n            AND parent_amount_minor > 0)\n          OR (NEW.source_kind = 'refund' AND (\n            (parent_classification = 'refund' AND parent_amount_minor < 0)\n            OR (parent_classification = 'refund_failure' AND parent_amount_minor > 0)\n          ))\n          OR (NEW.source_kind = 'dispute' AND (\n            (parent_classification = 'dispute_withdrawal' AND parent_amount_minor < 0)\n            OR (parent_classification IN ('dispute_reinstatement', 'fee_credit')\n              AND parent_amount_minor > 0)\n          ))\n        ELSE\n          NEW.basis = 'gross_amount'\n          AND NEW.expected_effect_minor > 0\n          AND parent_amount_minor > 0\n          AND (\n            (NEW.source_kind = 'refund' AND parent_classification = 'refund_failure')\n            OR (NEW.source_kind = 'dispute'\n              AND parent_classification = 'dispute_reinstatement')\n          )\n        END,\n      false\n    );\n  END IF;\n\n  IF valid_lineage IS NOT TRUE THEN\n    RAISE EXCEPTION 'invalid financial allocation supersession lineage'\n      USING ERRCODE = '23514',\n        CONSTRAINT = 'financial_allocation_sets_supersession_lineage_check';\n  END IF;\n  RETURN NEW;\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'outbox_message_deduplication_metadata', 'text, text, jsonb', '94c1ab42cf98223ba79cd09ecd53f3f3f0b8cdc911626e47f21552f8a36ef94a', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": ["search_path=pg_catalog"], "result": "TABLE(id uuid)", "strict": false, "language": "sql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.outbox_message_deduplication_metadata(p_deduplication_key text, p_topic text, p_expected_payload jsonb)\n RETURNS TABLE(id uuid)\n LANGUAGE sql\n STABLE SECURITY DEFINER\n SET search_path TO 'pg_catalog'\nAS $function$\n  SELECT message.id\n  FROM \"public\".\"outbox_messages\" message\n  WHERE p_deduplication_key IS NOT NULL\n    AND p_topic IS NOT NULL\n    AND p_expected_payload IS NOT NULL\n    AND message.deduplication_key = p_deduplication_key\n    AND message.topic = p_topic\n    AND message.payload = p_expected_payload\n  LIMIT 1;\n$function$\n", "volatility": "s", "security_definer": true, "identity_arguments": "p_deduplication_key text, p_topic text, p_expected_payload jsonb"}$catalog$::jsonb),
  ('function', 'public', null, 'outbox_message_exists_by_deduplication_key', 'text', 'd51e50fe9e3871fb6ae65aa872947fd87613a15ccc2aedf4e649616bdaa45a4d', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": ["search_path=pg_catalog"], "result": "boolean", "strict": false, "language": "sql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.outbox_message_exists_by_deduplication_key(p_deduplication_key text)\n RETURNS boolean\n LANGUAGE sql\n STABLE SECURITY DEFINER\n SET search_path TO 'pg_catalog'\nAS $function$\n  SELECT p_deduplication_key IS NOT NULL AND EXISTS (\n    SELECT 1\n    FROM \"public\".\"outbox_messages\" message\n    WHERE message.deduplication_key = p_deduplication_key\n  );\n$function$\n", "volatility": "s", "security_definer": true, "identity_arguments": "p_deduplication_key text"}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_guard_audit_insert', '', '277a7b2d65da7f61e42cce1daabff2b61683d446dd54c9bbe3ee1010e84ec05c', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": ["search_path=pg_catalog"], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_guard_audit_insert()\n RETURNS trigger\n LANGUAGE plpgsql\n SET search_path TO 'pg_catalog'\nAS $function$\nDECLARE\n  claim_owner name;\nBEGIN\n  IF NOT (\n    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')\n    AND NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')\n  ) THEN\n    RETURN NEW;\n  END IF;\n\n  IF NEW.action = 'commerce.guest_claimed' THEN\n    SELECT pg_catalog.pg_get_userbyid(routine.proowner)\n    INTO claim_owner\n    FROM pg_catalog.pg_proc routine\n    WHERE routine.oid = pg_catalog.to_regprocedure(\n      'public.claim_guest_purchases_after_authorization(text,text)'\n    );\n    IF current_user = claim_owner\n      AND NEW.actor_type = 'user'\n      AND NEW.actor_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'\n      AND NEW.outcome = 'succeeded'\n      AND NEW.resource_type = 'guest_identity'\n      AND NEW.resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'\n      AND NEW.correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'\n      AND NEW.request_metadata IS NULL\n      AND NEW.before IS NULL\n      AND pg_catalog.jsonb_typeof(NEW.after) = 'object'\n      AND NEW.after - 'claimedOrderCount' - 'claimedTitleCount' = '{}'::jsonb\n      AND pg_catalog.jsonb_typeof(NEW.after -> 'claimedOrderCount') = 'number'\n      AND pg_catalog.jsonb_typeof(NEW.after -> 'claimedTitleCount') = 'number'\n      AND NEW.after ->> 'claimedOrderCount' ~ '^[1-9][0-9]{0,8}$'\n      AND NEW.after ->> 'claimedTitleCount' ~ '^[1-9][0-9]{0,8}$'\n    THEN\n      RETURN NEW;\n    END IF;\n    RAISE EXCEPTION USING ERRCODE = '42501',\n      MESSAGE = 'commerce guest claim audit provenance is reserved';\n  END IF;\n\n  IF NEW.action LIKE 'financial.%' OR NEW.action IN (\n    'commerce.fulfillment_paid',\n    'commerce.fulfillment_exception',\n    'commerce.refund_reconciled',\n    'commerce.dispute_reconciled',\n    'catalog.revision.ingest.succeeded',\n    'catalog.revision.ingest.failed'\n  ) OR NEW.actor_id IN (\n    'commerce-worker',\n    'financial-worker',\n    'publication-ingestion-worker'\n  ) THEN\n    RAISE EXCEPTION USING ERRCODE = '55000',\n      MESSAGE = 'worker audit provenance is reserved';\n  END IF;\n  RETURN NEW;\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_guard_financial_issue_subject_mutation', '', '770db0642e0b94474a9907f21f43f081cd1d8ca0a6c3760b2ce4f2f1b43c0ac2', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": [], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_guard_financial_issue_subject_mutation()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nDECLARE\n  subject_resource_type text;\nBEGIN\n  IF TG_OP = 'UPDATE' AND NEW.id IS NOT DISTINCT FROM OLD.id THEN\n    RETURN NEW;\n  END IF;\n  subject_resource_type := CASE TG_TABLE_NAME\n    WHEN 'payments' THEN 'payment'\n    WHEN 'refunds' THEN 'refund'\n    WHEN 'disputes' THEN 'dispute'\n    ELSE NULL\n  END;\n  IF subject_resource_type IS NULL THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid financial issue subject guard';\n  END IF;\n  IF EXISTS (\n    SELECT 1\n    FROM \"public\".\"financial_reconciliation_issues\" issue\n    WHERE issue.resource_type = subject_resource_type\n      AND issue.resource_id = OLD.id\n  ) THEN\n    RAISE EXCEPTION USING ERRCODE = '55000',\n      MESSAGE = 'financial issue subjects cannot be deleted or reidentified';\n  END IF;\n  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;\n  RETURN NEW;\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_guard_guest_identity_update', '', '73138467f84a1c750fe3ea997b5814cd0f94bec0d78d2cfdae7f5ba75c03a79e', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": ["search_path=pg_catalog"], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_guard_guest_identity_update()\n RETURNS trigger\n LANGUAGE plpgsql\n SET search_path TO 'pg_catalog'\nAS $function$\nDECLARE\n  claim_owner name;\nBEGIN\n  SELECT pg_catalog.pg_get_userbyid(routine.proowner)\n  INTO claim_owner\n  FROM pg_catalog.pg_proc routine\n  WHERE routine.oid = pg_catalog.to_regprocedure(\n    'public.claim_guest_purchases_after_authorization(text,text)'\n  );\n  IF current_user = claim_owner THEN\n    RETURN NEW;\n  END IF;\n  IF pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER') THEN\n    RAISE EXCEPTION USING ERRCODE = '42501',\n      MESSAGE = 'guest identity mutation is reserved';\n  END IF;\n  RETURN NEW;\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_guard_job_insert', '', 'b2bcc4c8b727849243baded8d305b662740c6ca0c6b05940ceea7394e2915e21', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": ["search_path=pg_catalog"], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_guard_job_insert()\n RETURNS trigger\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog'\nAS $function$\nDECLARE\n  referenced_id uuid;\n  referenced_generation integer;\n  stripe_provider_event_id text;\n  stripe_event_status \"public\".\"stripe_event_status\";\n  revision_state \"public\".\"revision_state\";\n  revision_generation integer;\n  claim_order \"public\".\"orders\"%ROWTYPE;\nBEGIN\n  IF NOT (\n    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')\n    AND NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')\n  ) THEN\n    RETURN NEW;\n  END IF;\n  IF NEW.status <> 'pending' OR NEW.attempts <> 0 OR\n    NEW.locked_at IS NOT NULL OR NEW.locked_by IS NOT NULL OR\n    NEW.last_error IS NOT NULL OR NEW.rerun_requested_at IS NOT NULL OR\n    NEW.completed_at IS NOT NULL OR NEW.run_at IS DISTINCT FROM NEW.created_at OR\n    NEW.created_at IS DISTINCT FROM NEW.updated_at OR NEW.deduplication_key IS NULL THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid web job defaults';\n  END IF;\n\n  IF NEW.type = 'commerce.stripe-event' THEN\n    IF NOT pg_catalog.pg_input_is_valid(NEW.payload ->> 'stripeEventId', 'uuid') THEN\n      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid Stripe event job identity';\n    END IF;\n    referenced_id := (NEW.payload ->> 'stripeEventId')::uuid;\n    IF NEW.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(\n        'stripeEventId', referenced_id\n      ) OR NEW.max_attempts <> 12 THEN\n      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid Stripe event job identity';\n    END IF;\n    SELECT event.provider_event_id, event.status\n    INTO stripe_provider_event_id, stripe_event_status\n    FROM \"public\".\"stripe_events\" event\n    WHERE event.id = referenced_id\n    FOR KEY SHARE;\n    IF NOT FOUND OR stripe_event_status <> 'pending' OR\n      NEW.deduplication_key IS DISTINCT FROM\n        'stripe:event:' || stripe_provider_event_id THEN\n      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid Stripe event job identity';\n    END IF;\n    RETURN NEW;\n  END IF;\n\n  IF NEW.type = 'catalog.ingest_revision' THEN\n    IF NOT pg_catalog.pg_input_is_valid(NEW.payload ->> 'revisionId', 'uuid') OR\n      NOT pg_catalog.pg_input_is_valid(NEW.payload ->> 'generation', 'integer') THEN\n      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid revision job identity';\n    END IF;\n    referenced_id := (NEW.payload ->> 'revisionId')::uuid;\n    referenced_generation := (NEW.payload ->> 'generation')::integer;\n    IF referenced_generation < 0 OR NEW.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(\n        'revisionId', referenced_id, 'generation', referenced_generation\n      ) OR NEW.max_attempts <> 5 OR NEW.deduplication_key IS DISTINCT FROM\n        'catalog.ingest:' || referenced_id::text || ':' || referenced_generation::text THEN\n      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid revision job identity';\n    END IF;\n    SELECT revision.state, revision.ingestion_generation\n    INTO revision_state, revision_generation\n    FROM \"public\".\"title_revisions\" revision\n    WHERE revision.id = referenced_id\n    FOR KEY SHARE;\n    IF NOT FOUND OR revision_state <> 'uploaded' OR\n      revision_generation IS DISTINCT FROM referenced_generation THEN\n      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid revision job identity';\n    END IF;\n    RETURN NEW;\n  END IF;\n\n  IF NEW.type = 'commerce.claim-email-request' THEN\n    IF NOT pg_catalog.pg_input_is_valid(NEW.payload ->> 'orderId', 'uuid') THEN\n      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid claim request job identity';\n    END IF;\n    referenced_id := (NEW.payload ->> 'orderId')::uuid;\n    IF NEW.payload IS DISTINCT FROM pg_catalog.jsonb_build_object('orderId', referenced_id) OR\n      NEW.max_attempts <> 8 OR NEW.deduplication_key !~\n        ('^commerce:claim-request:order:' || referenced_id::text ||\n          ':window:[0-9]+:v1$') THEN\n      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid claim request job identity';\n    END IF;\n    SELECT * INTO claim_order\n    FROM \"public\".\"orders\" purchase_order\n    WHERE purchase_order.id = referenced_id\n    FOR KEY SHARE;\n    IF NOT FOUND OR claim_order.status <> 'paid' OR\n      claim_order.initiating_user_id IS NOT NULL OR claim_order.guest_identity_id IS NULL OR\n      claim_order.purchase_email IS NULL THEN\n      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid claim request job identity';\n    END IF;\n    RETURN NEW;\n  END IF;\n\n  IF NEW.type = 'outbox.dispatch' THEN\n    IF NOT pg_catalog.pg_input_is_valid(NEW.payload ->> 'outboxId', 'uuid') THEN\n      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid outbox job identity';\n    END IF;\n    referenced_id := (NEW.payload ->> 'outboxId')::uuid;\n    IF NEW.payload IS DISTINCT FROM pg_catalog.jsonb_build_object('outboxId', referenced_id) OR\n      NEW.max_attempts <> 8 OR NOT (\n        NEW.deduplication_key = 'outbox:' || referenced_id::text OR\n        NEW.deduplication_key ~ '^outbox-key:[0-9a-f]{64}$'\n      ) THEN\n      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid outbox job identity';\n    END IF;\n    RETURN NEW;\n  END IF;\n\n  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'web job type is not permitted';\nEND;\n$function$\n", "volatility": "v", "security_definer": true, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_guard_order_item_insert', '', '08c09c63087fd6efb9ea806bf3b6317bdd20226e2e60639132354f2891b91aeb', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": ["search_path=pg_catalog"], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_guard_order_item_insert()\n RETURNS trigger\n LANGUAGE plpgsql\n SET search_path TO 'pg_catalog'\nAS $function$\nDECLARE\n  parent_order \"public\".\"orders\"%ROWTYPE;\nBEGIN\n  IF NOT (\n    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')\n    AND NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')\n  ) THEN\n    RETURN NEW;\n  END IF;\n  SELECT * INTO parent_order\n  FROM \"public\".\"orders\" purchase_order\n  WHERE purchase_order.id = NEW.order_id\n  FOR UPDATE;\n  IF NOT FOUND THEN\n    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'order item parent does not exist';\n  END IF;\n  IF parent_order.status <> 'checkout_pending' OR\n    parent_order.guest_identity_id IS NOT NULL OR\n    parent_order.tax_minor IS NOT NULL OR parent_order.total_minor IS NOT NULL OR\n    parent_order.stripe_checkout_session_id IS NOT NULL OR\n    parent_order.checkout_expires_at IS NOT NULL OR parent_order.paid_at IS NOT NULL OR\n    NEW.currency IS DISTINCT FROM parent_order.currency OR\n    NEW.tax_minor IS NOT NULL OR NEW.total_minor IS NOT NULL OR\n    NEW.stripe_line_item_id IS NOT NULL THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid web order item creation';\n  END IF;\n  RETURN NEW;\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_guard_order_write', '', '3e4d372097bef4ce58fbd2f9728efc386d7ca6c0d19a9b5c974a02b158086248', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": ["search_path=pg_catalog"], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_guard_order_write()\n RETURNS trigger\n LANGUAGE plpgsql\n SET search_path TO 'pg_catalog'\nAS $function$\nDECLARE\n  expected_email text;\nBEGIN\n  IF NOT (\n    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')\n    AND NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')\n  ) THEN\n    RETURN NEW;\n  END IF;\n\n  IF TG_OP = 'INSERT' THEN\n    IF NEW.status <> 'checkout_pending' OR NEW.guest_identity_id IS NOT NULL OR\n      NEW.tax_minor IS NOT NULL OR NEW.total_minor IS NOT NULL OR\n      NEW.stripe_checkout_session_id IS NOT NULL OR NEW.checkout_expires_at IS NOT NULL OR\n      NEW.paid_at IS NOT NULL OR NEW.created_at IS DISTINCT FROM NEW.updated_at THEN\n      RAISE EXCEPTION USING ERRCODE = '55000',\n        MESSAGE = 'invalid web order creation';\n    END IF;\n    IF NEW.initiating_user_id IS NULL THEN\n      IF NEW.purchase_email IS NOT NULL THEN\n        RAISE EXCEPTION USING ERRCODE = '55000',\n          MESSAGE = 'anonymous order identity must be empty';\n      END IF;\n    ELSE\n      SELECT pg_catalog.lower(pg_catalog.btrim(account.email))\n      INTO expected_email\n      FROM \"public\".\"user\" account\n      WHERE account.id = NEW.initiating_user_id AND account.email_verified\n      FOR KEY SHARE;\n      IF NOT FOUND OR NEW.purchase_email IS DISTINCT FROM expected_email THEN\n        RAISE EXCEPTION USING ERRCODE = '55000',\n          MESSAGE = 'account order identity is not verified';\n      END IF;\n    END IF;\n    RETURN NEW;\n  END IF;\n\n  IF NEW.id IS DISTINCT FROM OLD.id OR\n    NEW.initiating_user_id IS DISTINCT FROM OLD.initiating_user_id OR\n    NEW.guest_identity_id IS DISTINCT FROM OLD.guest_identity_id OR\n    NEW.purchase_email IS DISTINCT FROM OLD.purchase_email OR\n    NEW.currency IS DISTINCT FROM OLD.currency OR\n    NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor OR\n    NEW.tax_minor IS DISTINCT FROM OLD.tax_minor OR\n    NEW.total_minor IS DISTINCT FROM OLD.total_minor OR\n    NEW.client_checkout_attempt_id IS DISTINCT FROM OLD.client_checkout_attempt_id OR\n    NEW.quote_fingerprint_sha256 IS DISTINCT FROM OLD.quote_fingerprint_sha256 OR\n    NEW.status_token_sha256 IS DISTINCT FROM OLD.status_token_sha256 OR\n    NEW.paid_at IS DISTINCT FROM OLD.paid_at OR\n    NEW.created_at IS DISTINCT FROM OLD.created_at OR\n    NEW.updated_at < OLD.updated_at OR\n    NEW.updated_at > pg_catalog.clock_timestamp() + interval '5 minutes' THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid web order mutation';\n  END IF;\n\n  IF OLD.status = 'checkout_pending' AND NEW.status = 'checkout_open' AND (\n      (OLD.stripe_checkout_session_id IS NULL AND OLD.checkout_expires_at IS NULL AND\n        NEW.stripe_checkout_session_id IS NOT NULL AND NEW.checkout_expires_at IS NOT NULL)\n      OR\n      (OLD.stripe_checkout_session_id IS NOT NULL AND\n        NEW.stripe_checkout_session_id IS NOT DISTINCT FROM OLD.stripe_checkout_session_id AND\n        NEW.checkout_expires_at IS NOT DISTINCT FROM OLD.checkout_expires_at)\n    ) THEN\n    RETURN NEW;\n  END IF;\n  IF OLD.status IN ('checkout_pending', 'checkout_open', 'payment_pending') AND\n    NEW.status = 'exception' AND\n    NEW.stripe_checkout_session_id IS NOT DISTINCT FROM OLD.stripe_checkout_session_id AND\n    NEW.checkout_expires_at IS NOT DISTINCT FROM OLD.checkout_expires_at THEN\n    RETURN NEW;\n  END IF;\n  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid web order transition';\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_guard_outbox_insert', '', '2def27e2f1fb3abad60d4cd18c8b0c60bdae61775acaef6d53585a86f0c770a0', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": ["search_path=pg_catalog"], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_guard_outbox_insert()\n RETURNS trigger\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog'\nAS $function$\nDECLARE\n  dispatch_job \"public\".\"jobs\"%ROWTYPE;\nBEGIN\n  IF NOT (\n    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')\n    AND NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')\n  ) THEN\n    RETURN NEW;\n  END IF;\n  SELECT * INTO dispatch_job\n  FROM \"public\".\"jobs\" queued_job\n  WHERE queued_job.id = NEW.dispatch_job_id\n  FOR KEY SHARE;\n  IF NOT FOUND OR dispatch_job.type <> 'outbox.dispatch' OR\n    dispatch_job.payload IS DISTINCT FROM pg_catalog.jsonb_build_object('outboxId', NEW.id) OR\n    dispatch_job.status <> 'pending' OR dispatch_job.max_attempts <> 8 OR\n    NEW.status <> 'pending' OR NEW.last_error IS NOT NULL OR NEW.delivered_at IS NOT NULL OR\n    NEW.created_at IS DISTINCT FROM NEW.updated_at OR\n    (NEW.deduplication_key IS NULL AND\n      dispatch_job.deduplication_key IS DISTINCT FROM 'outbox:' || NEW.id::text) OR\n    (NEW.deduplication_key IS NOT NULL AND\n      dispatch_job.deduplication_key !~ '^outbox-key:[0-9a-f]{64}$') THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid web outbox creation';\n  END IF;\n  RETURN NEW;\nEND;\n$function$\n", "volatility": "v", "security_definer": true, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_guard_title_revision_write', '', '1dee4e7433c8eaa314840181392a6e1fd14f1d5c774ace526c1c181cb55aa92c', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": ["search_path=pg_catalog"], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_guard_title_revision_write()\n RETURNS trigger\n LANGUAGE plpgsql\n SET search_path TO 'pg_catalog'\nAS $function$\nBEGIN\n  IF NOT (\n    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')\n    AND NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')\n  ) THEN\n    RETURN NEW;\n  END IF;\n\n  IF TG_OP = 'INSERT' THEN\n    IF NEW.state <> 'uploaded' OR NEW.ingestion_generation <> 0 OR\n      NEW.derivation_version <> 1 OR NEW.original_storage_key IS NOT NULL OR\n      NEW.original_checksum_sha256 IS NOT NULL OR NEW.original_mime_type IS NOT NULL OR\n      NEW.original_byte_size IS NOT NULL OR NEW.original_filename IS NOT NULL OR\n      NEW.failure_code IS NOT NULL OR NEW.failure_details IS NOT NULL OR\n      NEW.processing_started_at IS NOT NULL OR NEW.processed_at IS NOT NULL OR\n      NEW.activated_at IS NOT NULL OR NEW.retired_at IS NOT NULL OR NOT (\n        (NEW.staging_storage_key IS NULL AND NEW.staging_checksum_sha256 IS NULL AND\n          NEW.staging_byte_size IS NULL AND NEW.upload_filename IS NULL AND\n          NEW.upload_mime_type IS NULL)\n        OR\n        (NEW.staging_storage_key IS NOT NULL AND NEW.staging_checksum_sha256 IS NOT NULL AND\n          NEW.staging_byte_size IS NOT NULL AND NEW.upload_filename IS NOT NULL AND\n          NEW.upload_mime_type IS NOT NULL)\n      ) THEN\n      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid web revision creation';\n    END IF;\n    RETURN NEW;\n  END IF;\n\n  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.title_id IS DISTINCT FROM OLD.title_id OR\n    NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id OR\n    NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id OR\n    NEW.change_summary IS DISTINCT FROM OLD.change_summary OR\n    NEW.staging_checksum_sha256 IS DISTINCT FROM OLD.staging_checksum_sha256 OR\n    NEW.staging_byte_size IS DISTINCT FROM OLD.staging_byte_size OR\n    NEW.upload_filename IS DISTINCT FROM OLD.upload_filename OR\n    NEW.upload_mime_type IS DISTINCT FROM OLD.upload_mime_type OR\n    NEW.derivation_version IS DISTINCT FROM OLD.derivation_version OR\n    NEW.original_storage_key IS DISTINCT FROM OLD.original_storage_key OR\n    NEW.original_checksum_sha256 IS DISTINCT FROM OLD.original_checksum_sha256 OR\n    NEW.original_mime_type IS DISTINCT FROM OLD.original_mime_type OR\n    NEW.original_byte_size IS DISTINCT FROM OLD.original_byte_size OR\n    NEW.original_filename IS DISTINCT FROM OLD.original_filename OR\n    NEW.created_at IS DISTINCT FROM OLD.created_at THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid web revision mutation';\n  END IF;\n\n  IF OLD.state = 'failed' AND NEW.state = 'uploaded' AND\n    OLD.staging_storage_key IS NOT NULL AND OLD.staging_checksum_sha256 IS NOT NULL AND\n    OLD.staging_byte_size IS NOT NULL AND OLD.upload_filename IS NOT NULL AND\n    OLD.upload_mime_type IS NOT NULL AND NEW.staging_storage_key IS NOT NULL AND\n    NEW.staging_storage_key IS DISTINCT FROM OLD.staging_storage_key AND\n    NEW.ingestion_generation = OLD.ingestion_generation + 1 AND\n    NEW.processing_started_at IS NULL AND NEW.processed_at IS NULL AND\n    NEW.failure_code IS NULL AND NEW.failure_details IS NULL AND\n    NEW.activated_at IS NOT DISTINCT FROM OLD.activated_at AND\n    NEW.retired_at IS NOT DISTINCT FROM OLD.retired_at THEN\n    RETURN NEW;\n  END IF;\n\n  IF OLD.state IN ('ready_for_review', 'retired') AND NEW.state = 'active' AND\n    NEW.staging_storage_key IS NOT DISTINCT FROM OLD.staging_storage_key AND\n    NEW.ingestion_generation IS NOT DISTINCT FROM OLD.ingestion_generation AND\n    NEW.processing_started_at IS NOT DISTINCT FROM OLD.processing_started_at AND\n    NEW.processed_at IS NOT DISTINCT FROM OLD.processed_at AND\n    NEW.failure_code IS NOT DISTINCT FROM OLD.failure_code AND\n    NEW.failure_details IS NOT DISTINCT FROM OLD.failure_details AND\n    NEW.activated_at IS NOT NULL AND NEW.retired_at IS NULL AND\n    NEW.original_storage_key IS NOT NULL AND NEW.original_checksum_sha256 IS NOT NULL AND\n    NEW.original_mime_type IS NOT NULL AND NEW.original_byte_size IS NOT NULL AND\n    NEW.original_filename IS NOT NULL AND NEW.staging_storage_key IS NULL AND\n    NEW.staging_checksum_sha256 IS NULL AND NEW.staging_byte_size IS NULL AND\n    NEW.processing_started_at IS NOT NULL AND NEW.processed_at IS NOT NULL AND\n    NEW.failure_code IS NULL AND NEW.failure_details IS NULL AND\n    NEW.activated_at >= NEW.processed_at AND EXISTS (\n      SELECT 1 FROM \"public\".\"revision_presentations\" presentation\n      WHERE presentation.revision_id = NEW.id AND presentation.state = 'published'\n    ) THEN\n    RETURN NEW;\n  END IF;\n\n  IF OLD.state = 'active' AND NEW.state = 'retired' AND\n    NEW.staging_storage_key IS NOT DISTINCT FROM OLD.staging_storage_key AND\n    NEW.ingestion_generation IS NOT DISTINCT FROM OLD.ingestion_generation AND\n    NEW.processing_started_at IS NOT DISTINCT FROM OLD.processing_started_at AND\n    NEW.processed_at IS NOT DISTINCT FROM OLD.processed_at AND\n    NEW.failure_code IS NOT DISTINCT FROM OLD.failure_code AND\n    NEW.failure_details IS NOT DISTINCT FROM OLD.failure_details AND\n    NEW.activated_at IS NOT DISTINCT FROM OLD.activated_at AND\n    NEW.retired_at IS NOT NULL AND NEW.retired_at >= NEW.activated_at THEN\n    RETURN NEW;\n  END IF;\n\n  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid web revision transition';\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_reject_history_mutation', '', 'd9e52b0beb45e62a4e442b84cc63061c583c7a6e90c7323037b52b7491da43b8', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": [], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_reject_history_mutation()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = format('%s is append-only', TG_TABLE_NAME);\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_validate_balance_transaction_transition', '', '9309e5cc490f8245c0555327636d12e4f0841f577331fb0b5e7f5eff3cf73974', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": [], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_validate_balance_transaction_transition()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  IF TG_OP = 'DELETE' THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'balance transaction history cannot be deleted';\n  END IF;\n  IF NEW.id IS DISTINCT FROM OLD.id OR\n     NEW.provider_id IS DISTINCT FROM OLD.provider_id OR\n     NEW.live_mode IS DISTINCT FROM OLD.live_mode OR\n     NEW.source_family IS DISTINCT FROM OLD.source_family OR\n     NEW.source_id IS DISTINCT FROM OLD.source_id OR\n     NEW.raw_type IS DISTINCT FROM OLD.raw_type OR\n     NEW.reporting_category IS DISTINCT FROM OLD.reporting_category OR\n     NEW.balance_type IS DISTINCT FROM OLD.balance_type OR\n     NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR\n     NEW.fee_minor IS DISTINCT FROM OLD.fee_minor OR\n     NEW.net_minor IS DISTINCT FROM OLD.net_minor OR\n     NEW.currency IS DISTINCT FROM OLD.currency OR\n     NEW.provider_created_at IS DISTINCT FROM OLD.provider_created_at OR\n     NEW.available_at IS DISTINCT FROM OLD.available_at OR\n     NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate OR\n     NEW.exchange_source_currency IS DISTINCT FROM OLD.exchange_source_currency OR\n     NEW.exchange_target_currency IS DISTINCT FROM OLD.exchange_target_currency OR\n     NEW.fingerprint_sha256 IS DISTINCT FROM OLD.fingerprint_sha256 OR\n     NEW.first_imported_at IS DISTINCT FROM OLD.first_imported_at OR\n     NOT (NEW.status = OLD.status OR (OLD.status = 'pending' AND NEW.status = 'available')) OR\n     NEW.last_imported_at < OLD.last_imported_at THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid balance transaction history mutation';\n  END IF;\n  RETURN NEW;\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_validate_dispute_gross_allocation_set', '', '27f6fc20787d5afc7b95df7ac3f70d7f816f312fa817738db48baeb294819ec5', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": [], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_validate_dispute_gross_allocation_set()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  IF NOT EXISTS (\n    SELECT 1\n    FROM \"public\".\"financial_allocation_sets\" allocation_set\n    WHERE allocation_set.id = NEW.gross_allocation_set_id\n      AND allocation_set.source_kind = 'dispute'\n      AND allocation_set.source_internal_id = NEW.dispute_id\n      AND allocation_set.basis = 'gross_amount'\n  ) THEN\n    RAISE EXCEPTION USING\n      ERRCODE = '23514',\n      MESSAGE = 'invalid dispute gross allocation set linkage';\n  END IF;\n  RETURN NEW;\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_validate_finalization_effect_insert', '', 'f15e629273d61a1db49f99d71c446ee4a87512d70144d1ee7407f1d53254363e', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": [], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_validate_finalization_effect_insert()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  IF NOT EXISTS (\n    SELECT 1\n    FROM \"refund_allocations\" allocation\n    JOIN \"refund_allocation_drafts\" draft\n      ON draft.id = NEW.draft_id\n     AND draft.refund_id = NEW.refund_id\n     AND draft.version = NEW.draft_version\n     AND draft.state = 'finalized'\n    JOIN \"refund_allocation_draft_items\" draft_item\n      ON draft_item.draft_id = draft.id\n     AND draft_item.order_item_id = NEW.order_item_id\n    JOIN \"entitlement_grants\" purchase_grant\n      ON purchase_grant.id = NEW.purchase_grant_id\n     AND purchase_grant.order_item_id = NEW.order_item_id\n     AND purchase_grant.source = 'purchase'\n     AND purchase_grant.state = NEW.after_purchase_grant_state\n    WHERE allocation.id = NEW.refund_allocation_id\n      AND allocation.refund_id = NEW.refund_id\n      AND allocation.order_item_id = NEW.order_item_id\n      AND allocation.source = 'administrative'\n  ) THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid refund finalization provenance insert';\n  END IF;\n  RETURN NEW;\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_validate_issue_insert', '', 'd3ad6ee7765a87014153aa2eb49b48941c928d4fe2c99539a1f3fa81b64c9a62', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": [], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_validate_issue_insert()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  IF NEW.state <> 'open' OR NEW.resolved_at IS NOT NULL OR NEW.resolved_by_admin_id IS NOT NULL THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'financial issues must be inserted open';\n  END IF;\n  CASE NEW.resource_type\n    WHEN 'payment' THEN\n      PERFORM 1 FROM \"public\".\"payments\" subject WHERE subject.id = NEW.resource_id FOR KEY SHARE;\n    WHEN 'refund' THEN\n      PERFORM 1 FROM \"public\".\"refunds\" subject WHERE subject.id = NEW.resource_id FOR KEY SHARE;\n    WHEN 'dispute' THEN\n      PERFORM 1 FROM \"public\".\"disputes\" subject WHERE subject.id = NEW.resource_id FOR KEY SHARE;\n    WHEN 'payout' THEN\n      PERFORM 1 FROM \"public\".\"stripe_payouts\" subject WHERE subject.id = NEW.resource_id FOR KEY SHARE;\n    WHEN 'balance_transaction' THEN\n      PERFORM 1 FROM \"public\".\"stripe_balance_transactions\" subject WHERE subject.id = NEW.resource_id FOR KEY SHARE;\n    WHEN 'allocation_set' THEN\n      PERFORM 1 FROM \"public\".\"financial_allocation_sets\" subject WHERE subject.id = NEW.resource_id FOR KEY SHARE;\n    WHEN 'financial_classification' THEN\n      PERFORM 1\n      FROM \"public\".\"financial_classification_versions\" subject\n      WHERE subject.id = NEW.resource_id AND subject.classification = 'unknown'\n      FOR KEY SHARE;\n      IF NOT FOUND THEN\n        IF EXISTS (\n          SELECT 1 FROM \"public\".\"financial_classification_versions\" subject\n          WHERE subject.id = NEW.resource_id\n        ) THEN\n          RAISE EXCEPTION USING ERRCODE = '23514',\n            MESSAGE = 'financial classification issues require an unknown classification';\n        END IF;\n        RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'financial issue resource does not exist';\n      END IF;\n      RETURN NEW;\n    ELSE\n      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid financial issue resource identity';\n  END CASE;\n  IF NOT FOUND THEN\n    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'financial issue resource does not exist';\n  END IF;\n  RETURN NEW;\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_validate_issue_transition', '', '6a08b460fcefd9effb5d4bd465088b0881ecffa023cc48e49b6f99f665332e6b', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": [], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_validate_issue_transition()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  IF TG_OP = 'DELETE' THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'financial issue history cannot be deleted';\n  END IF;\n  IF OLD.resource_type = 'financial_classification'\n    AND OLD.safe_code = 'unsupported_category'\n    AND NEW.state <> 'open' THEN\n    RAISE EXCEPTION USING ERRCODE = '55000',\n      MESSAGE = 'immutable classification diagnostics cannot be resolved';\n  END IF;\n  IF OLD.state = 'resolved' THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'resolved financial issue history is immutable';\n  END IF;\n  IF NEW.state = 'resolved' THEN\n    IF current_setting('pale_orbit.financial_worker_issue_resolution', true)\n        IS DISTINCT FROM OLD.id::text OR\n      current_user IS DISTINCT FROM (\n        SELECT pg_catalog.pg_get_userbyid(worker_resolver.proowner)\n        FROM pg_catalog.pg_proc worker_resolver\n        WHERE worker_resolver.oid =\n          'public.resolve_financial_issue_after_worker_recompute(uuid,text)'::pg_catalog.regprocedure\n      ) OR\n      NEW.resolved_by_admin_id IS NOT NULL OR NEW.resolved_at IS NULL OR\n      NEW.occurrence_count <> OLD.occurrence_count OR\n      NEW.last_observed_at IS DISTINCT FROM OLD.last_observed_at THEN\n      RAISE EXCEPTION USING ERRCODE = '55000',\n        MESSAGE = 'financial issue resolution requires the guarded worker resolver';\n    END IF;\n  END IF;\n  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.resource_type IS DISTINCT FROM OLD.resource_type OR\n     NEW.resource_id IS DISTINCT FROM OLD.resource_id OR NEW.safe_code IS DISTINCT FROM OLD.safe_code OR\n     NEW.impact IS DISTINCT FROM OLD.impact OR NEW.first_observed_at IS DISTINCT FROM OLD.first_observed_at OR\n     NEW.correlation_id IS DISTINCT FROM OLD.correlation_id OR NEW.occurrence_count < OLD.occurrence_count OR\n     NEW.last_observed_at < OLD.last_observed_at OR\n     (OLD.state = 'open' AND NEW.state NOT IN ('open', 'resolved')) THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid financial issue history mutation';\n  END IF;\n  RETURN NEW;\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_validate_payout_transition', '', 'cdaa48a39802259348827d4ab59e288b2d36a42b462c2fac9dca3726e1b2e3d9', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": [], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_validate_payout_transition()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nDECLARE\n  reporting_changed boolean;\nBEGIN\n  IF TG_OP = 'DELETE' THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'payout history cannot be deleted';\n  END IF;\n  IF NEW.id IS DISTINCT FROM OLD.id OR\n     NEW.provider_id IS DISTINCT FROM OLD.provider_id OR\n     NEW.live_mode IS DISTINCT FROM OLD.live_mode OR\n     NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR\n     NEW.currency IS DISTINCT FROM OLD.currency OR\n     NEW.automatic IS DISTINCT FROM OLD.automatic OR\n     NEW.method IS DISTINCT FROM OLD.method OR\n     NEW.provider_created_at IS DISTINCT FROM OLD.provider_created_at OR\n     NEW.fingerprint_sha256 IS DISTINCT FROM OLD.fingerprint_sha256 OR\n     NEW.retrieved_at < OLD.retrieved_at OR\n     NEW.financial_generation < OLD.financial_generation OR\n     NEW.financial_generation > OLD.financial_generation + 1 OR\n     NOT (\n       NEW.status = OLD.status OR\n       (OLD.status = 'pending' AND NEW.status IN ('in_transit', 'paid', 'failed', 'canceled')) OR\n       (OLD.status = 'in_transit' AND NEW.status IN ('paid', 'failed', 'canceled')) OR\n       (OLD.status = 'paid' AND NEW.status IN ('failed', 'canceled'))\n     ) OR\n     NOT (\n       NEW.reconciliation_status = OLD.reconciliation_status OR\n       (OLD.reconciliation_status = 'in_progress' AND NEW.reconciliation_status IN ('completed', 'not_applicable'))\n     ) THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid payout history mutation';\n  END IF;\n\n  reporting_changed := ROW(\n    NEW.status, NEW.reconciliation_status, NEW.arrival_at,\n    NEW.balance_transaction_id, NEW.failure_balance_transaction_id,\n    NEW.original_provider_payout_id, NEW.reversed_by_provider_payout_id,\n    NEW.safe_failure_code\n  ) IS DISTINCT FROM ROW(\n    OLD.status, OLD.reconciliation_status, OLD.arrival_at,\n    OLD.balance_transaction_id, OLD.failure_balance_transaction_id,\n    OLD.original_provider_payout_id, OLD.reversed_by_provider_payout_id,\n    OLD.safe_failure_code\n  );\n\n  IF reporting_changed AND NEW.financial_generation = OLD.financial_generation THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'payout reporting transition requires a generation increment';\n  END IF;\n  RETURN NEW;\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_validate_projection_version_transition', '', 'f3a1a1a06d918ca6f6c758a37e45439c5a0cd4458b3a1387de7dd4f7310d15f9', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": [], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_validate_projection_version_transition()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  IF TG_OP = 'DELETE' THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'active financial projection version cannot be deleted';\n  END IF;\n  IF NEW.singleton IS DISTINCT FROM OLD.singleton OR\n     NEW.classifier_version < OLD.classifier_version OR\n     NEW.allocation_algorithm_version < OLD.allocation_algorithm_version OR\n     NEW.activated_at < OLD.activated_at THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid financial projection version transition';\n  END IF;\n  IF NEW.classifier_version = OLD.classifier_version AND\n     NEW.allocation_algorithm_version = OLD.allocation_algorithm_version THEN\n    IF OLD.pending_scan_run_id IS NOT NULL OR NEW.pending_scan_run_id IS NULL OR\n       NEW.activated_at IS DISTINCT FROM OLD.activated_at OR\n       NEW.activation_correlation_id IS DISTINCT FROM OLD.activation_correlation_id THEN\n      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid financial projection version transition';\n    END IF;\n  ELSE\n    IF OLD.pending_scan_run_id IS NULL OR\n       NEW.pending_scan_run_id IS NOT NULL OR\n       NEW.classifier_version IS DISTINCT FROM OLD.pending_classifier_version OR\n       NEW.allocation_algorithm_version IS DISTINCT FROM OLD.pending_allocation_algorithm_version THEN\n      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid financial projection version transition';\n    END IF;\n  END IF;\n  RETURN NEW;\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_validate_refund_draft_item_insert', '', 'b1cae48d571803a4ce9712861c40e9151f3759d2f92368b1af2abf8c423aedb1', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": [], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_validate_refund_draft_item_insert()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  IF NOT EXISTS (\n    SELECT 1 FROM \"refund_allocation_drafts\" draft\n    WHERE draft.id = NEW.draft_id AND draft.state = 'active'\n  ) THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'refund allocation draft items require an active draft';\n  END IF;\n  RETURN NEW;\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_validate_refund_draft_item_transition', '', '02b720fa44de4cc8f0c9c2dda79d7126af6db2ee40cb8dfcef154d9b6085a1b0', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": [], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_validate_refund_draft_item_transition()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  IF TG_OP = 'DELETE' THEN\n    IF NOT EXISTS (SELECT 1 FROM \"refund_allocation_drafts\" draft WHERE draft.id = OLD.draft_id AND draft.state = 'active') THEN\n      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'finalized refund allocation draft item is immutable';\n    END IF;\n    RETURN OLD;\n  END IF;\n  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.draft_id IS DISTINCT FROM OLD.draft_id OR\n     NEW.order_item_id IS DISTINCT FROM OLD.order_item_id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR\n     NEW.updated_at < OLD.updated_at OR\n     NOT EXISTS (SELECT 1 FROM \"refund_allocation_drafts\" draft WHERE draft.id = OLD.draft_id AND draft.state = 'active') THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid refund allocation draft item transition';\n  END IF;\n  RETURN NEW;\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_validate_refund_draft_transition', '', '5cf85f4087ed9e3f8e60344e1c56771d6f1c38f5e78fa23570ca28f181bdaace', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": [], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_validate_refund_draft_transition()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  IF TG_OP = 'DELETE' THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'refund allocation draft history cannot be deleted';\n  END IF;\n  IF OLD.state <> 'active' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.refund_id IS DISTINCT FROM OLD.refund_id OR\n     NEW.created_by_admin_id IS DISTINCT FROM OLD.created_by_admin_id OR\n     NEW.created_correlation_id IS DISTINCT FROM OLD.created_correlation_id OR\n     NEW.created_at IS DISTINCT FROM OLD.created_at OR\n     NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at OR\n     NEW.state NOT IN ('active', 'finalized', 'discarded') THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid refund allocation draft transition';\n  END IF;\n  RETURN NEW;\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'plan6b_validate_unknown_classification_issue', '', '9dc729a1de0f39bf47b3a0354d69ca0640e3855a80a3d2f6e7d2586380bb34f3', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": [], "result": "trigger", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.plan6b_validate_unknown_classification_issue()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  IF NOT EXISTS (\n    SELECT 1\n    FROM \"public\".\"financial_reconciliation_issues\" issue\n    WHERE issue.resource_type = 'financial_classification'\n      AND issue.resource_id = NEW.id\n      AND issue.safe_code = 'unsupported_category'\n      AND issue.impact = 'exception'\n      AND issue.state = 'open'\n  ) THEN\n    RAISE EXCEPTION USING ERRCODE = '23514',\n      MESSAGE = 'unknown classifications require a permanent reconciliation issue';\n  END IF;\n  RETURN NEW;\nEND;\n$function$\n", "volatility": "v", "security_definer": false, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'purge_commerce_claim_issuances', '', 'bb5cbd0d233b80faa493ba6793781c149c29196220eb762857de1d9a149acac6', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": ["search_path=pg_catalog"], "result": "integer", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.purge_commerce_claim_issuances()\n RETURNS integer\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog'\nAS $function$\nDECLARE\n  deleted_count integer;\n  purged_at timestamp with time zone := pg_catalog.clock_timestamp();\nBEGIN\n  WITH candidates AS (\n    SELECT issuance.claim_proof_sha256\n    FROM \"public\".\"commerce_claim_issuances\" issuance\n    WHERE (issuance.state IN ('issued', 'authorized') AND\n        issuance.expires_at <= purged_at)\n      OR (issuance.state = 'consumed' AND\n        issuance.consumed_at <= purged_at - INTERVAL '24 hours')\n    ORDER BY issuance.claim_proof_sha256\n    FOR UPDATE SKIP LOCKED\n    LIMIT 500\n  )\n  DELETE FROM \"public\".\"commerce_claim_issuances\" issuance\n  USING candidates\n  WHERE issuance.claim_proof_sha256 = candidates.claim_proof_sha256;\n  GET DIAGNOSTICS deleted_count = ROW_COUNT;\n  RETURN deleted_count;\nEND;\n$function$\n", "volatility": "v", "security_definer": true, "identity_arguments": ""}$catalog$::jsonb),
  ('function', 'public', null, 'rearm_pending_stripe_event_job', 'uuid', 'bf983cbf0dc191dedae386c5d7d50ba022d98c5633242c2e0de18942bc5b9eef', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": ["search_path=pg_catalog"], "result": "boolean", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.rearm_pending_stripe_event_job(p_stripe_event_id uuid)\n RETURNS boolean\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog'\nAS $function$\nDECLARE\n  pending_event \"public\".\"stripe_events\"%ROWTYPE;\n  exhausted_job \"public\".\"jobs\"%ROWTYPE;\n  expected_payload jsonb;\n  expected_deduplication_key text;\nBEGIN\n  IF p_stripe_event_id IS NULL THEN\n    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Stripe event job rearm';\n  END IF;\n  SELECT * INTO pending_event\n  FROM \"public\".\"stripe_events\" event\n  WHERE event.id = p_stripe_event_id\n  FOR UPDATE;\n  IF NOT FOUND OR pending_event.status <> 'pending' THEN\n    RETURN false;\n  END IF;\n  expected_payload := pg_catalog.jsonb_build_object('stripeEventId', pending_event.id);\n  expected_deduplication_key := 'stripe:event:' || pending_event.provider_event_id;\n  SELECT * INTO exhausted_job\n  FROM \"public\".\"jobs\" queued_job\n  WHERE queued_job.deduplication_key = expected_deduplication_key\n  FOR UPDATE;\n  IF NOT FOUND THEN\n    RETURN false;\n  END IF;\n  IF exhausted_job.type <> 'commerce.stripe-event' OR\n    exhausted_job.payload IS DISTINCT FROM expected_payload OR\n    exhausted_job.max_attempts <> 12 THEN\n    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Stripe event job identity mismatch';\n  END IF;\n  IF exhausted_job.status <> 'failed' OR\n    exhausted_job.attempts < exhausted_job.max_attempts THEN\n    RETURN false;\n  END IF;\n  UPDATE \"public\".\"jobs\"\n  SET status = 'pending', run_at = pg_catalog.transaction_timestamp(), attempts = 0,\n    max_attempts = 12, locked_at = NULL, locked_by = NULL, last_error = NULL,\n    rerun_requested_at = NULL, completed_at = NULL,\n    updated_at = pg_catalog.transaction_timestamp()\n  WHERE id = exhausted_job.id;\n  RETURN true;\nEND;\n$function$\n", "volatility": "v", "security_definer": true, "identity_arguments": "p_stripe_event_id uuid"}$catalog$::jsonb),
  ('function', 'public', null, 'register_commerce_claim_issuance', 'text, text, text, uuid, text, timestamp with time zone', '489ead01cfe121d1c1a057f0f5b449a659e648126cc3d98d9d6d2dc3743e94cc', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": ["search_path=pg_catalog"], "result": "boolean", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.register_commerce_claim_issuance(p_claim_proof_sha256 text, p_auth_token_sha256 text, p_normalized_email text, p_anchor_order_id uuid, p_kind text, p_expires_at timestamp with time zone)\n RETURNS boolean\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog'\nAS $function$\nDECLARE\n  anchor_candidate record;\n  locked_identity \"public\".\"guest_identities\"%ROWTYPE;\n  locked_order \"public\".\"orders\"%ROWTYPE;\n  existing_issuance \"public\".\"commerce_claim_issuances\"%ROWTYPE;\n  registered_at timestamp with time zone := pg_catalog.clock_timestamp();\nBEGIN\n  IF p_claim_proof_sha256 IS NULL OR p_claim_proof_sha256 !~ '^[a-f0-9]{64}$' OR\n    p_auth_token_sha256 IS NULL OR p_auth_token_sha256 !~ '^[a-f0-9]{64}$' OR\n    p_normalized_email IS NULL OR\n    p_normalized_email <> pg_catalog.lower(pg_catalog.btrim(p_normalized_email)) OR\n    p_anchor_order_id IS NULL OR p_kind IS NULL OR\n    p_kind NOT IN ('password-reset', 'commerce-magic') OR\n    p_expires_at IS NULL OR p_expires_at <= registered_at OR\n    p_expires_at > registered_at + INTERVAL '24 hours' THEN\n    RETURN false;\n  END IF;\n\n  SELECT purchase_order.guest_identity_id\n  INTO anchor_candidate\n  FROM \"public\".\"orders\" purchase_order\n  WHERE purchase_order.id = p_anchor_order_id;\n  IF NOT FOUND OR anchor_candidate.guest_identity_id IS NULL THEN\n    RETURN false;\n  END IF;\n\n  SELECT * INTO locked_identity\n  FROM \"public\".\"guest_identities\" identity\n  WHERE identity.id = anchor_candidate.guest_identity_id\n  FOR UPDATE;\n  IF NOT FOUND OR locked_identity.email <> p_normalized_email OR\n    locked_identity.claimed_by_user_id IS NOT NULL THEN\n    RETURN false;\n  END IF;\n\n  SELECT * INTO locked_order\n  FROM \"public\".\"orders\" purchase_order\n  WHERE purchase_order.id = p_anchor_order_id\n  FOR UPDATE;\n  IF NOT FOUND OR locked_order.guest_identity_id <> locked_identity.id OR\n    locked_order.status <> 'paid' OR locked_order.initiating_user_id IS NOT NULL OR\n    locked_order.purchase_email IS DISTINCT FROM p_normalized_email THEN\n    RETURN false;\n  END IF;\n\n  PERFORM 1\n  FROM \"public\".\"payments\" payment\n  WHERE payment.order_id = locked_order.id\n  ORDER BY payment.id\n  FOR UPDATE;\n  IF (SELECT pg_catalog.count(*) FROM \"public\".\"payments\" payment\n      WHERE payment.order_id = locked_order.id AND payment.status = 'succeeded') <> 1 THEN\n    RETURN false;\n  END IF;\n\n  PERFORM 1\n  FROM \"public\".\"order_items\" item\n  WHERE item.order_id = locked_order.id\n  ORDER BY item.id\n  FOR UPDATE;\n  IF NOT EXISTS (\n    SELECT 1 FROM \"public\".\"order_items\" item WHERE item.order_id = locked_order.id\n  ) THEN\n    RETURN false;\n  END IF;\n  PERFORM 1\n  FROM \"public\".\"entitlement_grants\" grant_row\n  JOIN \"public\".\"order_items\" item ON item.id = grant_row.order_item_id\n  WHERE item.order_id = locked_order.id\n  ORDER BY grant_row.id\n  FOR UPDATE OF grant_row;\n  IF EXISTS (\n    SELECT 1\n    FROM \"public\".\"order_items\" item\n    LEFT JOIN \"public\".\"entitlement_grants\" grant_row\n      ON grant_row.order_item_id = item.id AND grant_row.source = 'purchase'\n    WHERE item.order_id = locked_order.id\n      AND (grant_row.id IS NULL OR grant_row.user_id IS NOT NULL)\n  ) THEN\n    RETURN false;\n  END IF;\n\n  PERFORM 1\n  FROM \"public\".\"commerce_claim_issuances\" issuance\n  WHERE issuance.normalized_email = p_normalized_email\n    AND issuance.state IN ('issued', 'authorized')\n  ORDER BY issuance.claim_proof_sha256\n  FOR UPDATE;\n  SELECT * INTO existing_issuance\n  FROM \"public\".\"commerce_claim_issuances\" issuance\n  WHERE issuance.claim_proof_sha256 = p_claim_proof_sha256\n  FOR UPDATE;\n  IF FOUND THEN\n    RETURN existing_issuance.state = 'issued' AND\n      existing_issuance.auth_token_sha256 = p_auth_token_sha256 AND\n      existing_issuance.normalized_email = p_normalized_email AND\n      existing_issuance.anchor_order_id = p_anchor_order_id AND\n      existing_issuance.kind = p_kind AND\n      existing_issuance.expires_at = p_expires_at AND\n      existing_issuance.expires_at > registered_at;\n  END IF;\n\n  DELETE FROM \"public\".\"commerce_claim_issuances\"\n  WHERE normalized_email = p_normalized_email\n    AND state IN ('issued', 'authorized');\n  INSERT INTO \"public\".\"commerce_claim_issuances\" (\n    claim_proof_sha256, auth_token_sha256, normalized_email,\n    anchor_order_id, kind, state, issued_at, expires_at\n  ) VALUES (\n    p_claim_proof_sha256, p_auth_token_sha256, p_normalized_email,\n    p_anchor_order_id, p_kind, 'issued', registered_at, p_expires_at\n  );\n  RETURN true;\nEND;\n$function$\n", "volatility": "v", "security_definer": true, "identity_arguments": "p_claim_proof_sha256 text, p_auth_token_sha256 text, p_normalized_email text, p_anchor_order_id uuid, p_kind text, p_expires_at timestamp with time zone"}$catalog$::jsonb),
  ('function', 'public', null, 'resolve_financial_issue_after_worker_recompute', 'uuid, text', '7979bdac02bf96ab3cf14ab7a250f25914f95457747394fb8167aae9a75a2b71', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": ["search_path=pg_catalog"], "result": "SETOF financial_reconciliation_issues", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.resolve_financial_issue_after_worker_recompute(p_issue_id uuid, p_correlation_id text)\n RETURNS SETOF financial_reconciliation_issues\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog'\nAS $function$\nDECLARE\n  current_issue \"public\".\"financial_reconciliation_issues\"%ROWTYPE;\n  resolved_issue \"public\".\"financial_reconciliation_issues\"%ROWTYPE;\nBEGIN\n  IF p_issue_id IS NULL OR p_correlation_id IS NULL OR\n    char_length(p_correlation_id) NOT BETWEEN 1 AND 100 THEN\n    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid financial issue worker resolution';\n  END IF;\n  SELECT * INTO current_issue\n  FROM \"public\".\"financial_reconciliation_issues\" issue\n  WHERE issue.id = p_issue_id\n  FOR UPDATE;\n  IF NOT FOUND OR current_issue.state <> 'open' THEN\n    RETURN;\n  END IF;\n  IF current_issue.resource_type = 'financial_classification'\n    AND current_issue.safe_code = 'unsupported_category' THEN\n    RAISE EXCEPTION USING ERRCODE = '55000',\n      MESSAGE = 'immutable classification diagnostics cannot be resolved';\n  END IF;\n  PERFORM pg_catalog.set_config(\n    'pale_orbit.financial_worker_issue_resolution', p_issue_id::text, true\n  );\n  UPDATE \"public\".\"financial_reconciliation_issues\"\n  SET \"state\" = 'resolved', \"resolved_at\" = pg_catalog.now(), \"resolved_by_admin_id\" = NULL\n  WHERE \"id\" = p_issue_id AND \"state\" = 'open'\n  RETURNING * INTO resolved_issue;\n  IF NOT FOUND THEN\n    RETURN;\n  END IF;\n  INSERT INTO \"public\".\"audit_events\" (\n    actor_type, actor_id, action, outcome, resource_type, resource_id, correlation_id, after\n  ) VALUES (\n    'system'::\"public\".\"audit_actor_type\", 'financial-worker', 'financial.issue.resolved',\n    'succeeded', 'financial_issue', resolved_issue.id::text, p_correlation_id,\n    pg_catalog.jsonb_build_object(\n      'resourceType', resolved_issue.resource_type,\n      'resourceId', resolved_issue.resource_id,\n      'safeCode', resolved_issue.safe_code,\n      'impact', resolved_issue.impact,\n      'state', resolved_issue.state,\n      'occurrenceCount', resolved_issue.occurrence_count\n    )\n  );\n  RETURN NEXT resolved_issue;\n  RETURN;\nEND;\n$function$\n", "volatility": "v", "security_definer": true, "identity_arguments": "p_issue_id uuid, p_correlation_id text"}$catalog$::jsonb),
  ('function', 'public', null, 'storage_cleanup_referenced_keys', 'text[]', '2d7d577acf1c098a262f03a7e5e6442521b5fae6c6383b29480aa8450854a29a', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}, {"grantee": "pale_orbit_storage_cleanup", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "EXECUTE"}], "owner": "DATABASE_OWNER", "config": ["search_path=pg_catalog"], "result": "TABLE(referenced_storage_key text)", "strict": false, "language": "plpgsql", "parallel": "u", "leakproof": false, "definition": "CREATE OR REPLACE FUNCTION public.storage_cleanup_referenced_keys(p_candidate_keys text[])\n RETURNS TABLE(referenced_storage_key text)\n LANGUAGE plpgsql\n STABLE SECURITY DEFINER ROWS 500\n SET search_path TO 'pg_catalog'\nAS $function$\nDECLARE\n  candidate_count integer;\n  nonnull_count integer;\n  distinct_count integer;\nBEGIN\n  IF NOT pg_catalog.pg_has_role(\n    session_user, 'pale_orbit_storage_cleanup', 'MEMBER'\n  ) OR pg_catalog.pg_has_role(\n    session_user, 'pale_orbit_runtime', 'MEMBER'\n  ) OR pg_catalog.pg_has_role(\n    session_user, 'pale_orbit_financial_worker', 'MEMBER'\n  ) THEN\n    RAISE EXCEPTION USING ERRCODE = '42501',\n      MESSAGE = 'storage cleanup reference authority is reserved';\n  END IF;\n  IF p_candidate_keys IS NULL THEN\n    RAISE EXCEPTION USING ERRCODE = '22023',\n      MESSAGE = 'storage cleanup candidate array is required';\n  END IF;\n  candidate_count := pg_catalog.cardinality(p_candidate_keys);\n  IF candidate_count > 500 THEN\n    RAISE EXCEPTION USING ERRCODE = '22023',\n      MESSAGE = 'storage cleanup candidate batch is too large';\n  END IF;\n  IF candidate_count = 0 THEN\n    RETURN;\n  END IF;\n  IF pg_catalog.array_ndims(p_candidate_keys) <> 1 THEN\n    RAISE EXCEPTION USING ERRCODE = '22023',\n      MESSAGE = 'storage cleanup candidate array must be one-dimensional';\n  END IF;\n\n  SELECT\n    pg_catalog.count(candidate_key),\n    pg_catalog.count(DISTINCT candidate_key)\n  INTO nonnull_count, distinct_count\n  FROM pg_catalog.unnest(p_candidate_keys) candidate(candidate_key);\n  IF nonnull_count <> candidate_count THEN\n    RAISE EXCEPTION USING ERRCODE = '22023',\n      MESSAGE = 'storage cleanup candidates may not contain nulls';\n  END IF;\n  IF distinct_count <> candidate_count THEN\n    RAISE EXCEPTION USING ERRCODE = '22023',\n      MESSAGE = 'storage cleanup candidates may not contain duplicates';\n  END IF;\n\n  IF EXISTS (\n    SELECT 1\n    FROM pg_catalog.unnest(p_candidate_keys) candidate(candidate_key)\n    WHERE candidate.candidate_key ~ '[[:cntrl:]]'\n      OR pg_catalog.char_length(candidate.candidate_key) > 500\n      OR NOT (\n        candidate.candidate_key ~\n          '^staging/uploads/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'\n        OR candidate.candidate_key ~\n          '^health/probes/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'\n        OR candidate.candidate_key ~\n          '^titles/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/covers/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]webp$'\n        OR candidate.candidate_key ~\n          '^titles/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/revisions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/derived/v1/(prose-images|comic-pages|cover-suggestions)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]webp$'\n        OR candidate.candidate_key ~\n          '^titles/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/revisions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/derived/v1/generations/(0|[1-9][0-9]{0,9})/(prose-images|comic-pages|cover-suggestions)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]webp$'\n      )\n  ) OR EXISTS (\n    SELECT 1\n    FROM pg_catalog.unnest(p_candidate_keys) candidate(candidate_key)\n    WHERE candidate.candidate_key LIKE '%/derived/v1/generations/%'\n      AND (\n        (pg_catalog.regexp_match(\n          candidate.candidate_key,\n          '/generations/([0-9]+)/'\n        ))[1]::numeric > 2147483647\n      )\n  ) THEN\n    RAISE EXCEPTION USING ERRCODE = '22023',\n      MESSAGE = 'storage cleanup candidate key is not canonical';\n  END IF;\n\n  RETURN QUERY\n  WITH parsed_candidates AS (\n    SELECT\n      candidate.candidate_key,\n      CASE\n        WHEN candidate.candidate_key LIKE 'health/probes/%' THEN 'health-probe'\n        WHEN candidate.candidate_key LIKE 'staging/uploads/%' THEN 'staging'\n        WHEN candidate.candidate_key LIKE 'titles/%/covers/%' THEN 'title-cover'\n        ELSE 'derived'\n      END AS candidate_class,\n      CASE\n        WHEN candidate.candidate_key LIKE 'titles/%/revisions/%/derived/%'\n          THEN pg_catalog.split_part(candidate.candidate_key, '/', 2)::uuid\n        ELSE NULL\n      END AS title_id,\n      CASE\n        WHEN candidate.candidate_key LIKE 'titles/%/revisions/%/derived/%'\n          THEN pg_catalog.split_part(candidate.candidate_key, '/', 4)::uuid\n        ELSE NULL\n      END AS revision_id,\n      CASE\n        WHEN candidate.candidate_key LIKE '%/derived/v1/generations/%'\n          THEN pg_catalog.split_part(candidate.candidate_key, '/', 8)::integer\n        ELSE NULL\n      END AS generation\n    FROM pg_catalog.unnest(p_candidate_keys) candidate(candidate_key)\n  )\n  SELECT parsed.candidate_key\n  FROM parsed_candidates parsed\n  WHERE parsed.candidate_class <> 'health-probe'\n    AND (\n      EXISTS (\n      SELECT 1\n      FROM \"public\".\"titles\" referenced_title\n      WHERE referenced_title.cover_storage_key = parsed.candidate_key\n    )\n    OR EXISTS (\n      SELECT 1\n      FROM \"public\".\"title_revisions\" referenced_revision\n      WHERE referenced_revision.original_storage_key = parsed.candidate_key\n    )\n    OR EXISTS (\n      SELECT 1\n      FROM \"public\".\"prose_images\" referenced_prose_image\n      WHERE referenced_prose_image.storage_key = parsed.candidate_key\n    )\n    OR EXISTS (\n      SELECT 1\n      FROM \"public\".\"comic_pages\" referenced_comic_page\n      WHERE referenced_comic_page.storage_key = parsed.candidate_key\n    )\n    OR EXISTS (\n      SELECT 1\n      FROM \"public\".\"revision_cover_suggestions\" referenced_suggestion\n      WHERE referenced_suggestion.storage_key = parsed.candidate_key\n    )\n    OR (\n      parsed.candidate_class = 'staging'\n      AND EXISTS (\n        SELECT 1\n        FROM \"public\".\"title_revisions\" referenced_revision\n        WHERE referenced_revision.staging_storage_key = parsed.candidate_key\n          AND (\n            referenced_revision.state IN ('uploaded', 'processing')\n            OR EXISTS (\n              SELECT 1\n              FROM \"public\".\"jobs\" active_job\n              WHERE active_job.type = 'catalog.ingest_revision'\n                AND active_job.status IN ('pending', 'running')\n                AND active_job.payload ->> 'revisionId' = referenced_revision.id::text\n                AND active_job.payload ->> 'generation' =\n                  referenced_revision.ingestion_generation::text\n            )\n          )\n      )\n    )\n    OR (\n      parsed.candidate_class = 'derived'\n      AND parsed.generation IS NULL\n      AND EXISTS (\n        SELECT 1\n        FROM \"public\".\"title_revisions\" referenced_revision\n        WHERE referenced_revision.id = parsed.revision_id\n          AND referenced_revision.title_id = parsed.title_id\n          AND (\n            referenced_revision.state IN ('uploaded', 'processing')\n            OR EXISTS (\n              SELECT 1\n              FROM \"public\".\"jobs\" active_job\n              WHERE active_job.type = 'catalog.ingest_revision'\n                AND active_job.status IN ('pending', 'running')\n                AND active_job.payload ->> 'revisionId' = referenced_revision.id::text\n            )\n          )\n      )\n    )\n    OR (\n      parsed.candidate_class = 'derived'\n      AND parsed.generation IS NOT NULL\n      AND EXISTS (\n        SELECT 1\n        FROM \"public\".\"title_revisions\" referenced_revision\n        WHERE referenced_revision.id = parsed.revision_id\n          AND referenced_revision.title_id = parsed.title_id\n          AND (\n            (\n              referenced_revision.state IN ('uploaded', 'processing')\n              AND referenced_revision.ingestion_generation = parsed.generation\n            )\n            OR EXISTS (\n              SELECT 1\n              FROM \"public\".\"jobs\" active_job\n              WHERE active_job.type = 'catalog.ingest_revision'\n                AND active_job.status IN ('pending', 'running')\n                AND active_job.payload ->> 'revisionId' = referenced_revision.id::text\n                AND active_job.payload ->> 'generation' = parsed.generation::text\n            )\n          )\n      )\n    )\n    )\n  ORDER BY parsed.candidate_key;\nEND;\n$function$\n", "volatility": "s", "security_definer": true, "identity_arguments": "p_candidate_keys text[]"}$catalog$::jsonb),
  ('index', 'public', 'commerce_claim_issuances', 'commerce_claim_issuances_auth_token_sha256_unique', null, 'fac70abf1527b09874708e05f9f61ec68095cc57b871d2cc2affb621f5a8f9bc', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX commerce_claim_issuances_auth_token_sha256_unique ON public.commerce_claim_issuances USING btree (auth_token_sha256) WHERE (auth_token_sha256 IS NOT NULL)"}$catalog$::jsonb),
  ('index', 'public', 'commerce_claim_issuances', 'commerce_claim_issuances_live_email_idx', null, '33d2dbe5c7aa7f840b915156d1fe4bc02a76d8909c50e5fca84c252a88e3753b', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX commerce_claim_issuances_live_email_idx ON public.commerce_claim_issuances USING btree (normalized_email, state, claim_proof_sha256) WHERE ((normalized_email IS NOT NULL) AND (state = ANY (ARRAY['issued'::text, 'authorized'::text])))"}$catalog$::jsonb),
  ('index', 'public', 'commerce_claim_issuances', 'commerce_claim_issuances_retention_idx', null, 'dee3732864a5a6b9dd77c673ae3c192cc4e1f32d8c6a2b95f133d754802ad39a', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX commerce_claim_issuances_retention_idx ON public.commerce_claim_issuances USING btree (state, expires_at, consumed_at)"}$catalog$::jsonb),
  ('index', 'public', 'dispute_item_allocations', 'dispute_item_allocations_dispute_item_idx', null, '19b719fea59390686d1471c20be036fb03beecaf71c995e4af7500380b380083', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX dispute_item_allocations_dispute_item_idx ON public.dispute_item_allocations USING btree (dispute_id, order_item_id, created_at)"}$catalog$::jsonb),
  ('index', 'public', 'dispute_item_allocations', 'dispute_item_allocations_gross_set_item_unique', null, '20e78455efde3226dadf0980f8f6dfa8707c107ef70cf0825c4bf36ef06a92e9', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX dispute_item_allocations_gross_set_item_unique ON public.dispute_item_allocations USING btree (gross_allocation_set_id, order_item_id)"}$catalog$::jsonb),
  ('index', 'public', 'dispute_item_allocations', 'dispute_item_allocations_identity_unique', null, '5fa9a9581984b780b3debb8eb530aae0c9753466c0c61a9125ea529ecb94d5dc', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX dispute_item_allocations_identity_unique ON public.dispute_item_allocations USING btree (allocation_identity)"}$catalog$::jsonb),
  ('index', 'public', 'entitlement_grants', 'entitlement_grants_administrative_recovery_unique', null, 'b65c10d22f927ed9bff1c05f29bbd98ae120db850ac41ed620508d12342bd5c9', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX entitlement_grants_administrative_recovery_unique ON public.entitlement_grants USING btree (recovery_refund_allocation_id) WHERE (source = 'administrative'::entitlement_grant_source)"}$catalog$::jsonb),
  ('index', 'public', 'entitlement_grants', 'entitlement_grants_preserved_user_title_unique', null, 'ae8537f0e338b43c8b6d8bbee06e9741ec8888abe0261869b86c8f88eeb06b5f', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX entitlement_grants_preserved_user_title_unique ON public.entitlement_grants USING btree (user_id, title_id) WHERE (source = 'preserved'::entitlement_grant_source)"}$catalog$::jsonb),
  ('index', 'public', 'entitlement_grants', 'entitlement_grants_purchase_item_unique', null, '4f68e15fa01f117e1768c6e0724f9bf72253777799f6ce041f39a376ed6fc844', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX entitlement_grants_purchase_item_unique ON public.entitlement_grants USING btree (order_item_id) WHERE (source = 'purchase'::entitlement_grant_source)"}$catalog$::jsonb),
  ('index', 'public', 'financial_allocation_sets', 'financial_allocation_sets_identity_unique', null, 'ae6a756b720b40cfdd853928ce5d9bd06209f33caf2190cfdf744ffa50920f70', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX financial_allocation_sets_identity_unique ON public.financial_allocation_sets USING btree (allocation_identity)"}$catalog$::jsonb),
  ('index', 'public', 'financial_allocation_sets', 'financial_allocation_sets_reversal_idx', null, 'b3aa1950b9d2b42b30830531d23cdb90182fa036166edf125fc20ed19fb370c9', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX financial_allocation_sets_reversal_idx ON public.financial_allocation_sets USING btree (reversal_of_set_id)"}$catalog$::jsonb),
  ('index', 'public', 'financial_allocation_sets', 'financial_allocation_sets_reversal_root_unique', null, 'ccb28b1640966a42250f04574be3989da604aae36f3a79331ae5c66ca4c850c6', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX financial_allocation_sets_reversal_root_unique ON public.financial_allocation_sets USING btree (reversal_of_set_id) WHERE ((reversal_of_set_id IS NOT NULL) AND (supersedes_set_id IS NULL))"}$catalog$::jsonb),
  ('index', 'public', 'financial_allocation_sets', 'financial_allocation_sets_root_unique', null, 'd921b50f6f7d6236da6a47f5e3607130664137f87bc8d4a37effc3e0420fc0f5', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX financial_allocation_sets_root_unique ON public.financial_allocation_sets USING btree (balance_transaction_id, basis, source_fingerprint_sha256) WHERE (supersedes_set_id IS NULL)"}$catalog$::jsonb),
  ('index', 'public', 'financial_allocation_sets', 'financial_allocation_sets_source_idx', null, 'b391fad4af08c3651797d25c98ba3849fb51b68fde253966c748e17c04ad6be8', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX financial_allocation_sets_source_idx ON public.financial_allocation_sets USING btree (source_kind, source_internal_id, id)"}$catalog$::jsonb),
  ('index', 'public', 'financial_allocation_sets', 'financial_allocation_sets_successor_unique', null, 'f43dc05ccfba26fb581a42f1bb65607b40d7e397838ac8b20bb06dd00f3d003f', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX financial_allocation_sets_successor_unique ON public.financial_allocation_sets USING btree (supersedes_set_id) WHERE (supersedes_set_id IS NOT NULL)"}$catalog$::jsonb),
  ('index', 'public', 'financial_allocation_sets', 'financial_allocation_sets_transaction_basis_idx', null, 'ed176d4140b919269c3abfc5c7b3ea4a5e32314bd91eb6a5e03d45ac616c3d79', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX financial_allocation_sets_transaction_basis_idx ON public.financial_allocation_sets USING btree (balance_transaction_id, basis, created_at, id)"}$catalog$::jsonb),
  ('index', 'public', 'financial_classification_versions', 'financial_classification_versions_current_idx', null, 'e8afba5ff66098a997413056603d5ecf627873f9ffb43208ea8bf758fa419bc5', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX financial_classification_versions_current_idx ON public.financial_classification_versions USING btree (subject_type, subject_id, source_fingerprint_sha256, classifier_version)"}$catalog$::jsonb),
  ('index', 'public', 'financial_classification_versions', 'financial_classification_versions_identity_unique', null, '6580c595e19878715dbc2632ef014b1efc45b3aa54a58e14df3da32328837de8', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX financial_classification_versions_identity_unique ON public.financial_classification_versions USING btree (subject_type, subject_id, classifier_version, source_fingerprint_sha256)"}$catalog$::jsonb),
  ('index', 'public', 'financial_item_allocations', 'financial_item_allocations_item_idx', null, 'aceb71d5be6eef668c33e58c7bdbc79d85c34b2f0bce2d93ffac0400fa5aab39', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX financial_item_allocations_item_idx ON public.financial_item_allocations USING btree (order_item_id, created_at)"}$catalog$::jsonb),
  ('index', 'public', 'financial_item_allocations', 'financial_item_allocations_set_item_component_unique', null, 'df017342994fbb832c0c6120992af53e9a611565d8facc3916e05ace3085ea22', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX financial_item_allocations_set_item_component_unique ON public.financial_item_allocations USING btree (allocation_set_id, order_item_id, component)"}$catalog$::jsonb),
  ('index', 'public', 'financial_item_allocations', 'financial_item_allocations_set_tie_key_unique', null, 'a9c4ab400bb487cfbe29353302105fc349fba404f009bdd3988e4d55acf5284f', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX financial_item_allocations_set_tie_key_unique ON public.financial_item_allocations USING btree (allocation_set_id, tie_break_key)"}$catalog$::jsonb),
  ('index', 'public', 'financial_reconciliation_issues', 'financial_reconciliation_issues_open_unique', null, 'cf9c0ee6c0709164bb09ad33dcc749b51afff588e43348096caeeeef5e0ad9d4', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX financial_reconciliation_issues_open_unique ON public.financial_reconciliation_issues USING btree (resource_type, resource_id, safe_code) WHERE (state = 'open'::financial_issue_state)"}$catalog$::jsonb),
  ('index', 'public', 'financial_reconciliation_issues', 'financial_reconciliation_issues_state_observed_idx', null, 'a3a9d4cbe967cf8503948de02a48441215b12b894875f92020f2d7883c2f9ba4', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX financial_reconciliation_issues_state_observed_idx ON public.financial_reconciliation_issues USING btree (state, last_observed_at, id)"}$catalog$::jsonb),
  ('index', 'public', 'financial_scan_runs', 'financial_scan_runs_kind_completed_idx', null, '33a30e5a4b5d8d9da2cad342ac5891db524b9d3596b243adef523d9737184ce9', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX financial_scan_runs_kind_completed_idx ON public.financial_scan_runs USING btree (kind, completed_at, id)"}$catalog$::jsonb),
  ('index', 'public', 'financial_scan_runs', 'financial_scan_runs_root_key_unique', null, 'bafd8f6c1302f64ea29c5bd381fdf423c906596ae8bd2e01f63d81dab436f5f4', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX financial_scan_runs_root_key_unique ON public.financial_scan_runs USING btree (root_key)"}$catalog$::jsonb),
  ('index', 'public', 'financial_scan_runs', 'financial_scan_runs_state_phase_updated_idx', null, '2a08e8829e8e18bced285cdb3ba49976a94b20677db7bf2439c597c6d2a3dc6e', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX financial_scan_runs_state_phase_updated_idx ON public.financial_scan_runs USING btree (state, phase, updated_at, id)"}$catalog$::jsonb),
  ('index', 'public', 'jobs', 'jobs_active_ingest_revision_identity_idx', null, 'a3f907d99bf954054b70774713fae372c650e97363bf2cddc91510db211472b2', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX jobs_active_ingest_revision_identity_idx ON public.jobs USING btree (((payload ->> 'revisionId'::text)), ((payload ->> 'generation'::text))) WHERE ((type = 'catalog.ingest_revision'::text) AND (status = ANY (ARRAY['pending'::job_status, 'running'::job_status])))"}$catalog$::jsonb),
  ('index', 'public', 'payout_import_run_entries', 'payout_import_run_entries_candidate_unique', null, 'a15d60810c5c5cbdd442294eb15bbc7d72613d7a4b9198cae13b25256b72b94f', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX payout_import_run_entries_candidate_unique ON public.payout_import_run_entries USING btree (run_id, balance_transaction_id)"}$catalog$::jsonb),
  ('index', 'public', 'payout_import_run_entries', 'payout_import_run_entries_transaction_idx', null, '75bd6a8568437b95f525b2d6447b58ce413f4435ae4244860d3408f3926599fd', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX payout_import_run_entries_transaction_idx ON public.payout_import_run_entries USING btree (balance_transaction_id, id)"}$catalog$::jsonb),
  ('index', 'public', 'payout_import_runs', 'payout_import_runs_active_payout_unique', null, 'dab6ff95de05a8d64ddb302ae48f73fa4552885b592c8cf6d4a043284ed2509a', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX payout_import_runs_active_payout_unique ON public.payout_import_runs USING btree (payout_id) WHERE (state = ANY (ARRAY['collecting'::payout_import_state, 'publishable'::payout_import_state]))"}$catalog$::jsonb),
  ('index', 'public', 'payout_import_runs', 'payout_import_runs_generation_unique', null, 'c478c64bca9ccd75208bb45d796c3538bbef2fb5a1b66e73c59aacf0b4a53ca5', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX payout_import_runs_generation_unique ON public.payout_import_runs USING btree (payout_id, generation)"}$catalog$::jsonb),
  ('index', 'public', 'payout_import_runs', 'payout_import_runs_recovery_idx', null, '25835ef383af9e0373d42ed471fa200e6042aa4dcf9428562278fe7eb966c73a', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX payout_import_runs_recovery_idx ON public.payout_import_runs USING btree (state, updated_at, id)"}$catalog$::jsonb),
  ('index', 'public', 'refund_allocation_components', 'refund_allocation_components_allocation_unique', null, 'd5c7f7c6ecd36c31733b0012632bea21f5e2d76204e9620c4ccabc409d90e1c5', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX refund_allocation_components_allocation_unique ON public.refund_allocation_components USING btree (refund_allocation_id)"}$catalog$::jsonb),
  ('index', 'public', 'refund_allocation_components', 'refund_allocation_components_refund_item_idx', null, '76deea1e1bcbff5db3a26f2eb9b615c89f0e60ccf9d2557f1000693efa82997c', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX refund_allocation_components_refund_item_idx ON public.refund_allocation_components USING btree (refund_id, order_item_id)"}$catalog$::jsonb),
  ('index', 'public', 'refund_allocation_drafts', 'refund_allocation_drafts_active_unique', null, 'dc621cc3a4bddbbee8857cdedd40bb302575aea8272fdf238e123382906e00c7', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX refund_allocation_drafts_active_unique ON public.refund_allocation_drafts USING btree (refund_id) WHERE (state = 'active'::refund_allocation_draft_state)"}$catalog$::jsonb),
  ('index', 'public', 'refund_allocation_finalization_effects', 'refund_allocation_finalization_effects_causal_unique', null, '22e43e0becf2cbd12001d90469453a8c1d69675f1d4410fcb78e844c6e5f3fd8', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX refund_allocation_finalization_effects_causal_unique ON public.refund_allocation_finalization_effects USING btree (refund_allocation_id, purchase_grant_id)"}$catalog$::jsonb),
  ('index', 'public', 'refund_allocation_finalization_effects', 'refund_allocation_finalization_effects_refund_item_idx', null, 'f2ba22f972a19860c2e9d65cfb49fc2f67589b4fd71cb0f3363d62e791547631', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX refund_allocation_finalization_effects_refund_item_idx ON public.refund_allocation_finalization_effects USING btree (refund_id, order_item_id, id)"}$catalog$::jsonb),
  ('index', 'public', 'refund_reporting_correction_items', 'refund_reporting_correction_items_set_item_component_unique', null, 'c6fdea161f273564ad63d01354e8f41ef187411f038846a81deb0e96225fbb5c', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX refund_reporting_correction_items_set_item_component_unique ON public.refund_reporting_correction_items USING btree (correction_set_id, domain, COALESCE(source_allocation_set_id, '00000000-0000-0000-0000-000000000000'::uuid), currency, order_item_id, component)"}$catalog$::jsonb),
  ('index', 'public', 'refund_reporting_correction_items', 'refund_reporting_correction_items_set_tie_key_unique', null, '293f2cbd2a43d4293ef637f1f791df15a103e3a7f35c11f72b7174972f5528b3', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX refund_reporting_correction_items_set_tie_key_unique ON public.refund_reporting_correction_items USING btree (correction_set_id, stable_tie_break_key)"}$catalog$::jsonb),
  ('index', 'public', 'refund_reporting_correction_sets', 'refund_reporting_correction_sets_base_idx', null, 'be429e6be0a3fd2f6290bbbdb2d2e2dc929a2b4809675768f93e42efaff2d070', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX refund_reporting_correction_sets_base_idx ON public.refund_reporting_correction_sets USING btree (base_allocation_set_id, id)"}$catalog$::jsonb),
  ('index', 'public', 'refund_reporting_correction_sets', 'refund_reporting_correction_sets_identity_unique', null, 'a873cd416d87980e3c1c75e16c03485c6e6b377a503a7312e47f2a7a5c1504a1', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX refund_reporting_correction_sets_identity_unique ON public.refund_reporting_correction_sets USING btree (refund_id, correction_version)"}$catalog$::jsonb),
  ('index', 'public', 'refund_reporting_correction_sets', 'refund_reporting_correction_sets_root_unique', null, '1234165f37906ee92c0413e58759e46692483189617258ff55e4fbc59fa9fdd0', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX refund_reporting_correction_sets_root_unique ON public.refund_reporting_correction_sets USING btree (refund_id) WHERE (predecessor_correction_set_id IS NULL)"}$catalog$::jsonb),
  ('index', 'public', 'refund_reporting_correction_sets', 'refund_reporting_correction_sets_successor_unique', null, 'bfdc095df137e56986f147574a2c01ce13eccbf481564ea4ce08c88273c0fb89', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX refund_reporting_correction_sets_successor_unique ON public.refund_reporting_correction_sets USING btree (predecessor_correction_set_id) WHERE (predecessor_correction_set_id IS NOT NULL)"}$catalog$::jsonb),
  ('index', 'public', 'stripe_balance_transaction_fee_details', 'stripe_balance_transaction_fee_details_parent_ordinal_unique', null, '745a55333a59316ce5e79d104b1e47ac07e6f11368aed5e688d2a6edc61c85ad', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX stripe_balance_transaction_fee_details_parent_ordinal_unique ON public.stripe_balance_transaction_fee_details USING btree (balance_transaction_id, ordinal)"}$catalog$::jsonb),
  ('index', 'public', 'stripe_balance_transactions', 'stripe_balance_transactions_currency_created_idx', null, 'a05467d3f568b7c4f776c1d99513501e4999b45909a83da9884d42e66d204c69', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX stripe_balance_transactions_currency_created_idx ON public.stripe_balance_transactions USING btree (currency, provider_created_at, id)"}$catalog$::jsonb),
  ('index', 'public', 'stripe_balance_transactions', 'stripe_balance_transactions_provider_unique', null, '0ad2ed380beaf9c8664120b4dab1a66a3b908a53f2e73e9fb3fbb5c41aa166e8', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX stripe_balance_transactions_provider_unique ON public.stripe_balance_transactions USING btree (provider_id)"}$catalog$::jsonb),
  ('index', 'public', 'stripe_balance_transactions', 'stripe_balance_transactions_source_idx', null, '87e344c224242508eb694df4d2227f9470e98fa3b9c4d91617e158cb5902749f', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX stripe_balance_transactions_source_idx ON public.stripe_balance_transactions USING btree (source_family, source_id)"}$catalog$::jsonb),
  ('index', 'public', 'stripe_balance_transactions', 'stripe_balance_transactions_status_available_idx', null, '79e5a5588123afdbfe6b606023af2c54129557c34af2fc2626018648cdb66e59', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX stripe_balance_transactions_status_available_idx ON public.stripe_balance_transactions USING btree (status, available_at, id)"}$catalog$::jsonb),
  ('index', 'public', 'stripe_payout_balance_transactions', 'stripe_payout_balance_transactions_pair_unique', null, 'e09373524ad6839f2f0431d25efdeedd8da96bfa2f04969d0bd846ac3643794e', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX stripe_payout_balance_transactions_pair_unique ON public.stripe_payout_balance_transactions USING btree (payout_id, balance_transaction_id)"}$catalog$::jsonb),
  ('index', 'public', 'stripe_payout_balance_transactions', 'stripe_payout_balance_transactions_payout_idx', null, '8c11f04d861f073f026de1bc4595b5290d0d61baf99407b8f7b9ccebaf39319a', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX stripe_payout_balance_transactions_payout_idx ON public.stripe_payout_balance_transactions USING btree (payout_id, id)"}$catalog$::jsonb),
  ('index', 'public', 'stripe_payout_balance_transactions', 'stripe_payout_balance_transactions_transaction_unique', null, '46e431c314dd71785d1e4f69129cba960ae0832ac6370c270b3cea17f11b95bb', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX stripe_payout_balance_transactions_transaction_unique ON public.stripe_payout_balance_transactions USING btree (balance_transaction_id)"}$catalog$::jsonb),
  ('index', 'public', 'stripe_payouts', 'stripe_payouts_balance_transaction_idx', null, '02764d1188e9206aafdaf5073d49504c0fc77e29d75860767e5be81f85bb5c65', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX stripe_payouts_balance_transaction_idx ON public.stripe_payouts USING btree (balance_transaction_id)"}$catalog$::jsonb),
  ('index', 'public', 'stripe_payouts', 'stripe_payouts_failure_balance_transaction_idx', null, 'c049369dd12b9d8baa52793f436d715e524f49ee25f1b3af4fca179cc225bc3a', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX stripe_payouts_failure_balance_transaction_idx ON public.stripe_payouts USING btree (failure_balance_transaction_id)"}$catalog$::jsonb),
  ('index', 'public', 'stripe_payouts', 'stripe_payouts_provider_unique', null, '616e0f5db86cc4a24b148dd155e5adaa7171159be1dd528cfd9e107299f28d06', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX stripe_payouts_provider_unique ON public.stripe_payouts USING btree (provider_id)"}$catalog$::jsonb),
  ('index', 'public', 'stripe_payouts', 'stripe_payouts_reconciliation_created_idx', null, 'c2fea1cf8f0904ecf24403f8f725a7aefd1807f6636e70cb3866475a0ef40091', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX stripe_payouts_reconciliation_created_idx ON public.stripe_payouts USING btree (reconciliation_status, provider_created_at, id)"}$catalog$::jsonb),
  ('index', 'public', 'stripe_payouts', 'stripe_payouts_status_created_idx', null, 'f2e10e9e5e3141398cd0b6059dcec80f9fa4c08d7a6f4778236b5dfa0295fcd2', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX stripe_payouts_status_created_idx ON public.stripe_payouts USING btree (status, provider_created_at, id)"}$catalog$::jsonb),
  ('index', 'public', 'title_revisions', 'title_revisions_original_storage_key_idx', null, '0b6582ec37fa7990a0c794bb4db66a53d4072adf2e18499ff9442ca2867fc00d', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX title_revisions_original_storage_key_idx ON public.title_revisions USING btree (original_storage_key) WHERE (original_storage_key IS NOT NULL)"}$catalog$::jsonb),
  ('index', 'public', 'title_revisions', 'title_revisions_staging_storage_key_idx', null, 'a9393d7e0997a73872cd800ea7260d014f3dcad9225ab5bc278da09573707331', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX title_revisions_staging_storage_key_idx ON public.title_revisions USING btree (staging_storage_key) WHERE (staging_storage_key IS NOT NULL)"}$catalog$::jsonb),
  ('index', 'public', 'titles', 'titles_cover_storage_key_idx', null, '0c83c9b61470be2d3e8e5bf4b9d4eb6037b842ac4b445dfcc29983f5c67cbb04', $catalog${"owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX titles_cover_storage_key_idx ON public.titles USING btree (cover_storage_key) WHERE (cover_storage_key IS NOT NULL)"}$catalog$::jsonb),
  ('sensitive_relation_state', 'public', null, 'entitlement_grants', null, '7f73de8f94a8000b63bd15688d01fee00a7916ec4854345272bd26fd922b0b53', $catalog${"relkind": "r", "persistence": "p", "row_security": false, "force_row_security": false}$catalog$::jsonb),
  ('sensitive_relation_state', 'public', null, 'entitlements', null, '7f73de8f94a8000b63bd15688d01fee00a7916ec4854345272bd26fd922b0b53', $catalog${"relkind": "r", "persistence": "p", "row_security": false, "force_row_security": false}$catalog$::jsonb),
  ('sensitive_relation_state', 'public', null, 'guest_identities', null, '7f73de8f94a8000b63bd15688d01fee00a7916ec4854345272bd26fd922b0b53', $catalog${"relkind": "r", "persistence": "p", "row_security": false, "force_row_security": false}$catalog$::jsonb),
  ('sensitive_relation_state', 'public', null, 'outbox_messages', null, '7f73de8f94a8000b63bd15688d01fee00a7916ec4854345272bd26fd922b0b53', $catalog${"relkind": "r", "persistence": "p", "row_security": false, "force_row_security": false}$catalog$::jsonb),
  ('table', 'public', null, 'commerce_claim_issuances', null, '611e7601c092caa8b710756533e5e8ea83bfc4fdc500167ab909581095c53c3b', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [], "name": "claim_proof_sha256", "type": "text", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "auth_token_sha256", "type": "text", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "normalized_email", "type": "text", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "anchor_order_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "kind", "type": "text", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "state", "type": "text", "default": "'issued'::text", "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "authorized_user_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "issued_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "expires_at", "type": "timestamp with time zone", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "authorized_at", "type": "timestamp with time zone", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "consumed_at", "type": "timestamp with time zone", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "result_disposition", "type": "text", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "result_changed", "type": "boolean", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "result_order_count", "type": "integer", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "result_title_count", "type": "integer", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}], "relkind": "r", "triggers": [], "reloptions": [], "constraints": [{"name": "commerce_claim_issuances_anchor_order_id_orders_id_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (anchor_order_id) REFERENCES orders(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "commerce_claim_issuances_auth_token_sha256_valid", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((auth_token_sha256 IS NULL) OR (auth_token_sha256 ~ '^[a-f0-9]{64}$'::text)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "commerce_claim_issuances_authorized_user_id_user_id_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (authorized_user_id) REFERENCES \"user\"(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "commerce_claim_issuances_claim_proof_sha256_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL claim_proof_sha256", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "commerce_claim_issuances_claim_proof_sha256_valid", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((claim_proof_sha256 ~ '^[a-f0-9]{64}$'::text))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "commerce_claim_issuances_email_normalized", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((normalized_email IS NULL) OR (normalized_email = lower(btrim(normalized_email)))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "commerce_claim_issuances_expires_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL expires_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "commerce_claim_issuances_issued_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL issued_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "commerce_claim_issuances_kind_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL kind", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "commerce_claim_issuances_kind_valid", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((kind = ANY (ARRAY['password-reset'::text, 'commerce-magic'::text])))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "commerce_claim_issuances_lifecycle_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((state = 'issued'::text) AND (auth_token_sha256 IS NOT NULL) AND (normalized_email IS NOT NULL) AND (anchor_order_id IS NOT NULL) AND (authorized_user_id IS NULL) AND (authorized_at IS NULL) AND (consumed_at IS NULL) AND (result_disposition IS NULL) AND (result_changed IS NULL) AND (result_order_count IS NULL) AND (result_title_count IS NULL)) OR ((state = 'authorized'::text) AND (auth_token_sha256 IS NOT NULL) AND (normalized_email IS NOT NULL) AND (anchor_order_id IS NOT NULL) AND (authorized_user_id IS NOT NULL) AND (authorized_at IS NOT NULL) AND (consumed_at IS NULL) AND (result_disposition IS NULL) AND (result_changed IS NULL) AND (result_order_count IS NULL) AND (result_title_count IS NULL)) OR ((state = 'consumed'::text) AND (auth_token_sha256 IS NULL) AND (normalized_email IS NULL) AND (anchor_order_id IS NULL) AND (authorized_user_id IS NULL) AND (authorized_at IS NOT NULL) AND (consumed_at IS NOT NULL) AND (result_disposition IS NOT NULL) AND (result_changed IS NOT NULL) AND (result_order_count IS NOT NULL) AND (result_title_count IS NOT NULL))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "commerce_claim_issuances_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (claim_proof_sha256)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "commerce_claim_issuances_result_valid", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((result_disposition IS NULL) AND (result_changed IS NULL) AND (result_order_count IS NULL) AND (result_title_count IS NULL)) OR ((result_disposition = ANY (ARRAY['claimed'::text, 'not_eligible'::text, 'definitive_invalid'::text, 'identity_conflict'::text])) AND (result_changed IS NOT NULL) AND (result_order_count IS NOT NULL) AND (result_order_count >= 0) AND (result_title_count IS NOT NULL) AND (result_title_count >= 0) AND (((result_disposition = 'claimed'::text) AND (result_order_count > 0) AND (result_title_count > 0)) OR ((result_disposition <> 'claimed'::text) AND (NOT result_changed) AND (result_order_count = 0) AND (result_title_count = 0))))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "commerce_claim_issuances_state_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL state", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "commerce_claim_issuances_timestamp_order", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((expires_at > issued_at) AND ((authorized_at IS NULL) OR (authorized_at >= issued_at)) AND ((consumed_at IS NULL) OR (consumed_at >= authorized_at))))", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "commerce_claim_issuances_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (claim_proof_sha256)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [{"name": "commerce_claim_issuances_auth_token_sha256_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX commerce_claim_issuances_auth_token_sha256_unique ON public.commerce_claim_issuances USING btree (auth_token_sha256) WHERE (auth_token_sha256 IS NOT NULL)"}, {"name": "commerce_claim_issuances_live_email_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX commerce_claim_issuances_live_email_idx ON public.commerce_claim_issuances USING btree (normalized_email, state, claim_proof_sha256) WHERE ((normalized_email IS NOT NULL) AND (state = ANY (ARRAY['issued'::text, 'authorized'::text])))"}, {"name": "commerce_claim_issuances_retention_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX commerce_claim_issuances_retention_idx ON public.commerce_claim_issuances USING btree (state, expires_at, consumed_at)"}], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": []}$catalog$::jsonb),
  ('table', 'public', null, 'dispute_item_allocations', null, '077b9f2d8cdcc32c5ecbf4190cefea9680906a64c75e8a24cf161b1aa9ea7db8', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [{"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}], "name": "id", "type": "uuid", "default": "gen_random_uuid()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "allocation_identity", "type": "character varying(255)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "dispute_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "gross_allocation_set_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "order_item_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "effect", "type": "dispute_allocation_effect", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "reverses_allocation_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "subtotal_effect_minor", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "tax_effect_minor", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "total_effect_minor", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "currency", "type": "character varying(3)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "created_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}], "relkind": "r", "triggers": [{"name": "dispute_item_allocations_immutable", "enabled": "O", "definition": "CREATE TRIGGER dispute_item_allocations_immutable BEFORE DELETE OR UPDATE ON public.dispute_item_allocations FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}, {"name": "dispute_item_allocations_validate_gross_set", "enabled": "O", "definition": "CREATE TRIGGER dispute_item_allocations_validate_gross_set BEFORE INSERT ON public.dispute_item_allocations FOR EACH ROW EXECUTE FUNCTION plan6b_validate_dispute_gross_allocation_set()"}], "reloptions": [], "constraints": [{"name": "dispute_item_allocations_allocation_identity_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL allocation_identity", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "dispute_item_allocations_created_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL created_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "dispute_item_allocations_currency_iso", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((currency)::text ~ '^[A-Z]{3}$'::text))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "dispute_item_allocations_currency_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL currency", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "dispute_item_allocations_dispute_id_disputes_id_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (dispute_id) REFERENCES disputes(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "dispute_item_allocations_dispute_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL dispute_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "dispute_item_allocations_effect_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL effect", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "dispute_item_allocations_gross_allocation_set_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL gross_allocation_set_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "dispute_item_allocations_gross_set_graph_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (gross_allocation_set_id, dispute_id) REFERENCES financial_allocation_sets(id, source_internal_id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "dispute_item_allocations_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "dispute_item_allocations_money_bounded", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((subtotal_effect_minor >= '-99999999'::integer) AND (subtotal_effect_minor <= 99999999)) AND ((tax_effect_minor >= '-99999999'::integer) AND (tax_effect_minor <= 99999999)) AND ((total_effect_minor >= '-99999999'::integer) AND (total_effect_minor <= 99999999))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "dispute_item_allocations_order_item_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL order_item_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "dispute_item_allocations_order_item_id_order_items_id_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "dispute_item_allocations_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "dispute_item_allocations_reversal_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((effect = 'reinstatement'::dispute_allocation_effect) = (reverses_allocation_id IS NOT NULL)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "dispute_item_allocations_reverses_allocation_id_dispute_item_al", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (reverses_allocation_id) REFERENCES dispute_item_allocations(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "dispute_item_allocations_subtotal_effect_minor_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL subtotal_effect_minor", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "dispute_item_allocations_tax_effect_minor_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL tax_effect_minor", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "dispute_item_allocations_total_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((total_effect_minor = (subtotal_effect_minor + tax_effect_minor)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "dispute_item_allocations_total_effect_minor_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL total_effect_minor", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "dispute_item_allocations_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [{"name": "dispute_item_allocations_dispute_item_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX dispute_item_allocations_dispute_item_idx ON public.dispute_item_allocations USING btree (dispute_id, order_item_id, created_at)"}, {"name": "dispute_item_allocations_gross_set_item_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX dispute_item_allocations_gross_set_item_unique ON public.dispute_item_allocations USING btree (gross_allocation_set_id, order_item_id)"}, {"name": "dispute_item_allocations_identity_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX dispute_item_allocations_identity_unique ON public.dispute_item_allocations USING btree (allocation_identity)"}], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": [{"name": "dispute_item_allocations_reverses_allocation_id_dispute_item_al", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (reverses_allocation_id) REFERENCES dispute_item_allocations(id) ON DELETE RESTRICT", "source_table": "dispute_item_allocations", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}]}$catalog$::jsonb),
  ('table', 'public', null, 'financial_allocation_sets', null, '1ce82b03227c37e1f76defb3c501acd3dbaa226ea010fd2bdaebd5c32cb66dc8', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [{"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}], "name": "id", "type": "uuid", "default": "gen_random_uuid()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "allocation_identity", "type": "character varying(255)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "balance_transaction_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "source_kind", "type": "financial_allocation_source_kind", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "source_internal_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "basis", "type": "financial_allocation_basis", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "scope", "type": "financial_allocation_scope", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "expected_effect_minor", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "currency", "type": "character varying(3)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "algorithm_version", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "classifier_version", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "source_fingerprint_sha256", "type": "character varying(64)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "supersedes_set_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "reversal_of_set_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "created_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}], "relkind": "r", "triggers": [{"name": "financial_allocation_sets_immutable", "enabled": "O", "definition": "CREATE TRIGGER financial_allocation_sets_immutable BEFORE DELETE OR UPDATE ON public.financial_allocation_sets FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}, {"name": "financial_allocation_sets_supersession_lineage_check", "enabled": "O", "definition": "CREATE CONSTRAINT TRIGGER financial_allocation_sets_supersession_lineage_check AFTER INSERT OR UPDATE ON public.financial_allocation_sets NOT DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION enforce_financial_allocation_supersession_lineage()"}], "reloptions": [], "constraints": [{"name": "financial_allocation_sets_algorithm_version_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL algorithm_version", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_allocation_identity_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL allocation_identity", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_balance_transaction_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL balance_transaction_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_balance_transaction_id_stripe_balance", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (balance_transaction_id) REFERENCES stripe_balance_transactions(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "financial_allocation_sets_basis_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL basis", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_chain_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((supersedes_set_id IS NULL) OR (supersedes_set_id <> id)) AND ((reversal_of_set_id IS NULL) OR (reversal_of_set_id <> id)) AND ((supersedes_set_id IS NULL) OR (reversal_of_set_id IS NULL) OR (supersedes_set_id <> reversal_of_set_id))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_classifier_version_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL classifier_version", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_created_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL created_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_currency_iso", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((currency)::text ~ '^[A-Z]{3}$'::text))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_currency_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL currency", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_effect_bounded", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((expected_effect_minor >= '-99999999'::integer) AND (expected_effect_minor <= 99999999)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_expected_effect_minor_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL expected_effect_minor", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_fingerprint_sha256", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((source_fingerprint_sha256)::text ~ '^[a-f0-9]{64}$'::text))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_identity_safe", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((char_length((allocation_identity)::text) > 0))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_reversal_graph_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (reversal_of_set_id, source_kind, source_internal_id, basis, currency) REFERENCES financial_allocation_sets(id, source_kind, source_internal_id, basis, currency) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "financial_allocation_sets_reversal_identity_unique", "type": "u", "enforced": true, "validated": true, "deferrable": false, "definition": "UNIQUE (id, source_kind, source_internal_id, basis, currency)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_reversal_of_set_id_financial_allocati", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (reversal_of_set_id) REFERENCES financial_allocation_sets(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "financial_allocation_sets_scope_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL scope", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_source_fingerprint_sha256_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL source_fingerprint_sha256", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_source_identity_unique", "type": "u", "enforced": true, "validated": true, "deferrable": false, "definition": "UNIQUE (id, source_internal_id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_source_internal_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL source_internal_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_source_kind_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL source_kind", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_supersedes_graph_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (supersedes_set_id, balance_transaction_id, basis, currency, expected_effect_minor, source_fingerprint_sha256) REFERENCES financial_allocation_sets(id, balance_transaction_id, basis, currency, expected_effect_minor, source_fingerprint_sha256) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "financial_allocation_sets_supersedes_set_id_financial_allocatio", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (supersedes_set_id) REFERENCES financial_allocation_sets(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "financial_allocation_sets_supersession_identity_unique", "type": "u", "enforced": true, "validated": true, "deferrable": false, "definition": "UNIQUE (id, balance_transaction_id, basis, currency, expected_effect_minor, source_fingerprint_sha256)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_supersession_lineage_check", "type": "t", "enforced": true, "validated": true, "deferrable": false, "definition": "TRIGGER", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_allocation_sets_versions_positive", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((algorithm_version > 0) AND (classifier_version > 0)))", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "financial_allocation_sets_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [{"name": "financial_allocation_sets_identity_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX financial_allocation_sets_identity_unique ON public.financial_allocation_sets USING btree (allocation_identity)"}, {"name": "financial_allocation_sets_reversal_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX financial_allocation_sets_reversal_idx ON public.financial_allocation_sets USING btree (reversal_of_set_id)"}, {"name": "financial_allocation_sets_reversal_root_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX financial_allocation_sets_reversal_root_unique ON public.financial_allocation_sets USING btree (reversal_of_set_id) WHERE ((reversal_of_set_id IS NOT NULL) AND (supersedes_set_id IS NULL))"}, {"name": "financial_allocation_sets_root_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX financial_allocation_sets_root_unique ON public.financial_allocation_sets USING btree (balance_transaction_id, basis, source_fingerprint_sha256) WHERE (supersedes_set_id IS NULL)"}, {"name": "financial_allocation_sets_source_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX financial_allocation_sets_source_idx ON public.financial_allocation_sets USING btree (source_kind, source_internal_id, id)"}, {"name": "financial_allocation_sets_successor_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX financial_allocation_sets_successor_unique ON public.financial_allocation_sets USING btree (supersedes_set_id) WHERE (supersedes_set_id IS NOT NULL)"}, {"name": "financial_allocation_sets_transaction_basis_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX financial_allocation_sets_transaction_basis_idx ON public.financial_allocation_sets USING btree (balance_transaction_id, basis, created_at, id)"}], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": [{"name": "dispute_item_allocations_gross_set_graph_fk", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (gross_allocation_set_id, dispute_id) REFERENCES financial_allocation_sets(id, source_internal_id) ON DELETE RESTRICT", "source_table": "dispute_item_allocations", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "financial_allocation_sets_reversal_graph_fk", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (reversal_of_set_id, source_kind, source_internal_id, basis, currency) REFERENCES financial_allocation_sets(id, source_kind, source_internal_id, basis, currency) ON DELETE RESTRICT", "source_table": "financial_allocation_sets", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "financial_allocation_sets_reversal_of_set_id_financial_allocati", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (reversal_of_set_id) REFERENCES financial_allocation_sets(id) ON DELETE RESTRICT", "source_table": "financial_allocation_sets", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "financial_allocation_sets_supersedes_graph_fk", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (supersedes_set_id, balance_transaction_id, basis, currency, expected_effect_minor, source_fingerprint_sha256) REFERENCES financial_allocation_sets(id, balance_transaction_id, basis, currency, expected_effect_minor, source_fingerprint_sha256) ON DELETE RESTRICT", "source_table": "financial_allocation_sets", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "financial_allocation_sets_supersedes_set_id_financial_allocatio", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (supersedes_set_id) REFERENCES financial_allocation_sets(id) ON DELETE RESTRICT", "source_table": "financial_allocation_sets", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "financial_item_allocations_allocation_set_id_financial_allocati", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (allocation_set_id) REFERENCES financial_allocation_sets(id) ON DELETE RESTRICT", "source_table": "financial_item_allocations", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_reporting_correction_items_source_allocation_set_id_fina", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (source_allocation_set_id) REFERENCES financial_allocation_sets(id) ON DELETE RESTRICT", "source_table": "refund_reporting_correction_items", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_reporting_correction_sets_base_allocation_set_id_financi", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (base_allocation_set_id) REFERENCES financial_allocation_sets(id) ON DELETE RESTRICT", "source_table": "refund_reporting_correction_sets", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}]}$catalog$::jsonb),
  ('table', 'public', null, 'financial_classification_versions', null, 'e057a7ee28c28e6285c1eb94a40c58e6141c7fc05a97d2e77f7ddc4d60f31795', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [{"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}], "name": "id", "type": "uuid", "default": "gen_random_uuid()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "subject_type", "type": "financial_classification_subject_type", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "subject_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "classifier_version", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "classification", "type": "financial_classification", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "source_fingerprint_sha256", "type": "character varying(64)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "decided_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}], "relkind": "r", "triggers": [{"name": "financial_classification_versions_immutable", "enabled": "O", "definition": "CREATE TRIGGER financial_classification_versions_immutable BEFORE DELETE OR UPDATE ON public.financial_classification_versions FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}, {"name": "financial_classification_versions_unknown_issue_required", "enabled": "O", "definition": "CREATE CONSTRAINT TRIGGER financial_classification_versions_unknown_issue_required AFTER INSERT ON public.financial_classification_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.classification = 'unknown'::financial_classification)) EXECUTE FUNCTION plan6b_validate_unknown_classification_issue()"}], "reloptions": [], "constraints": [{"name": "financial_classification_ver_source_fingerprint_sha256_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL source_fingerprint_sha256", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_classification_versions_classification_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL classification", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_classification_versions_classifier_version_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL classifier_version", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_classification_versions_decided_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL decided_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_classification_versions_fingerprint_sha256", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((source_fingerprint_sha256)::text ~ '^[a-f0-9]{64}$'::text))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_classification_versions_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_classification_versions_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_classification_versions_subject_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL subject_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_classification_versions_subject_type_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL subject_type", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_classification_versions_unknown_issue_required", "type": "t", "enforced": true, "validated": true, "deferrable": true, "definition": "TRIGGER DEFERRABLE INITIALLY DEFERRED", "initially_deferred": true, "internal_trigger_modes": []}, {"name": "financial_classification_versions_version_positive", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((classifier_version > 0))", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "financial_classification_versions_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [{"name": "financial_classification_versions_current_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX financial_classification_versions_current_idx ON public.financial_classification_versions USING btree (subject_type, subject_id, source_fingerprint_sha256, classifier_version)"}, {"name": "financial_classification_versions_identity_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX financial_classification_versions_identity_unique ON public.financial_classification_versions USING btree (subject_type, subject_id, classifier_version, source_fingerprint_sha256)"}], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": []}$catalog$::jsonb),
  ('table', 'public', null, 'financial_item_allocations', null, '4b9845d359c034c60550e946bad1d4857cd48c8a0d9de7847481965b561fc6cf', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [{"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}], "name": "id", "type": "uuid", "default": "gen_random_uuid()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "allocation_set_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "order_item_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "component", "type": "financial_component", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "effect_minor", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "currency", "type": "character varying(3)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "tie_break_key", "type": "character varying(255)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "created_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}], "relkind": "r", "triggers": [{"name": "financial_item_allocations_immutable", "enabled": "O", "definition": "CREATE TRIGGER financial_item_allocations_immutable BEFORE DELETE OR UPDATE ON public.financial_item_allocations FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}], "reloptions": [], "constraints": [{"name": "financial_item_allocations_allocation_set_id_financial_allocati", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (allocation_set_id) REFERENCES financial_allocation_sets(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "financial_item_allocations_allocation_set_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL allocation_set_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_item_allocations_component_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL component", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_item_allocations_created_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL created_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_item_allocations_currency_iso", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((currency)::text ~ '^[A-Z]{3}$'::text))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_item_allocations_currency_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL currency", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_item_allocations_effect_bounded", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((effect_minor >= '-99999999'::integer) AND (effect_minor <= 99999999)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_item_allocations_effect_minor_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL effect_minor", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_item_allocations_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_item_allocations_order_item_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL order_item_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_item_allocations_order_item_id_order_items_id_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "financial_item_allocations_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_item_allocations_tie_break_key_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL tie_break_key", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_item_allocations_tie_key_safe", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((char_length((tie_break_key)::text) >= 1) AND (char_length((tie_break_key)::text) <= 255)))", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "financial_item_allocations_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [{"name": "financial_item_allocations_item_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX financial_item_allocations_item_idx ON public.financial_item_allocations USING btree (order_item_id, created_at)"}, {"name": "financial_item_allocations_set_item_component_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX financial_item_allocations_set_item_component_unique ON public.financial_item_allocations USING btree (allocation_set_id, order_item_id, component)"}, {"name": "financial_item_allocations_set_tie_key_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX financial_item_allocations_set_tie_key_unique ON public.financial_item_allocations USING btree (allocation_set_id, tie_break_key)"}], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": []}$catalog$::jsonb),
  ('table', 'public', null, 'financial_payout_discovery_state', null, 'c67637559afc6e800f1ff78095d8a11f069eaf60339ce65f23c12274a1aff36c', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [], "name": "singleton", "type": "boolean", "default": "true", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "covered_through", "type": "timestamp with time zone", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "updated_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}], "relkind": "r", "triggers": [], "reloptions": [], "constraints": [{"name": "financial_payout_discovery_state_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (singleton)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_payout_discovery_state_singleton_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL singleton", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_payout_discovery_state_singleton_true", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((singleton = true))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_payout_discovery_state_updated_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL updated_at", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "financial_payout_discovery_state_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (singleton)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": []}$catalog$::jsonb),
  ('table', 'public', null, 'financial_projection_versions', null, '1336092878428eb0582185f910a2e474c73f1b3f6b428aa84db9a4baeaaa303e', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [], "name": "singleton", "type": "boolean", "default": "true", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "classifier_version", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "allocation_algorithm_version", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "pending_classifier_version", "type": "integer", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "pending_allocation_algorithm_version", "type": "integer", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "pending_replay_id", "type": "character varying(50)", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "pending_scan_run_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "activated_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "activation_correlation_id", "type": "character varying(100)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}], "relkind": "r", "triggers": [{"name": "financial_projection_versions_narrow_update", "enabled": "O", "definition": "CREATE TRIGGER financial_projection_versions_narrow_update BEFORE DELETE OR UPDATE ON public.financial_projection_versions FOR EACH ROW EXECUTE FUNCTION plan6b_validate_projection_version_transition()"}], "reloptions": [], "constraints": [{"name": "financial_projection_versio_allocation_algorithm_versi_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL allocation_algorithm_version", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_projection_version_activation_correlation_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL activation_correlation_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_projection_versions_activated_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL activated_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_projection_versions_classifier_version_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL classifier_version", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_projection_versions_correlation_safe", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((char_length((activation_correlation_id)::text) >= 1) AND (char_length((activation_correlation_id)::text) <= 100)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_projection_versions_pending_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((pending_classifier_version IS NULL) AND (pending_allocation_algorithm_version IS NULL) AND (pending_replay_id IS NULL) AND (pending_scan_run_id IS NULL)) OR ((pending_classifier_version IS NOT NULL) AND (pending_allocation_algorithm_version IS NOT NULL) AND (pending_replay_id IS NOT NULL) AND (pending_scan_run_id IS NOT NULL) AND (pending_classifier_version >= classifier_version) AND (pending_allocation_algorithm_version >= allocation_algorithm_version) AND ((pending_classifier_version > classifier_version) OR (pending_allocation_algorithm_version > allocation_algorithm_version)) AND ((pending_replay_id)::text = ((('c'::text || (pending_classifier_version)::text) || '-a'::text) || (pending_allocation_algorithm_version)::text)))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_projection_versions_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (singleton)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_projection_versions_singleton_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL singleton", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_projection_versions_singleton_true", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((singleton = true))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_projection_versions_versions_positive", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((classifier_version > 0) AND (allocation_algorithm_version > 0)))", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "financial_projection_versions_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (singleton)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": []}$catalog$::jsonb),
  ('table', 'public', null, 'financial_reconciliation_issues', null, 'f3ef9e2fe5122835afd3e0fa2b32555abb00b5be575ea3af5d364f87fe3293f5', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [], "name": "id", "type": "uuid", "default": "gen_random_uuid()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "resource_type", "type": "character varying(50)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "resource_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "safe_code", "type": "character varying(100)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "state", "type": "financial_issue_state", "default": "'open'::financial_issue_state", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "impact", "type": "financial_issue_impact", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "first_observed_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "last_observed_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "occurrence_count", "type": "integer", "default": "1", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "correlation_id", "type": "character varying(100)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "resolved_by_admin_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "resolved_at", "type": "timestamp with time zone", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}], "relkind": "r", "triggers": [{"name": "financial_reconciliation_issues_narrow_update", "enabled": "O", "definition": "CREATE TRIGGER financial_reconciliation_issues_narrow_update BEFORE DELETE OR UPDATE ON public.financial_reconciliation_issues FOR EACH ROW EXECUTE FUNCTION plan6b_validate_issue_transition()"}, {"name": "financial_reconciliation_issues_validate_insert", "enabled": "O", "definition": "CREATE TRIGGER financial_reconciliation_issues_validate_insert BEFORE INSERT ON public.financial_reconciliation_issues FOR EACH ROW EXECUTE FUNCTION plan6b_validate_issue_insert()"}], "reloptions": [], "constraints": [{"name": "financial_reconciliation_issues_correlation_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL correlation_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_reconciliation_issues_first_observed_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL first_observed_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_reconciliation_issues_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_reconciliation_issues_immutable_classification_open", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((resource_type)::text <> 'financial_classification'::text) OR ((safe_code)::text <> 'unsupported_category'::text) OR (state = 'open'::financial_issue_state)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_reconciliation_issues_impact_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL impact", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_reconciliation_issues_last_observed_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL last_observed_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_reconciliation_issues_observation_order", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((last_observed_at >= first_observed_at))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_reconciliation_issues_occurrence_count_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL occurrence_count", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_reconciliation_issues_occurrence_positive", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((occurrence_count > 0))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_reconciliation_issues_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_reconciliation_issues_resolution_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((state = 'resolved'::financial_issue_state) = (resolved_at IS NOT NULL)) AND ((resolved_by_admin_id IS NULL) OR (state = 'resolved'::financial_issue_state))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_reconciliation_issues_resolved_by_admin_id_user_id_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (resolved_by_admin_id) REFERENCES \"user\"(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "financial_reconciliation_issues_resource_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL resource_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_reconciliation_issues_resource_type_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL resource_type", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_reconciliation_issues_safe_code_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL safe_code", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_reconciliation_issues_safe_vocabulary", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((resource_type)::text ~ '^[a-z0-9_]{1,50}$'::text) AND ((safe_code)::text ~ '^[a-z0-9_]{1,100}$'::text) AND ((char_length((correlation_id)::text) >= 1) AND (char_length((correlation_id)::text) <= 100))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_reconciliation_issues_semantic_identity", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((((resource_type)::text = ANY ((ARRAY['payment'::character varying, 'refund'::character varying, 'dispute'::character varying, 'allocation_set'::character varying])::text[])) AND ((safe_code)::text = ANY ((ARRAY['allocation_fork'::character varying, 'allocation_incomplete'::character varying, 'allocation_mismatch'::character varying, 'classification_fork'::character varying, 'correction_rebase_required'::character varying, 'currency_mismatch'::character varying, 'immutable_mismatch'::character varying, 'missing_source'::character varying, 'source_linkage_mismatch'::character varying, 'unsupported_category'::character varying])::text[]))) OR (((resource_type)::text = 'payout'::text) AND ((safe_code)::text = ANY ((ARRAY['currency_mismatch'::character varying, 'generation_exhausted'::character varying, 'immutable_mismatch'::character varying, 'payout_membership_conflict'::character varying, 'payout_reversal_incomplete'::character varying])::text[]))) OR (((resource_type)::text = 'balance_transaction'::text) AND ((safe_code)::text = ANY ((ARRAY['classification_fork'::character varying, 'immutable_mismatch'::character varying])::text[]))) OR (((resource_type)::text = 'financial_classification'::text) AND ((safe_code)::text = 'unsupported_category'::text))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_reconciliation_issues_semantic_impact", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((((safe_code)::text = ANY ((ARRAY['allocation_incomplete'::character varying, 'missing_source'::character varying])::text[])) AND (impact = 'pending'::financial_issue_impact)) OR (((safe_code)::text <> ALL ((ARRAY['allocation_incomplete'::character varying, 'missing_source'::character varying])::text[])) AND (impact = 'exception'::financial_issue_impact))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_reconciliation_issues_state_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL state", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "financial_reconciliation_issues_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [{"name": "financial_reconciliation_issues_open_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX financial_reconciliation_issues_open_unique ON public.financial_reconciliation_issues USING btree (resource_type, resource_id, safe_code) WHERE (state = 'open'::financial_issue_state)"}, {"name": "financial_reconciliation_issues_state_observed_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX financial_reconciliation_issues_state_observed_idx ON public.financial_reconciliation_issues USING btree (state, last_observed_at, id)"}], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": []}$catalog$::jsonb),
  ('table', 'public', null, 'financial_scan_runs', null, '1b22e7474be3bf9690e3a7f932990829e38839ebb951116701562aa1fe7aa141', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [], "name": "id", "type": "uuid", "default": "gen_random_uuid()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "root_key", "type": "character varying(512)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "kind", "type": "character varying(50)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "phase", "type": "character varying(50)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "state", "type": "financial_scan_state", "default": "'running'::financial_scan_state", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "classifier_version", "type": "integer", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "allocation_algorithm_version", "type": "integer", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "replay_id", "type": "character varying(50)", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "payout_discovery_created_gte", "type": "timestamp with time zone", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "payout_discovery_created_lt", "type": "timestamp with time zone", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "checkpoint", "type": "character varying(255)", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "cursor_digest_sha256", "type": "character varying(64)", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "processed_count", "type": "integer", "default": "0", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "enqueued_count", "type": "integer", "default": "0", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "page_count", "type": "integer", "default": "0", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "safe_outcome", "type": "character varying(100)", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "started_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "updated_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "completed_at", "type": "timestamp with time zone", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}], "relkind": "r", "triggers": [], "reloptions": [], "constraints": [{"name": "financial_scan_runs_checkpoint_bounded", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((checkpoint IS NULL) OR ((char_length((checkpoint)::text) >= 1) AND (char_length((checkpoint)::text) <= 255))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_scan_runs_counts_nonnegative", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((processed_count >= 0) AND (enqueued_count >= 0) AND (page_count >= 0)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_scan_runs_cursor_digest_sha256", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((cursor_digest_sha256 IS NULL) OR ((cursor_digest_sha256)::text ~ '^[a-f0-9]{64}$'::text)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_scan_runs_enqueued_count_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL enqueued_count", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_scan_runs_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_scan_runs_kind_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL kind", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_scan_runs_lifecycle_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((state = ANY (ARRAY['completed'::financial_scan_state, 'exception'::financial_scan_state])) = (completed_at IS NOT NULL)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_scan_runs_page_count_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL page_count", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_scan_runs_payout_discovery_window_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((payout_discovery_created_gte IS NULL) AND (payout_discovery_created_lt IS NULL)) OR ((payout_discovery_created_gte IS NOT NULL) AND (payout_discovery_created_lt IS NOT NULL) AND (payout_discovery_created_gte < payout_discovery_created_lt) AND ((kind)::text = ANY ((ARRAY['initial_backfill'::character varying, 'hourly'::character varying])::text[])))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_scan_runs_phase_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL phase", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_scan_runs_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_scan_runs_processed_count_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL processed_count", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_scan_runs_replay_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((classifier_version IS NULL) AND (allocation_algorithm_version IS NULL) AND (replay_id IS NULL)) OR ((classifier_version IS NOT NULL) AND (allocation_algorithm_version IS NOT NULL) AND (replay_id IS NOT NULL) AND (classifier_version > 0) AND (allocation_algorithm_version > 0) AND ((replay_id)::text = ((('c'::text || (classifier_version)::text) || '-a'::text) || (allocation_algorithm_version)::text)))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_scan_runs_root_key_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL root_key", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_scan_runs_started_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL started_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_scan_runs_state_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL state", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_scan_runs_updated_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL updated_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "financial_scan_runs_vocabulary_safe", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((kind)::text ~ '^[a-z0-9_-]{1,50}$'::text) AND ((phase)::text ~ '^[a-z0-9_-]{1,50}$'::text) AND ((safe_outcome IS NULL) OR ((safe_outcome)::text ~ '^[a-z0-9_]{1,100}$'::text))))", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "financial_scan_runs_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [{"name": "financial_scan_runs_kind_completed_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX financial_scan_runs_kind_completed_idx ON public.financial_scan_runs USING btree (kind, completed_at, id)"}, {"name": "financial_scan_runs_root_key_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX financial_scan_runs_root_key_unique ON public.financial_scan_runs USING btree (root_key)"}, {"name": "financial_scan_runs_state_phase_updated_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX financial_scan_runs_state_phase_updated_idx ON public.financial_scan_runs USING btree (state, phase, updated_at, id)"}], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": []}$catalog$::jsonb),
  ('table', 'public', null, 'payout_import_run_entries', null, '5a6f8cc526aa75c93ba7f2963a8eeab3ebe66170be29669a443c1c51e3bbe47f', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [{"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}], "name": "id", "type": "uuid", "default": "gen_random_uuid()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "run_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "balance_transaction_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "created_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}], "relkind": "r", "triggers": [{"name": "payout_import_run_entries_immutable", "enabled": "O", "definition": "CREATE TRIGGER payout_import_run_entries_immutable BEFORE DELETE OR UPDATE ON public.payout_import_run_entries FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}], "reloptions": [], "constraints": [{"name": "payout_import_run_entries_balance_transaction_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL balance_transaction_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_run_entries_balance_transaction_id_stripe_balance", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (balance_transaction_id) REFERENCES stripe_balance_transactions(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "payout_import_run_entries_created_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL created_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_run_entries_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_run_entries_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_run_entries_run_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL run_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_run_entries_run_id_payout_import_runs_id_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (run_id) REFERENCES payout_import_runs(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}], "persistence": "p", "primary_key": {"name": "payout_import_run_entries_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [{"name": "payout_import_run_entries_candidate_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX payout_import_run_entries_candidate_unique ON public.payout_import_run_entries USING btree (run_id, balance_transaction_id)"}, {"name": "payout_import_run_entries_transaction_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX payout_import_run_entries_transaction_idx ON public.payout_import_run_entries USING btree (balance_transaction_id, id)"}], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": []}$catalog$::jsonb),
  ('table', 'public', null, 'payout_import_runs', null, '2d7c08717b6fb39961d782877b20b5968077df1077313aaeea00ab10bf9cc0bc', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [], "name": "id", "type": "uuid", "default": "gen_random_uuid()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "payout_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "generation", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "state", "type": "payout_import_state", "default": "'collecting'::payout_import_state", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "next_starting_after", "type": "character varying(255)", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "candidate_count", "type": "integer", "default": "0", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "page_count", "type": "integer", "default": "0", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "safe_outcome", "type": "character varying(100)", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "started_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "updated_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "completed_at", "type": "timestamp with time zone", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}], "relkind": "r", "triggers": [], "reloptions": [], "constraints": [{"name": "payout_import_runs_candidate_count_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL candidate_count", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_runs_counts_nonnegative", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((candidate_count >= 0) AND (page_count >= 0)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_runs_cursor_bounded", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((next_starting_after IS NULL) OR ((char_length((next_starting_after)::text) >= 1) AND (char_length((next_starting_after)::text) <= 255))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_runs_generation_bounded", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((generation >= 0) AND (generation <= 2147483647)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_runs_generation_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL generation", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_runs_graph_identity_unique", "type": "u", "enforced": true, "validated": true, "deferrable": false, "definition": "UNIQUE (id, payout_id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_runs_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_runs_lifecycle_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((state = ANY (ARRAY['published'::payout_import_state, 'abandoned'::payout_import_state, 'exception'::payout_import_state])) = (completed_at IS NOT NULL)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_runs_outcome_safe", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((safe_outcome IS NULL) OR ((safe_outcome)::text ~ '^[a-z0-9_]{1,100}$'::text)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_runs_page_count_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL page_count", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_runs_payout_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL payout_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_runs_payout_id_stripe_payouts_id_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (payout_id) REFERENCES stripe_payouts(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "payout_import_runs_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_runs_started_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL started_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_runs_state_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL state", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "payout_import_runs_updated_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL updated_at", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "payout_import_runs_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [{"name": "payout_import_runs_active_payout_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX payout_import_runs_active_payout_unique ON public.payout_import_runs USING btree (payout_id) WHERE (state = ANY (ARRAY['collecting'::payout_import_state, 'publishable'::payout_import_state]))"}, {"name": "payout_import_runs_generation_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX payout_import_runs_generation_unique ON public.payout_import_runs USING btree (payout_id, generation)"}, {"name": "payout_import_runs_recovery_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX payout_import_runs_recovery_idx ON public.payout_import_runs USING btree (state, updated_at, id)"}], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": [{"name": "payout_import_run_entries_run_id_payout_import_runs_id_fk", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (run_id) REFERENCES payout_import_runs(id) ON DELETE RESTRICT", "source_table": "payout_import_run_entries", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "stripe_payout_balance_transactions_run_payout_fk", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (published_from_run_id, payout_id) REFERENCES payout_import_runs(id, payout_id) ON DELETE RESTRICT", "source_table": "stripe_payout_balance_transactions", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}]}$catalog$::jsonb),
  ('table', 'public', null, 'refund_allocation_components', null, '5289e3a2a7ae2bac7852df2abb9c4ab4416eec7617454313422d31b0e937d442', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [{"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}], "name": "id", "type": "uuid", "default": "gen_random_uuid()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "refund_allocation_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "refund_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "order_item_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "subtotal_minor", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "tax_minor", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "total_minor", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "currency", "type": "character varying(3)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "created_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}], "relkind": "r", "triggers": [{"name": "refund_allocation_components_immutable", "enabled": "O", "definition": "CREATE TRIGGER refund_allocation_components_immutable BEFORE DELETE OR UPDATE ON public.refund_allocation_components FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}], "reloptions": [], "constraints": [{"name": "refund_allocation_components_created_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL created_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_components_currency_iso", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((currency)::text ~ '^[A-Z]{3}$'::text))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_components_currency_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL currency", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_components_graph_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (refund_allocation_id, refund_id, order_item_id) REFERENCES refund_allocations(id, refund_id, order_item_id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_allocation_components_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_components_money_nonnegative", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((subtotal_minor >= 0) AND (subtotal_minor <= 99999999)) AND ((tax_minor >= 0) AND (tax_minor <= 99999999)) AND ((total_minor >= 0) AND (total_minor <= 99999999))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_components_order_item_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL order_item_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_components_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_components_refund_allocation_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL refund_allocation_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_components_refund_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL refund_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_components_subtotal_minor_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL subtotal_minor", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_components_tax_minor_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL tax_minor", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_components_total_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((total_minor = (subtotal_minor + tax_minor)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_components_total_minor_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL total_minor", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "refund_allocation_components_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [{"name": "refund_allocation_components_allocation_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX refund_allocation_components_allocation_unique ON public.refund_allocation_components USING btree (refund_allocation_id)"}, {"name": "refund_allocation_components_refund_item_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX refund_allocation_components_refund_item_idx ON public.refund_allocation_components USING btree (refund_id, order_item_id)"}], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": []}$catalog$::jsonb),
  ('table', 'public', null, 'refund_allocation_draft_items', null, '7bf251748654a51942ffa7d72c164e586d8f47a5a8030027a4376a78c119003d', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [{"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}], "name": "id", "type": "uuid", "default": "gen_random_uuid()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "draft_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "order_item_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "proposed_total_presentment_minor", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "created_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "updated_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}], "relkind": "r", "triggers": [{"name": "refund_allocation_draft_items_narrow_update", "enabled": "O", "definition": "CREATE TRIGGER refund_allocation_draft_items_narrow_update BEFORE DELETE OR UPDATE ON public.refund_allocation_draft_items FOR EACH ROW EXECUTE FUNCTION plan6b_validate_refund_draft_item_transition()"}, {"name": "refund_allocation_draft_items_validate_insert", "enabled": "O", "definition": "CREATE TRIGGER refund_allocation_draft_items_validate_insert BEFORE INSERT ON public.refund_allocation_draft_items FOR EACH ROW EXECUTE FUNCTION plan6b_validate_refund_draft_item_insert()"}], "reloptions": [], "constraints": [{"name": "refund_allocation_draft_ite_proposed_total_presentment_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL proposed_total_presentment_minor", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_draft_items_amount_bounded", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((proposed_total_presentment_minor >= 0) AND (proposed_total_presentment_minor <= 99999999)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_draft_items_created_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL created_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_draft_items_draft_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL draft_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_draft_items_draft_id_refund_allocation_drafts", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (draft_id) REFERENCES refund_allocation_drafts(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_allocation_draft_items_draft_item_unique", "type": "u", "enforced": true, "validated": true, "deferrable": false, "definition": "UNIQUE (draft_id, order_item_id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_draft_items_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_draft_items_order_item_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL order_item_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_draft_items_order_item_id_order_items_id_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_allocation_draft_items_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_draft_items_updated_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL updated_at", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "refund_allocation_draft_items_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": [{"name": "refund_allocation_finalization_effects_draft_item_fk", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (draft_id, order_item_id) REFERENCES refund_allocation_draft_items(draft_id, order_item_id) ON DELETE RESTRICT", "source_table": "refund_allocation_finalization_effects", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}]}$catalog$::jsonb),
  ('table', 'public', null, 'refund_allocation_drafts', null, '28c847eeb35c48be2bf4c43bd07a433360b8dfd5072df8cfafb9cf00d13765b4', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [{"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}], "name": "id", "type": "uuid", "default": "gen_random_uuid()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "refund_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "state", "type": "refund_allocation_draft_state", "default": "'active'::refund_allocation_draft_state", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "version", "type": "integer", "default": "1", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "created_by_admin_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "updated_by_admin_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "created_correlation_id", "type": "character varying(100)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "updated_correlation_id", "type": "character varying(100)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "created_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "updated_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "finalized_at", "type": "timestamp with time zone", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "discarded_at", "type": "timestamp with time zone", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}], "relkind": "r", "triggers": [{"name": "refund_allocation_drafts_narrow_update", "enabled": "O", "definition": "CREATE TRIGGER refund_allocation_drafts_narrow_update BEFORE DELETE OR UPDATE ON public.refund_allocation_drafts FOR EACH ROW EXECUTE FUNCTION plan6b_validate_refund_draft_transition()"}], "reloptions": [], "constraints": [{"name": "refund_allocation_drafts_correlation_safe", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((char_length((created_correlation_id)::text) >= 1) AND (char_length((created_correlation_id)::text) <= 100)) AND ((char_length((updated_correlation_id)::text) >= 1) AND (char_length((updated_correlation_id)::text) <= 100))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_drafts_created_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL created_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_drafts_created_by_admin_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL created_by_admin_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_drafts_created_by_admin_id_user_id_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (created_by_admin_id) REFERENCES \"user\"(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_allocation_drafts_created_correlation_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL created_correlation_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_drafts_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_drafts_lifecycle_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((state = 'active'::refund_allocation_draft_state) AND (finalized_at IS NULL) AND (discarded_at IS NULL)) OR ((state = 'finalized'::refund_allocation_draft_state) AND (finalized_at IS NOT NULL) AND (discarded_at IS NULL)) OR ((state = 'discarded'::refund_allocation_draft_state) AND (finalized_at IS NULL) AND (discarded_at IS NOT NULL))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_drafts_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_drafts_refund_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL refund_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_drafts_refund_id_refunds_id_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (refund_id) REFERENCES refunds(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_allocation_drafts_refund_version_unique", "type": "u", "enforced": true, "validated": true, "deferrable": false, "definition": "UNIQUE (id, refund_id, version)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_drafts_state_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL state", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_drafts_updated_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL updated_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_drafts_updated_by_admin_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL updated_by_admin_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_drafts_updated_by_admin_id_user_id_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (updated_by_admin_id) REFERENCES \"user\"(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_allocation_drafts_updated_correlation_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL updated_correlation_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_drafts_version_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL version", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_drafts_version_positive", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((version > 0))", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "refund_allocation_drafts_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [{"name": "refund_allocation_drafts_active_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX refund_allocation_drafts_active_unique ON public.refund_allocation_drafts USING btree (refund_id) WHERE (state = 'active'::refund_allocation_draft_state)"}], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": [{"name": "refund_allocation_draft_items_draft_id_refund_allocation_drafts", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (draft_id) REFERENCES refund_allocation_drafts(id) ON DELETE RESTRICT", "source_table": "refund_allocation_draft_items", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_allocation_finalization_effects_draft_version_fk", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (draft_id, refund_id, draft_version) REFERENCES refund_allocation_drafts(id, refund_id, version) ON DELETE RESTRICT", "source_table": "refund_allocation_finalization_effects", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}]}$catalog$::jsonb),
  ('table', 'public', null, 'refund_allocation_finalization_effects', null, 'a84f0cc4caed5cfae7ed9278b5827517f88d4437b6f4e4d869e16c22a98f3010', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [], "name": "id", "type": "uuid", "default": "gen_random_uuid()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "refund_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "refund_allocation_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "draft_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "draft_version", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "order_item_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "purchase_grant_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "before_purchase_grant_state", "type": "entitlement_grant_status", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "after_purchase_grant_state", "type": "entitlement_grant_status", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "before_effective_access", "type": "boolean", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "after_effective_access", "type": "boolean", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "transition", "type": "financial_finalization_transition", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "correlation_id", "type": "character varying(100)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "occurred_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}], "relkind": "r", "triggers": [{"name": "refund_allocation_finalization_effects_immutable", "enabled": "O", "definition": "CREATE TRIGGER refund_allocation_finalization_effects_immutable BEFORE DELETE OR UPDATE ON public.refund_allocation_finalization_effects FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}, {"name": "refund_allocation_finalization_effects_validate_insert", "enabled": "O", "definition": "CREATE TRIGGER refund_allocation_finalization_effects_validate_insert AFTER INSERT ON public.refund_allocation_finalization_effects FOR EACH ROW EXECUTE FUNCTION plan6b_validate_finalization_effect_insert()"}], "reloptions": [], "constraints": [{"name": "refund_allocation_finalizat_after_purchase_grant_state_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL after_purchase_grant_state", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_finalizat_before_purchase_grant_stat_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL before_purchase_grant_state", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_finalization__after_effective_access_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL after_effective_access", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_finalization_before_effective_access_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL before_effective_access", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_finalization_ef_refund_allocation_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL refund_allocation_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_finalization_effec_purchase_grant_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL purchase_grant_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_finalization_effects_allocation_graph_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (refund_allocation_id, refund_id, order_item_id) REFERENCES refund_allocations(id, refund_id, order_item_id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_allocation_finalization_effects_correlation_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL correlation_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_finalization_effects_correlation_safe", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((char_length((correlation_id)::text) >= 1) AND (char_length((correlation_id)::text) <= 100)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_finalization_effects_draft_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL draft_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_finalization_effects_draft_item_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (draft_id, order_item_id) REFERENCES refund_allocation_draft_items(draft_id, order_item_id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_allocation_finalization_effects_draft_version_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (draft_id, refund_id, draft_version) REFERENCES refund_allocation_drafts(id, refund_id, version) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_allocation_finalization_effects_draft_version_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL draft_version", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_finalization_effects_draft_version_positive", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((draft_version > 0))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_finalization_effects_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_finalization_effects_occurred_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL occurred_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_finalization_effects_order_item_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL order_item_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_finalization_effects_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_finalization_effects_purchase_grant_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (purchase_grant_id, order_item_id) REFERENCES entitlement_grants(id, order_item_id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_allocation_finalization_effects_refund_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL refund_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_finalization_effects_transition_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((transition = 'unchanged'::financial_finalization_transition) AND (before_purchase_grant_state = after_purchase_grant_state) AND (before_effective_access = after_effective_access)) OR ((transition = 'revoked_by_finalization'::financial_finalization_transition) AND (before_purchase_grant_state <> 'revoked'::entitlement_grant_status) AND (after_purchase_grant_state = 'revoked'::entitlement_grant_status))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_allocation_finalization_effects_transition_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL transition", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "refund_allocation_finalization_effects_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [{"name": "refund_allocation_finalization_effects_causal_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX refund_allocation_finalization_effects_causal_unique ON public.refund_allocation_finalization_effects USING btree (refund_allocation_id, purchase_grant_id)"}, {"name": "refund_allocation_finalization_effects_refund_item_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX refund_allocation_finalization_effects_refund_item_idx ON public.refund_allocation_finalization_effects USING btree (refund_id, order_item_id, id)"}], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": []}$catalog$::jsonb),
  ('table', 'public', null, 'refund_reporting_correction_items', null, 'c18c5d7bab32a63ca9163bfd509ea7b869e49e9b7298a724b41aa56c6e792838', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [{"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}], "name": "id", "type": "uuid", "default": "gen_random_uuid()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "correction_set_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "domain", "type": "refund_correction_domain", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "source_allocation_set_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "order_item_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "component", "type": "financial_component", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "currency", "type": "character varying(3)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "approved_absolute_minor", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "delta_minor", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "stable_tie_break_key", "type": "character varying(255)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "created_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}], "relkind": "r", "triggers": [{"name": "refund_reporting_correction_items_immutable", "enabled": "O", "definition": "CREATE TRIGGER refund_reporting_correction_items_immutable BEFORE DELETE OR UPDATE ON public.refund_reporting_correction_items FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}], "reloptions": [], "constraints": [{"name": "refund_reporting_correction_it_approved_absolute_minor_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL approved_absolute_minor", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_items_component_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((domain = 'presentment'::refund_correction_domain) AND (component = ANY (ARRAY['refund_subtotal'::financial_component, 'refund_tax'::financial_component]))) OR ((domain = 'settlement'::refund_correction_domain) AND (component = ANY (ARRAY['refund_subtotal'::financial_component, 'refund_tax'::financial_component, 'refund_fee'::financial_component])))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_items_component_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL component", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_items_correction_set_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL correction_set_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_items_correction_set_id_refund_repo", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (correction_set_id) REFERENCES refund_reporting_correction_sets(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_reporting_correction_items_created_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL created_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_items_currency_iso", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((currency)::text ~ '^[A-Z]{3}$'::text))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_items_currency_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL currency", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_items_delta_minor_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL delta_minor", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_items_domain_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL domain", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_items_domain_source_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((domain = 'presentment'::refund_correction_domain) = (source_allocation_set_id IS NULL)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_items_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_items_money_bounded", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((approved_absolute_minor >= '-99999999'::integer) AND (approved_absolute_minor <= 99999999)) AND ((delta_minor >= '-99999999'::integer) AND (delta_minor <= 99999999))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_items_order_item_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL order_item_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_items_order_item_id_order_items_id_", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_reporting_correction_items_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_items_source_allocation_set_id_fina", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (source_allocation_set_id) REFERENCES financial_allocation_sets(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_reporting_correction_items_stable_tie_break_key_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL stable_tie_break_key", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_items_tie_key_safe", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((char_length((stable_tie_break_key)::text) >= 1) AND (char_length((stable_tie_break_key)::text) <= 255)))", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "refund_reporting_correction_items_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [{"name": "refund_reporting_correction_items_set_item_component_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX refund_reporting_correction_items_set_item_component_unique ON public.refund_reporting_correction_items USING btree (correction_set_id, domain, COALESCE(source_allocation_set_id, '00000000-0000-0000-0000-000000000000'::uuid), currency, order_item_id, component)"}, {"name": "refund_reporting_correction_items_set_tie_key_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX refund_reporting_correction_items_set_tie_key_unique ON public.refund_reporting_correction_items USING btree (correction_set_id, stable_tie_break_key)"}], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": []}$catalog$::jsonb),
  ('table', 'public', null, 'refund_reporting_correction_sets', null, '8566ef4dc734af0ca89a487de819f841cb47b7d92f18794d43a0cc59e482c96b', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [{"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}], "name": "id", "type": "uuid", "default": "gen_random_uuid()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "refund_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "correction_version", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "kind", "type": "refund_correction_kind", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "base_allocation_set_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "predecessor_correction_set_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "source_fingerprint_sha256", "type": "character varying(64)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "approved_by_admin_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "created_by_admin_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "correlation_id", "type": "character varying(100)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "created_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}], "relkind": "r", "triggers": [{"name": "refund_reporting_correction_sets_immutable", "enabled": "O", "definition": "CREATE TRIGGER refund_reporting_correction_sets_immutable BEFORE DELETE OR UPDATE ON public.refund_reporting_correction_sets FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}], "reloptions": [], "constraints": [{"name": "refund_reporting_correction__source_fingerprint_sha256_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL source_fingerprint_sha256", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_set_base_allocation_set_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL base_allocation_set_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_sets_approved_by_admin_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL approved_by_admin_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_sets_approved_by_admin_id_user_id_f", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (approved_by_admin_id) REFERENCES \"user\"(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_reporting_correction_sets_base_allocation_set_id_financi", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (base_allocation_set_id) REFERENCES financial_allocation_sets(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_reporting_correction_sets_correction_version_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL correction_version", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_sets_correlation_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL correlation_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_sets_correlation_safe", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((char_length((correlation_id)::text) >= 1) AND (char_length((correlation_id)::text) <= 100)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_sets_created_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL created_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_sets_created_by_admin_id_user_id_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (created_by_admin_id) REFERENCES \"user\"(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_reporting_correction_sets_creator_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((kind = 'allocation_attribution_correction'::refund_correction_kind) AND (created_by_admin_id IS NOT NULL)) OR ((kind = 'classifier_rebase'::refund_correction_kind) AND (created_by_admin_id IS NULL))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_sets_fingerprint_sha256", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((source_fingerprint_sha256)::text ~ '^[a-f0-9]{64}$'::text))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_sets_graph_identity_unique", "type": "u", "enforced": true, "validated": true, "deferrable": false, "definition": "UNIQUE (id, refund_id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_sets_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_sets_kind_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL kind", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_sets_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_sets_predecessor_graph_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (predecessor_correction_set_id, refund_id) REFERENCES refund_reporting_correction_sets(id, refund_id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_reporting_correction_sets_refund_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL refund_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "refund_reporting_correction_sets_refund_id_refunds_id_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (refund_id) REFERENCES refunds(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_reporting_correction_sets_version_positive", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((correction_version > 0))", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "refund_reporting_correction_sets_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [{"name": "refund_reporting_correction_sets_base_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX refund_reporting_correction_sets_base_idx ON public.refund_reporting_correction_sets USING btree (base_allocation_set_id, id)"}, {"name": "refund_reporting_correction_sets_identity_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX refund_reporting_correction_sets_identity_unique ON public.refund_reporting_correction_sets USING btree (refund_id, correction_version)"}, {"name": "refund_reporting_correction_sets_root_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX refund_reporting_correction_sets_root_unique ON public.refund_reporting_correction_sets USING btree (refund_id) WHERE (predecessor_correction_set_id IS NULL)"}, {"name": "refund_reporting_correction_sets_successor_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX refund_reporting_correction_sets_successor_unique ON public.refund_reporting_correction_sets USING btree (predecessor_correction_set_id) WHERE (predecessor_correction_set_id IS NOT NULL)"}], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": [{"name": "refund_reporting_correction_items_correction_set_id_refund_repo", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (correction_set_id) REFERENCES refund_reporting_correction_sets(id) ON DELETE RESTRICT", "source_table": "refund_reporting_correction_items", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "refund_reporting_correction_sets_predecessor_graph_fk", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (predecessor_correction_set_id, refund_id) REFERENCES refund_reporting_correction_sets(id, refund_id) ON DELETE RESTRICT", "source_table": "refund_reporting_correction_sets", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}]}$catalog$::jsonb),
  ('table', 'public', null, 'stripe_balance_transaction_fee_details', null, '8fdb5f0adac327f8dade00e4274704abfa278da83fcc2cfabf87606973cadc57', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [{"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}], "name": "id", "type": "uuid", "default": "gen_random_uuid()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "balance_transaction_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "ordinal", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "raw_type", "type": "character varying(100)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "amount_minor", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "currency", "type": "character varying(3)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "fingerprint_sha256", "type": "character varying(64)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}], "relkind": "r", "triggers": [{"name": "stripe_balance_transaction_fee_details_immutable", "enabled": "O", "definition": "CREATE TRIGGER stripe_balance_transaction_fee_details_immutable BEFORE DELETE OR UPDATE ON public.stripe_balance_transaction_fee_details FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}], "reloptions": [], "constraints": [{"name": "stripe_balance_transaction_fee__balance_transaction_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL balance_transaction_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transaction_fee_deta_fingerprint_sha256_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL fingerprint_sha256", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transaction_fee_details_amount_bounded", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((amount_minor >= 0) AND (amount_minor <= 99999999)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transaction_fee_details_amount_minor_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL amount_minor", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transaction_fee_details_balance_transaction_id_s", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (balance_transaction_id) REFERENCES stripe_balance_transactions(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "stripe_balance_transaction_fee_details_currency_iso", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((currency)::text ~ '^[A-Z]{3}$'::text))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transaction_fee_details_currency_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL currency", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transaction_fee_details_fingerprint_sha256", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((fingerprint_sha256)::text ~ '^[a-f0-9]{64}$'::text))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transaction_fee_details_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transaction_fee_details_ordinal_nonnegative", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((ordinal >= 0))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transaction_fee_details_ordinal_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL ordinal", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transaction_fee_details_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transaction_fee_details_raw_type_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL raw_type", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transaction_fee_details_type_safe", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((char_length((raw_type)::text) > 0))", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "stripe_balance_transaction_fee_details_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [{"name": "stripe_balance_transaction_fee_details_parent_ordinal_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX stripe_balance_transaction_fee_details_parent_ordinal_unique ON public.stripe_balance_transaction_fee_details USING btree (balance_transaction_id, ordinal)"}], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": []}$catalog$::jsonb),
  ('table', 'public', null, 'stripe_balance_transactions', null, 'b2f5bdf4d2947bba336b7034b9d18b7629b07e6f3c0bf5f2d6dca45c00b0063e', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [], "name": "id", "type": "uuid", "default": "gen_random_uuid()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "provider_id", "type": "character varying(255)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "live_mode", "type": "boolean", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "source_family", "type": "stripe_balance_transaction_source_family", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "source_id", "type": "character varying(255)", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "raw_type", "type": "character varying(100)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "reporting_category", "type": "character varying(100)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "balance_type", "type": "character varying(100)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "amount_minor", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "fee_minor", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "net_minor", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "currency", "type": "character varying(3)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "status", "type": "stripe_balance_transaction_status", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "provider_created_at", "type": "timestamp with time zone", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "available_at", "type": "timestamp with time zone", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "exchange_rate", "type": "numeric(38,18)", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "exchange_source_currency", "type": "character varying(3)", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "exchange_target_currency", "type": "character varying(3)", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "fingerprint_sha256", "type": "character varying(64)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "first_imported_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "last_imported_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}], "relkind": "r", "triggers": [{"name": "stripe_balance_transactions_narrow_update", "enabled": "O", "definition": "CREATE TRIGGER stripe_balance_transactions_narrow_update BEFORE DELETE OR UPDATE ON public.stripe_balance_transactions FOR EACH ROW EXECUTE FUNCTION plan6b_validate_balance_transaction_transition()"}], "reloptions": [], "constraints": [{"name": "stripe_balance_transactions_amount_minor_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL amount_minor", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_available_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL available_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_balance_type_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL balance_type", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_currency_iso", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((currency)::text ~ '^[A-Z]{3}$'::text))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_currency_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL currency", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_exchange_evidence_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((exchange_rate IS NULL) AND (exchange_source_currency IS NULL) AND (exchange_target_currency IS NULL)) OR ((exchange_rate IS NOT NULL) AND (exchange_source_currency IS NOT NULL) AND (exchange_target_currency IS NOT NULL) AND (exchange_rate > (0)::numeric) AND ((exchange_source_currency)::text ~ '^[A-Z]{3}$'::text) AND ((exchange_target_currency)::text ~ '^[A-Z]{3}$'::text) AND ((exchange_target_currency)::text = (currency)::text) AND ((exchange_source_currency)::text <> (exchange_target_currency)::text))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_fee_minor_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL fee_minor", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_fee_nonnegative", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((fee_minor >= 0))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_fingerprint_sha256", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((fingerprint_sha256)::text ~ '^[a-f0-9]{64}$'::text))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_fingerprint_sha256_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL fingerprint_sha256", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_first_imported_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL first_imported_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_import_timestamp_order", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((last_imported_at >= first_imported_at))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_last_imported_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL last_imported_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_live_mode_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL live_mode", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_money_bounded", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((amount_minor >= '-99999999'::integer) AND (amount_minor <= 99999999)) AND ((fee_minor >= 0) AND (fee_minor <= 99999999)) AND ((net_minor >= '-99999999'::integer) AND (net_minor <= 99999999))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_net_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((net_minor = (amount_minor - fee_minor)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_net_minor_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL net_minor", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_provider_created_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL provider_created_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_provider_fields_safe", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((char_length((provider_id)::text) > 0) AND (char_length((raw_type)::text) > 0) AND (char_length((reporting_category)::text) > 0) AND (char_length((balance_type)::text) > 0)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_provider_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL provider_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_raw_type_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL raw_type", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_reporting_category_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL reporting_category", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_source_consistent", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((source_id IS NULL) OR ((source_family IS NOT NULL) AND ((char_length((source_id)::text) >= 1) AND (char_length((source_id)::text) <= 255)))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_balance_transactions_status_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL status", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "stripe_balance_transactions_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [{"name": "stripe_balance_transactions_currency_created_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX stripe_balance_transactions_currency_created_idx ON public.stripe_balance_transactions USING btree (currency, provider_created_at, id)"}, {"name": "stripe_balance_transactions_provider_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX stripe_balance_transactions_provider_unique ON public.stripe_balance_transactions USING btree (provider_id)"}, {"name": "stripe_balance_transactions_source_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX stripe_balance_transactions_source_idx ON public.stripe_balance_transactions USING btree (source_family, source_id)"}, {"name": "stripe_balance_transactions_status_available_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX stripe_balance_transactions_status_available_idx ON public.stripe_balance_transactions USING btree (status, available_at, id)"}], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": [{"name": "financial_allocation_sets_balance_transaction_id_stripe_balance", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (balance_transaction_id) REFERENCES stripe_balance_transactions(id) ON DELETE RESTRICT", "source_table": "financial_allocation_sets", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "payout_import_run_entries_balance_transaction_id_stripe_balance", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (balance_transaction_id) REFERENCES stripe_balance_transactions(id) ON DELETE RESTRICT", "source_table": "payout_import_run_entries", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "stripe_balance_transaction_fee_details_balance_transaction_id_s", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (balance_transaction_id) REFERENCES stripe_balance_transactions(id) ON DELETE RESTRICT", "source_table": "stripe_balance_transaction_fee_details", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "stripe_payout_balance_transactions_balance_transaction_id_strip", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (balance_transaction_id) REFERENCES stripe_balance_transactions(id) ON DELETE RESTRICT", "source_table": "stripe_payout_balance_transactions", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "stripe_payouts_balance_transaction_id_stripe_balance_transactio", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (balance_transaction_id) REFERENCES stripe_balance_transactions(id) ON DELETE RESTRICT", "source_table": "stripe_payouts", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "stripe_payouts_failure_balance_transaction_id_stripe_balance_tr", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (failure_balance_transaction_id) REFERENCES stripe_balance_transactions(id) ON DELETE RESTRICT", "source_table": "stripe_payouts", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}]}$catalog$::jsonb),
  ('table', 'public', null, 'stripe_payout_balance_transactions', null, '7fbe12cbfc1781edc9b713740cbae78ac4000064f8ca6a08517272161db8bc61', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [{"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}], "name": "id", "type": "uuid", "default": "gen_random_uuid()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "payout_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "balance_transaction_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "published_from_run_id", "type": "uuid", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "published_at", "type": "timestamp with time zone", "default": "now()", "identity": "", "not_null": true, "collation": null, "generated": ""}], "relkind": "r", "triggers": [{"name": "stripe_payout_balance_transactions_immutable", "enabled": "O", "definition": "CREATE TRIGGER stripe_payout_balance_transactions_immutable BEFORE DELETE OR UPDATE ON public.stripe_payout_balance_transactions FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}], "reloptions": [], "constraints": [{"name": "stripe_payout_balance_transacti_balance_transaction_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL balance_transaction_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payout_balance_transactio_published_from_run_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL published_from_run_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payout_balance_transactions_balance_transaction_id_strip", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (balance_transaction_id) REFERENCES stripe_balance_transactions(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "stripe_payout_balance_transactions_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payout_balance_transactions_payout_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL payout_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payout_balance_transactions_payout_id_stripe_payouts_id_", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (payout_id) REFERENCES stripe_payouts(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "stripe_payout_balance_transactions_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payout_balance_transactions_published_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL published_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payout_balance_transactions_run_payout_fk", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (published_from_run_id, payout_id) REFERENCES payout_import_runs(id, payout_id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}], "persistence": "p", "primary_key": {"name": "stripe_payout_balance_transactions_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [{"name": "stripe_payout_balance_transactions_pair_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX stripe_payout_balance_transactions_pair_unique ON public.stripe_payout_balance_transactions USING btree (payout_id, balance_transaction_id)"}, {"name": "stripe_payout_balance_transactions_payout_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX stripe_payout_balance_transactions_payout_idx ON public.stripe_payout_balance_transactions USING btree (payout_id, id)"}, {"name": "stripe_payout_balance_transactions_transaction_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX stripe_payout_balance_transactions_transaction_unique ON public.stripe_payout_balance_transactions USING btree (balance_transaction_id)"}], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": []}$catalog$::jsonb),
  ('table', 'public', null, 'stripe_payouts', null, '1074b02503a3d4a5a5ba8a7ef55948e337e7b580b6e56ecb2d6d82303b6339a1', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "pale_orbit_financial_worker", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "rules": [], "columns": [{"acl": [], "name": "id", "type": "uuid", "default": "gen_random_uuid()", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "provider_id", "type": "character varying(255)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "live_mode", "type": "boolean", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "amount_minor", "type": "integer", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "currency", "type": "character varying(3)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "automatic", "type": "boolean", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "method", "type": "stripe_payout_method", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "status", "type": "stripe_payout_status", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "reconciliation_status", "type": "stripe_payout_reconciliation_status", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "provider_created_at", "type": "timestamp with time zone", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "arrival_at", "type": "timestamp with time zone", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "retrieved_at", "type": "timestamp with time zone", "default": null, "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "balance_transaction_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "failure_balance_transaction_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "original_provider_payout_id", "type": "character varying(255)", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "reversed_by_provider_payout_id", "type": "character varying(255)", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "safe_failure_code", "type": "character varying(100)", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "financial_generation", "type": "integer", "default": "0", "identity": "", "not_null": true, "collation": null, "generated": ""}, {"acl": [], "name": "fingerprint_sha256", "type": "character varying(64)", "default": null, "identity": "", "not_null": true, "collation": "pg_catalog.default", "generated": ""}], "relkind": "r", "triggers": [{"name": "stripe_payouts_narrow_update", "enabled": "O", "definition": "CREATE TRIGGER stripe_payouts_narrow_update BEFORE DELETE OR UPDATE ON public.stripe_payouts FOR EACH ROW EXECUTE FUNCTION plan6b_validate_payout_transition()"}], "reloptions": [], "constraints": [{"name": "stripe_payouts_amount_bounded", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((amount_minor >= '-99999999'::integer) AND (amount_minor <= 99999999)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_amount_minor_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL amount_minor", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_arrival_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL arrival_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_automatic_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL automatic", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_balance_transaction_id_stripe_balance_transactio", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (balance_transaction_id) REFERENCES stripe_balance_transactions(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "stripe_payouts_currency_iso", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((currency)::text ~ '^[A-Z]{3}$'::text))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_currency_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL currency", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_failure_balance_transaction_id_stripe_balance_tr", "type": "f", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (failure_balance_transaction_id) REFERENCES stripe_balance_transactions(id) ON DELETE RESTRICT", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "stripe_payouts_failure_code_safe", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((safe_failure_code IS NULL) OR ((safe_failure_code)::text ~ '^[a-z0-9_]{1,100}$'::text)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_financial_generation_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL financial_generation", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_fingerprint_sha256", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((fingerprint_sha256)::text ~ '^[a-f0-9]{64}$'::text))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_fingerprint_sha256_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL fingerprint_sha256", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_generation_bounded", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((financial_generation >= 0) AND (financial_generation <= 2147483647)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_linked_transactions_distinct", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((balance_transaction_id IS NULL) OR (failure_balance_transaction_id IS NULL) OR (balance_transaction_id <> failure_balance_transaction_id)))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_live_mode_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL live_mode", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_method_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL method", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_pkey", "type": "p", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_provider_created_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL provider_created_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_provider_id_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL provider_id", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_reconciliation_status_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL reconciliation_status", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_reconciliation_supported", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK (((reconciliation_status = 'not_applicable'::stripe_payout_reconciliation_status) OR (automatic AND (method = 'standard'::stripe_payout_method))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_related_ids_safe", "type": "c", "enforced": true, "validated": true, "deferrable": false, "definition": "CHECK ((((original_provider_payout_id IS NULL) OR ((char_length((original_provider_payout_id)::text) > 0) AND ((original_provider_payout_id)::text <> (provider_id)::text))) AND ((reversed_by_provider_payout_id IS NULL) OR ((char_length((reversed_by_provider_payout_id)::text) > 0) AND ((reversed_by_provider_payout_id)::text <> (provider_id)::text)))))", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_retrieved_at_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL retrieved_at", "initially_deferred": false, "internal_trigger_modes": []}, {"name": "stripe_payouts_status_not_null", "type": "n", "enforced": true, "validated": true, "deferrable": false, "definition": "NOT NULL status", "initially_deferred": false, "internal_trigger_modes": []}], "persistence": "p", "primary_key": {"name": "stripe_payouts_pkey", "enforced": true, "validated": true, "deferrable": false, "definition": "PRIMARY KEY (id)", "initially_deferred": false}, "is_partition": false, "row_security": false, "explicit_indexes": [{"name": "stripe_payouts_balance_transaction_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX stripe_payouts_balance_transaction_idx ON public.stripe_payouts USING btree (balance_transaction_id)"}, {"name": "stripe_payouts_failure_balance_transaction_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX stripe_payouts_failure_balance_transaction_idx ON public.stripe_payouts USING btree (failure_balance_transaction_id)"}, {"name": "stripe_payouts_provider_unique", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": true, "primary": false, "exclusion": false, "definition": "CREATE UNIQUE INDEX stripe_payouts_provider_unique ON public.stripe_payouts USING btree (provider_id)"}, {"name": "stripe_payouts_reconciliation_created_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX stripe_payouts_reconciliation_created_idx ON public.stripe_payouts USING btree (reconciliation_status, provider_created_at, id)"}, {"name": "stripe_payouts_status_created_idx", "owner": "DATABASE_OWNER", "ready": true, "valid": true, "unique": false, "primary": false, "exclusion": false, "definition": "CREATE INDEX stripe_payouts_status_created_idx ON public.stripe_payouts USING btree (status, provider_created_at, id)"}], "inheritance_edges": [], "force_row_security": false, "referencing_foreign_keys": [{"name": "payout_import_runs_payout_id_stripe_payouts_id_fk", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (payout_id) REFERENCES stripe_payouts(id) ON DELETE RESTRICT", "source_table": "payout_import_runs", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}, {"name": "stripe_payout_balance_transactions_payout_id_stripe_payouts_id_", "enforced": true, "validated": true, "deferrable": false, "definition": "FOREIGN KEY (payout_id) REFERENCES stripe_payouts(id) ON DELETE RESTRICT", "source_table": "stripe_payout_balance_transactions", "source_schema": "public", "initially_deferred": false, "internal_trigger_modes": ["O", "O", "O", "O"]}]}$catalog$::jsonb),
  ('trigger', 'public', 'audit_events', 'audit_events_plan6b_web_insert_guard', null, '8329a3655577394ec2498d30c31dd478b577160a3fab03f4a7545735b9bb8916', $catalog${"enabled": "O", "definition": "CREATE TRIGGER audit_events_plan6b_web_insert_guard BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION plan6b_guard_audit_insert()"}$catalog$::jsonb),
  ('trigger', 'public', 'dispute_item_allocations', 'dispute_item_allocations_immutable', null, 'c35627ec60d7e074f9b7a5b9375a46bd77aa3fa70e0b7acbdc0e4553cc096ff5', $catalog${"enabled": "O", "definition": "CREATE TRIGGER dispute_item_allocations_immutable BEFORE DELETE OR UPDATE ON public.dispute_item_allocations FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}$catalog$::jsonb),
  ('trigger', 'public', 'dispute_item_allocations', 'dispute_item_allocations_validate_gross_set', null, 'f18342428d41670d722f37e0031e7660c39b36cdefe36f36dad2c3a0f4e534aa', $catalog${"enabled": "O", "definition": "CREATE TRIGGER dispute_item_allocations_validate_gross_set BEFORE INSERT ON public.dispute_item_allocations FOR EACH ROW EXECUTE FUNCTION plan6b_validate_dispute_gross_allocation_set()"}$catalog$::jsonb),
  ('trigger', 'public', 'disputes', 'disputes_financial_issue_subject_guard', null, '757dcb6787827dbd248f445016d7c88dffb572c85fee95ebb65c53d452525076', $catalog${"enabled": "O", "definition": "CREATE TRIGGER disputes_financial_issue_subject_guard BEFORE DELETE OR UPDATE OF id ON public.disputes FOR EACH ROW EXECUTE FUNCTION plan6b_guard_financial_issue_subject_mutation()"}$catalog$::jsonb),
  ('trigger', 'public', 'financial_allocation_sets', 'financial_allocation_sets_immutable', null, '06bb11f70efb4c3904fe20025dffad0e9f2d99d542ad32c60cf29d9a2d248d82', $catalog${"enabled": "O", "definition": "CREATE TRIGGER financial_allocation_sets_immutable BEFORE DELETE OR UPDATE ON public.financial_allocation_sets FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}$catalog$::jsonb),
  ('trigger', 'public', 'financial_allocation_sets', 'financial_allocation_sets_supersession_lineage_check', null, '5d46a5ca31705c0500790be3edea54c180e0db91d69a39a1ce0c59500f49944e', $catalog${"enabled": "O", "definition": "CREATE CONSTRAINT TRIGGER financial_allocation_sets_supersession_lineage_check AFTER INSERT OR UPDATE ON public.financial_allocation_sets NOT DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION enforce_financial_allocation_supersession_lineage()"}$catalog$::jsonb),
  ('trigger', 'public', 'financial_classification_versions', 'financial_classification_versions_immutable', null, 'a474d9fd0d67cc13e23c729432b3076d775c156d3e8402bccf1f0a84989321ef', $catalog${"enabled": "O", "definition": "CREATE TRIGGER financial_classification_versions_immutable BEFORE DELETE OR UPDATE ON public.financial_classification_versions FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}$catalog$::jsonb),
  ('trigger', 'public', 'financial_classification_versions', 'financial_classification_versions_unknown_issue_required', null, '1eb80077472147abc3092fccbeddf64c2e0b0dd4346c700899eed3108899bcaa', $catalog${"enabled": "O", "definition": "CREATE CONSTRAINT TRIGGER financial_classification_versions_unknown_issue_required AFTER INSERT ON public.financial_classification_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.classification = 'unknown'::financial_classification)) EXECUTE FUNCTION plan6b_validate_unknown_classification_issue()"}$catalog$::jsonb),
  ('trigger', 'public', 'financial_item_allocations', 'financial_item_allocations_immutable', null, '40e54d7ecefe61649779a241116b508cfc78108911efb83a90ed9af13cd0b5f7', $catalog${"enabled": "O", "definition": "CREATE TRIGGER financial_item_allocations_immutable BEFORE DELETE OR UPDATE ON public.financial_item_allocations FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}$catalog$::jsonb),
  ('trigger', 'public', 'financial_projection_versions', 'financial_projection_versions_narrow_update', null, 'ed6f24abcc27e4e2cac30e6f4e444cb066aacab979cfe39a9a0c7fd0c93b8c67', $catalog${"enabled": "O", "definition": "CREATE TRIGGER financial_projection_versions_narrow_update BEFORE DELETE OR UPDATE ON public.financial_projection_versions FOR EACH ROW EXECUTE FUNCTION plan6b_validate_projection_version_transition()"}$catalog$::jsonb),
  ('trigger', 'public', 'financial_reconciliation_issues', 'financial_reconciliation_issues_narrow_update', null, '22349d9b6d5f916a8680694343c859dbf644513540972a0b0ead6e9b5c7b45ba', $catalog${"enabled": "O", "definition": "CREATE TRIGGER financial_reconciliation_issues_narrow_update BEFORE DELETE OR UPDATE ON public.financial_reconciliation_issues FOR EACH ROW EXECUTE FUNCTION plan6b_validate_issue_transition()"}$catalog$::jsonb),
  ('trigger', 'public', 'financial_reconciliation_issues', 'financial_reconciliation_issues_validate_insert', null, 'df02112cb67f8b17fe24ec26aeff55d530d52ceb359050ebda99adff14aeb94a', $catalog${"enabled": "O", "definition": "CREATE TRIGGER financial_reconciliation_issues_validate_insert BEFORE INSERT ON public.financial_reconciliation_issues FOR EACH ROW EXECUTE FUNCTION plan6b_validate_issue_insert()"}$catalog$::jsonb),
  ('trigger', 'public', 'guest_identities', 'guest_identities_plan6b_update_guard', null, 'eaf25aae96052ce8b3833fb36ef6765d693186b9f3e04d300ba3c0f3a6ccf27c', $catalog${"enabled": "O", "definition": "CREATE TRIGGER guest_identities_plan6b_update_guard BEFORE UPDATE ON public.guest_identities FOR EACH ROW EXECUTE FUNCTION plan6b_guard_guest_identity_update()"}$catalog$::jsonb),
  ('trigger', 'public', 'jobs', 'jobs_plan6b_web_insert_guard', null, '63360daffb0dc275ec2f9468ae1c094ce67522206795456e57a3158f5c865923', $catalog${"enabled": "O", "definition": "CREATE TRIGGER jobs_plan6b_web_insert_guard BEFORE INSERT ON public.jobs FOR EACH ROW EXECUTE FUNCTION plan6b_guard_job_insert()"}$catalog$::jsonb),
  ('trigger', 'public', 'order_items', 'order_items_plan6b_web_insert_guard', null, '89ff1749eed070b65283c8975fdec19683e6e279d2c07c79218ed688af72bbb2', $catalog${"enabled": "O", "definition": "CREATE TRIGGER order_items_plan6b_web_insert_guard BEFORE INSERT ON public.order_items FOR EACH ROW EXECUTE FUNCTION plan6b_guard_order_item_insert()"}$catalog$::jsonb),
  ('trigger', 'public', 'orders', 'orders_plan6b_web_write_guard', null, '8d4cb18ab8da35a178aa83be4f9a9ec7c5a71c853b27828dca304d1451f3dce3', $catalog${"enabled": "O", "definition": "CREATE TRIGGER orders_plan6b_web_write_guard BEFORE INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION plan6b_guard_order_write()"}$catalog$::jsonb),
  ('trigger', 'public', 'outbox_messages', 'outbox_messages_plan6b_web_insert_guard', null, '510b1c82e0b34056244e18b96ab23695476f0058ff719cc098b089c0238d533f', $catalog${"enabled": "O", "definition": "CREATE TRIGGER outbox_messages_plan6b_web_insert_guard BEFORE INSERT ON public.outbox_messages FOR EACH ROW EXECUTE FUNCTION plan6b_guard_outbox_insert()"}$catalog$::jsonb),
  ('trigger', 'public', 'payments', 'payments_financial_issue_subject_guard', null, '2b0f83e9c0a0e4d76b96d1eb715e9e26e8dffb0c72b2c77703f19a3350479ecb', $catalog${"enabled": "O", "definition": "CREATE TRIGGER payments_financial_issue_subject_guard BEFORE DELETE OR UPDATE OF id ON public.payments FOR EACH ROW EXECUTE FUNCTION plan6b_guard_financial_issue_subject_mutation()"}$catalog$::jsonb),
  ('trigger', 'public', 'payout_import_run_entries', 'payout_import_run_entries_immutable', null, '55cd241f057a4944bd1824b54a5f4499a0065ab37e79841942447bd790c2b3f4', $catalog${"enabled": "O", "definition": "CREATE TRIGGER payout_import_run_entries_immutable BEFORE DELETE OR UPDATE ON public.payout_import_run_entries FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}$catalog$::jsonb),
  ('trigger', 'public', 'refund_allocation_components', 'refund_allocation_components_immutable', null, 'c114abdca339315031b2ea8788badbcf78683c6b3842a0625cd4b26701dbb742', $catalog${"enabled": "O", "definition": "CREATE TRIGGER refund_allocation_components_immutable BEFORE DELETE OR UPDATE ON public.refund_allocation_components FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}$catalog$::jsonb),
  ('trigger', 'public', 'refund_allocation_draft_items', 'refund_allocation_draft_items_narrow_update', null, 'f4b89fdaf45443d8ba56211e8e9263971a68375b38e6274b431dcf79b6fe1a44', $catalog${"enabled": "O", "definition": "CREATE TRIGGER refund_allocation_draft_items_narrow_update BEFORE DELETE OR UPDATE ON public.refund_allocation_draft_items FOR EACH ROW EXECUTE FUNCTION plan6b_validate_refund_draft_item_transition()"}$catalog$::jsonb),
  ('trigger', 'public', 'refund_allocation_draft_items', 'refund_allocation_draft_items_validate_insert', null, 'bc864dd63e3431b187eb07f2423e9d6c17a229bacbf5a79bcad87dfe77fc7a51', $catalog${"enabled": "O", "definition": "CREATE TRIGGER refund_allocation_draft_items_validate_insert BEFORE INSERT ON public.refund_allocation_draft_items FOR EACH ROW EXECUTE FUNCTION plan6b_validate_refund_draft_item_insert()"}$catalog$::jsonb),
  ('trigger', 'public', 'refund_allocation_drafts', 'refund_allocation_drafts_narrow_update', null, '8c1cec154b11ee012913108a0742f08ea031944ae423e0aa983ffc7ff8f4af2c', $catalog${"enabled": "O", "definition": "CREATE TRIGGER refund_allocation_drafts_narrow_update BEFORE DELETE OR UPDATE ON public.refund_allocation_drafts FOR EACH ROW EXECUTE FUNCTION plan6b_validate_refund_draft_transition()"}$catalog$::jsonb),
  ('trigger', 'public', 'refund_allocation_finalization_effects', 'refund_allocation_finalization_effects_immutable', null, '4315bbfddd3ec8a1669ec98bc364a24e0287f72a7da475880574535ea0705818', $catalog${"enabled": "O", "definition": "CREATE TRIGGER refund_allocation_finalization_effects_immutable BEFORE DELETE OR UPDATE ON public.refund_allocation_finalization_effects FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}$catalog$::jsonb),
  ('trigger', 'public', 'refund_allocation_finalization_effects', 'refund_allocation_finalization_effects_validate_insert', null, '5227ee02b288059f1059583100e63608d3198f30abec16e376494e73024c9f46', $catalog${"enabled": "O", "definition": "CREATE TRIGGER refund_allocation_finalization_effects_validate_insert AFTER INSERT ON public.refund_allocation_finalization_effects FOR EACH ROW EXECUTE FUNCTION plan6b_validate_finalization_effect_insert()"}$catalog$::jsonb),
  ('trigger', 'public', 'refund_allocations', 'refund_allocations_immutable', null, '8367877dd0a815e86e6bf4fb7a1fd69d4545d5fe639ac56f66c6c490743c8ada', $catalog${"enabled": "O", "definition": "CREATE TRIGGER refund_allocations_immutable BEFORE DELETE OR UPDATE ON public.refund_allocations FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}$catalog$::jsonb),
  ('trigger', 'public', 'refund_reporting_correction_items', 'refund_reporting_correction_items_immutable', null, 'dead4cb5f54f16a6f55169a4c4580f905805c8c6a586108d322aa11c27b625e6', $catalog${"enabled": "O", "definition": "CREATE TRIGGER refund_reporting_correction_items_immutable BEFORE DELETE OR UPDATE ON public.refund_reporting_correction_items FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}$catalog$::jsonb),
  ('trigger', 'public', 'refund_reporting_correction_sets', 'refund_reporting_correction_sets_immutable', null, 'e94e95f1e874b8df3c093bbbde6e8a23698b5ac14e0315f3e57d92cf2e42fed2', $catalog${"enabled": "O", "definition": "CREATE TRIGGER refund_reporting_correction_sets_immutable BEFORE DELETE OR UPDATE ON public.refund_reporting_correction_sets FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}$catalog$::jsonb),
  ('trigger', 'public', 'refunds', 'refunds_financial_issue_subject_guard', null, 'f216f50d5c9b4be290b96cce13330654ae925478842039fd7685c41d823ac308', $catalog${"enabled": "O", "definition": "CREATE TRIGGER refunds_financial_issue_subject_guard BEFORE DELETE OR UPDATE OF id ON public.refunds FOR EACH ROW EXECUTE FUNCTION plan6b_guard_financial_issue_subject_mutation()"}$catalog$::jsonb),
  ('trigger', 'public', 'stripe_balance_transaction_fee_details', 'stripe_balance_transaction_fee_details_immutable', null, '6e9bb247ead6ba4cba0d6effacd0b789804ffae42ebde8d2e5ef03aab5cc0c7c', $catalog${"enabled": "O", "definition": "CREATE TRIGGER stripe_balance_transaction_fee_details_immutable BEFORE DELETE OR UPDATE ON public.stripe_balance_transaction_fee_details FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}$catalog$::jsonb),
  ('trigger', 'public', 'stripe_balance_transactions', 'stripe_balance_transactions_narrow_update', null, '755dfffd1af9533e4e23cd93f618fb6d1bb9e131bd38afa471186ca6e1ffa924', $catalog${"enabled": "O", "definition": "CREATE TRIGGER stripe_balance_transactions_narrow_update BEFORE DELETE OR UPDATE ON public.stripe_balance_transactions FOR EACH ROW EXECUTE FUNCTION plan6b_validate_balance_transaction_transition()"}$catalog$::jsonb),
  ('trigger', 'public', 'stripe_payout_balance_transactions', 'stripe_payout_balance_transactions_immutable', null, '988388a7da4a730cee32e1527694858a3db46b535b88d3a77ad735f2aa4ee2ac', $catalog${"enabled": "O", "definition": "CREATE TRIGGER stripe_payout_balance_transactions_immutable BEFORE DELETE OR UPDATE ON public.stripe_payout_balance_transactions FOR EACH ROW EXECUTE FUNCTION plan6b_reject_history_mutation()"}$catalog$::jsonb),
  ('trigger', 'public', 'stripe_payouts', 'stripe_payouts_narrow_update', null, 'ccb88aff4301f698ad09ccc14cbedc16b8cffa49c84200c9aae3b79195d8aea8', $catalog${"enabled": "O", "definition": "CREATE TRIGGER stripe_payouts_narrow_update BEFORE DELETE OR UPDATE ON public.stripe_payouts FOR EACH ROW EXECUTE FUNCTION plan6b_validate_payout_transition()"}$catalog$::jsonb),
  ('trigger', 'public', 'title_revisions', 'title_revisions_plan6b_web_write_guard', null, 'c7cd89afce7484d5d74c71cc3363ca51de1c738841f4f94a4d4174a908ed71f1', $catalog${"enabled": "O", "definition": "CREATE TRIGGER title_revisions_plan6b_web_write_guard BEFORE INSERT OR UPDATE ON public.title_revisions FOR EACH ROW EXECUTE FUNCTION plan6b_guard_title_revision_write()"}$catalog$::jsonb),
  ('view', 'public', null, 'current_financial_projection_heads', null, '167bbbe10b7bf89a7efad96ba228e931f780c5c281585e45772b483da2272a45', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "columns": [{"acl": [], "name": "balance_transaction_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "basis", "type": "financial_allocation_basis", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "base_set_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "compatible_correction_tip_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "scope", "type": "financial_allocation_scope", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "currency", "type": "character varying", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}, {"acl": [], "name": "expected_effect_minor", "type": "integer", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "is_complete", "type": "boolean", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "missing_source_count", "type": "integer", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "proposed_issue_code", "type": "character varying(100)", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}], "relkind": "v", "definition": " WITH active_projection_version AS (\n         SELECT financial_projection_versions.classifier_version,\n            financial_projection_versions.allocation_algorithm_version\n           FROM financial_projection_versions\n          WHERE (financial_projection_versions.singleton = true)\n        ), active_classification_job_markers AS (\n         SELECT bt.id AS balance_transaction_id,\n            (count(classification_job.id))::integer AS marker_count\n           FROM ((stripe_balance_transactions bt\n             CROSS JOIN active_projection_version)\n             LEFT JOIN jobs classification_job ON (((classification_job.type = 'commerce.financial-classification'::text) AND (classification_job.deduplication_key = ((((((('financial:classification:'::text || (active_projection_version.classifier_version)::text) || ':'::text) || (active_projection_version.allocation_algorithm_version)::text) || ':balance_transaction:'::text) || (bt.id)::text) || ':'::text) || (bt.fingerprint_sha256)::text)) AND (classification_job.status <> 'succeeded'::job_status))))\n          GROUP BY bt.id, active_projection_version.classifier_version, active_projection_version.allocation_algorithm_version\n        ), current_parent_classification_candidates AS (\n         SELECT bt.id AS balance_transaction_id,\n            (count(classification.id))::integer AS decision_count,\n            (count(*) FILTER (WHERE (classification.classification = 'unknown'::financial_classification)))::integer AS unknown_count\n           FROM ((stripe_balance_transactions bt\n             CROSS JOIN active_projection_version)\n             LEFT JOIN financial_classification_versions classification ON (((classification.subject_type = 'balance_transaction'::financial_classification_subject_type) AND (classification.subject_id = bt.id) AND ((classification.source_fingerprint_sha256)::text = (bt.fingerprint_sha256)::text) AND (classification.classifier_version = active_projection_version.classifier_version))))\n          GROUP BY bt.id, active_projection_version.classifier_version\n        ), current_fee_detail_classification_candidates AS (\n         SELECT detail.balance_transaction_id,\n            detail.id AS fee_detail_id,\n            detail.amount_minor,\n            detail.currency,\n            (count(classification.id))::integer AS decision_count,\n            (count(*) FILTER (WHERE (classification.classification = 'unknown'::financial_classification)))::integer AS unknown_count\n           FROM ((stripe_balance_transaction_fee_details detail\n             CROSS JOIN active_projection_version)\n             LEFT JOIN financial_classification_versions classification ON (((classification.subject_type = 'fee_detail'::financial_classification_subject_type) AND (classification.subject_id = detail.id) AND ((classification.source_fingerprint_sha256)::text = (detail.fingerprint_sha256)::text) AND (classification.classifier_version = active_projection_version.classifier_version))))\n          GROUP BY detail.balance_transaction_id, detail.id, detail.amount_minor, detail.currency, active_projection_version.classifier_version\n        ), current_fee_classification_candidates AS (\n         SELECT bt.id AS balance_transaction_id,\n            (count(detail.fee_detail_id))::integer AS detail_count,\n            COALESCE(sum(detail.amount_minor), (0)::bigint) AS detail_amount_sum,\n            (count(detail.fee_detail_id) FILTER (WHERE ((detail.currency)::text <> (bt.currency)::text)))::integer AS currency_mismatch_count,\n            (COALESCE(sum(detail.decision_count), (0)::bigint))::integer AS decision_count,\n            (COALESCE(sum(detail.unknown_count), (0)::bigint))::integer AS unknown_count\n           FROM (stripe_balance_transactions bt\n             LEFT JOIN current_fee_detail_classification_candidates detail ON ((detail.balance_transaction_id = bt.id)))\n          GROUP BY bt.id\n        ), current_classification_status AS (\n         SELECT parent.balance_transaction_id,\n            parent.decision_count AS parent_decision_count,\n            parent.unknown_count AS parent_unknown_count,\n            fee.detail_count AS fee_detail_count,\n            fee.detail_amount_sum AS fee_detail_amount_sum,\n            fee.currency_mismatch_count AS fee_currency_mismatch_count,\n            fee.decision_count AS fee_decision_count,\n            fee.unknown_count AS fee_unknown_count\n           FROM (current_parent_classification_candidates parent\n             JOIN current_fee_classification_candidates fee ON ((fee.balance_transaction_id = parent.balance_transaction_id)))\n        ), eligible_allocation_sets AS (\n         SELECT s.id,\n            s.allocation_identity,\n            s.balance_transaction_id,\n            s.source_kind,\n            s.source_internal_id,\n            s.basis,\n            s.scope,\n            s.expected_effect_minor,\n            s.currency,\n            s.algorithm_version,\n            s.classifier_version,\n            s.source_fingerprint_sha256,\n            s.supersedes_set_id,\n            s.reversal_of_set_id,\n            s.created_at\n           FROM (financial_allocation_sets s\n             CROSS JOIN active_projection_version)\n          WHERE ((s.classifier_version = active_projection_version.classifier_version) AND (s.algorithm_version = active_projection_version.allocation_algorithm_version))\n        ), eligible_base_tips_unranked AS (\n         SELECT s.id,\n            s.allocation_identity,\n            s.balance_transaction_id,\n            s.source_kind,\n            s.source_internal_id,\n            s.basis,\n            s.scope,\n            s.expected_effect_minor,\n            s.currency,\n            s.algorithm_version,\n            s.classifier_version,\n            s.source_fingerprint_sha256,\n            s.supersedes_set_id,\n            s.reversal_of_set_id,\n            s.created_at\n           FROM eligible_allocation_sets s\n          WHERE (NOT (EXISTS ( SELECT 1\n                   FROM eligible_allocation_sets successor\n                  WHERE (successor.supersedes_set_id = s.id))))\n        ), eligible_base_tips AS (\n         SELECT tip.id,\n            tip.allocation_identity,\n            tip.balance_transaction_id,\n            tip.source_kind,\n            tip.source_internal_id,\n            tip.basis,\n            tip.scope,\n            tip.expected_effect_minor,\n            tip.currency,\n            tip.algorithm_version,\n            tip.classifier_version,\n            tip.source_fingerprint_sha256,\n            tip.supersedes_set_id,\n            tip.reversal_of_set_id,\n            tip.created_at,\n            count(*) OVER (PARTITION BY tip.balance_transaction_id, tip.basis) AS tip_count\n           FROM eligible_base_tips_unranked tip\n        ), base_rollup AS (\n         SELECT bt.id AS balance_transaction_id,\n            basis.value AS basis,\n            (count(base.id))::integer AS base_count,\n            (array_agg(base.id ORDER BY base.id) FILTER (WHERE (base.id IS NOT NULL)))[1] AS base_set_id,\n            (array_agg(base.scope ORDER BY base.id) FILTER (WHERE (base.id IS NOT NULL)))[1] AS scope,\n            (array_agg(base.currency ORDER BY base.id) FILTER (WHERE (base.id IS NOT NULL)))[1] AS currency,\n            (array_agg(base.expected_effect_minor ORDER BY base.id) FILTER (WHERE (base.id IS NOT NULL)))[1] AS expected_effect_minor,\n            (array_agg(base.source_kind ORDER BY base.id) FILTER (WHERE (base.id IS NOT NULL)))[1] AS source_kind,\n            (array_agg(base.source_internal_id ORDER BY base.id) FILTER (WHERE (base.id IS NOT NULL)))[1] AS source_internal_id,\n            (array_agg(base.source_fingerprint_sha256 ORDER BY base.id) FILTER (WHERE (base.id IS NOT NULL)))[1] AS source_fingerprint_sha256,\n            bt.fingerprint_sha256 AS provider_fingerprint,\n            classification.parent_decision_count,\n            classification.parent_unknown_count,\n            classification.fee_detail_count,\n            classification.fee_detail_amount_sum,\n            classification.fee_currency_mismatch_count,\n            classification.fee_decision_count,\n            classification.fee_unknown_count,\n                CASE\n                    WHEN (basis.value = 'gross_amount'::financial_allocation_basis) THEN bt.amount_minor\n                    ELSE (- bt.fee_minor)\n                END AS provider_expected_effect,\n            bt.fee_minor AS provider_fee_minor,\n            bt.currency AS provider_currency\n           FROM (((stripe_balance_transactions bt\n             CROSS JOIN ( VALUES ('gross_amount'::financial_allocation_basis), ('fee'::financial_allocation_basis)) basis(value))\n             JOIN current_classification_status classification ON ((classification.balance_transaction_id = bt.id)))\n             LEFT JOIN eligible_base_tips base ON (((base.balance_transaction_id = bt.id) AND (base.basis = basis.value))))\n          GROUP BY bt.id, basis.value, bt.amount_minor, bt.fee_minor, bt.currency, bt.fingerprint_sha256, classification.parent_decision_count, classification.parent_unknown_count, classification.fee_detail_count, classification.fee_detail_amount_sum, classification.fee_currency_mismatch_count, classification.fee_decision_count, classification.fee_unknown_count\n        ), base_item_rollup AS (\n         SELECT s.id AS base_set_id,\n            (count(item.id))::integer AS item_count,\n            COALESCE(sum(item.effect_minor), (0)::bigint) AS item_effect_sum,\n            (count(item.id) FILTER (WHERE ((item.currency)::text <> (s.currency)::text)))::integer AS currency_mismatch_count\n           FROM (eligible_base_tips s\n             LEFT JOIN financial_item_allocations item ON ((item.allocation_set_id = s.id)))\n          GROUP BY s.id\n        ), refund_presentment_components AS (\n         SELECT allocation.refund_id,\n            allocation.order_item_id,\n            allocation.currency,\n            component.component,\n            component.amount_minor\n           FROM (refund_allocation_components allocation\n             CROSS JOIN LATERAL ( VALUES ('refund_subtotal'::financial_component,allocation.subtotal_minor), ('refund_tax'::financial_component,allocation.tax_minor)) component(component, amount_minor))\n        ), correction_tip_candidates AS (\n         SELECT correction.id,\n            correction.refund_id,\n            correction.correction_version,\n            correction.kind,\n            correction.base_allocation_set_id,\n            correction.predecessor_correction_set_id,\n            correction.source_fingerprint_sha256,\n            correction.approved_by_admin_id,\n            correction.created_by_admin_id,\n            correction.correlation_id,\n            correction.created_at\n           FROM refund_reporting_correction_sets correction\n          WHERE ((EXISTS ( SELECT 1\n                   FROM eligible_allocation_sets anchor\n                  WHERE (anchor.id = correction.base_allocation_set_id))) AND (NOT (EXISTS ( SELECT 1\n                   FROM (refund_reporting_correction_sets successor\n                     JOIN eligible_allocation_sets successor_anchor ON ((successor_anchor.id = successor.base_allocation_set_id)))\n                  WHERE (successor.predecessor_correction_set_id = correction.id)))))\n        ), correction_prevalidation AS (\n         SELECT correction.id,\n            correction.refund_id,\n            correction.correction_version,\n            correction.kind,\n            correction.base_allocation_set_id,\n            correction.predecessor_correction_set_id,\n            correction.source_fingerprint_sha256,\n            correction.approved_by_admin_id,\n            correction.created_by_admin_id,\n            correction.correlation_id,\n            correction.created_at,\n            correction_refund.payment_id AS refund_payment_id,\n            correction_refund.currency AS refund_currency,\n            correction_payment.order_id AS refund_order_id,\n            (\n                CASE\n                    WHEN ((EXISTS ( SELECT 1\n                       FROM refund_reporting_correction_items correction_item\n                      WHERE (correction_item.correction_set_id = correction.id))) AND (correction_refund.status = 'succeeded'::commerce_refund_status) AND ((correction_refund.currency)::text = (correction_payment.currency)::text) AND (anchor.id IS NOT NULL) AND (anchor.tip_count = 1) AND (anchor.source_kind = 'refund'::financial_allocation_source_kind) AND (anchor.source_internal_id = correction.refund_id) AND ((anchor.source_fingerprint_sha256)::text = (correction.source_fingerprint_sha256)::text)) THEN 0\n                    ELSE 1\n                END)::bigint AS invalid_refund_context_count,\n            ( SELECT count(*) AS count\n                   FROM (refund_reporting_correction_items correction_item\n                     LEFT JOIN eligible_base_tips item_source ON ((item_source.id = correction_item.source_allocation_set_id)))\n                  WHERE ((correction_item.correction_set_id = correction.id) AND (correction_item.domain = 'settlement'::refund_correction_domain) AND ((item_source.id IS NULL) OR (item_source.tip_count <> 1) OR (item_source.source_kind <> 'refund'::financial_allocation_source_kind) OR (item_source.source_internal_id <> correction.refund_id) OR ((item_source.source_fingerprint_sha256)::text <> (correction.source_fingerprint_sha256)::text) OR ((correction_item.currency)::text <> (item_source.currency)::text)))) AS invalid_settlement_source_count,\n            ( SELECT count(*) AS count\n                   FROM ( SELECT correction_item.domain,\n                            correction_item.source_allocation_set_id,\n                            correction_item.currency\n                           FROM refund_reporting_correction_items correction_item\n                          WHERE (correction_item.correction_set_id = correction.id)\n                          GROUP BY correction_item.domain, correction_item.source_allocation_set_id, correction_item.currency\n                         HAVING (sum((correction_item.delta_minor)::bigint) <> (0)::numeric)) invalid_delta_group) AS invalid_delta_group_count,\n            ( SELECT count(*) AS count\n                   FROM refund_reporting_correction_items correction_item\n                  WHERE ((correction_item.correction_set_id = correction.id) AND ((NOT (EXISTS ( SELECT 1\n                           FROM order_items order_item\n                          WHERE ((order_item.id = correction_item.order_item_id) AND (order_item.order_id = correction_payment.order_id) AND ((correction_item.domain <> 'presentment'::refund_correction_domain) OR ((order_item.currency)::text = (correction_item.currency)::text)))))) OR ((correction_item.domain = 'presentment'::refund_correction_domain) AND ((correction_item.currency)::text <> (correction_refund.currency)::text))))) AS invalid_order_item_count,\n            ( SELECT count(*) AS count\n                   FROM (refund_reporting_correction_items correction_item\n                     LEFT JOIN financial_item_allocations base_item ON (((base_item.allocation_set_id = correction_item.source_allocation_set_id) AND (base_item.order_item_id = correction_item.order_item_id) AND (base_item.component = correction_item.component))))\n                  WHERE ((correction_item.correction_set_id = correction.id) AND (correction_item.domain = 'settlement'::refund_correction_domain) AND (((correction_item.approved_absolute_minor)::bigint <> ((COALESCE(base_item.effect_minor, 0))::bigint + (correction_item.delta_minor)::bigint)) OR ((base_item.id IS NOT NULL) AND ((base_item.currency)::text <> (correction_item.currency)::text))))) AS invalid_settlement_arithmetic_count,\n            ( SELECT count(*) AS count\n                   FROM financial_item_allocations base_item\n                  WHERE ((base_item.effect_minor <> 0) AND (EXISTS ( SELECT 1\n                           FROM refund_reporting_correction_items source_item\n                          WHERE ((source_item.correction_set_id = correction.id) AND (source_item.domain = 'settlement'::refund_correction_domain) AND (source_item.source_allocation_set_id = base_item.allocation_set_id)))) AND (NOT (EXISTS ( SELECT 1\n                           FROM refund_reporting_correction_items correction_item\n                          WHERE ((correction_item.correction_set_id = correction.id) AND (correction_item.domain = 'settlement'::refund_correction_domain) AND (correction_item.source_allocation_set_id = base_item.allocation_set_id) AND (correction_item.order_item_id = base_item.order_item_id) AND (correction_item.component = base_item.component) AND ((correction_item.currency)::text = (base_item.currency)::text))))))) AS missing_settlement_base_count,\n            ( SELECT count(*) AS count\n                   FROM (refund_reporting_correction_items correction_item\n                     LEFT JOIN refund_presentment_components base_component ON (((base_component.refund_id = correction.refund_id) AND (base_component.order_item_id = correction_item.order_item_id) AND (base_component.component = correction_item.component))))\n                  WHERE ((correction_item.correction_set_id = correction.id) AND (correction_item.domain = 'presentment'::refund_correction_domain) AND ((correction_item.approved_absolute_minor < 0) OR ((correction_item.approved_absolute_minor)::bigint <> ((COALESCE(base_component.amount_minor, 0))::bigint + (correction_item.delta_minor)::bigint)) OR ((base_component.refund_id IS NOT NULL) AND ((base_component.currency)::text <> (correction_item.currency)::text))))) AS invalid_presentment_arithmetic_count,\n            ( SELECT count(*) AS count\n                   FROM refund_presentment_components base_component\n                  WHERE ((base_component.refund_id = correction.refund_id) AND (base_component.amount_minor <> 0) AND (EXISTS ( SELECT 1\n                           FROM refund_reporting_correction_items presentment_item\n                          WHERE ((presentment_item.correction_set_id = correction.id) AND (presentment_item.domain = 'presentment'::refund_correction_domain)))) AND (NOT (EXISTS ( SELECT 1\n                           FROM refund_reporting_correction_items correction_item\n                          WHERE ((correction_item.correction_set_id = correction.id) AND (correction_item.domain = 'presentment'::refund_correction_domain) AND (correction_item.order_item_id = base_component.order_item_id) AND (correction_item.component = base_component.component) AND ((correction_item.currency)::text = (base_component.currency)::text))))))) AS missing_presentment_base_count\n           FROM (((correction_tip_candidates correction\n             JOIN refunds correction_refund ON ((correction_refund.id = correction.refund_id)))\n             JOIN payments correction_payment ON ((correction_payment.id = correction_refund.payment_id)))\n             LEFT JOIN eligible_base_tips anchor ON ((anchor.id = correction.base_allocation_set_id)))\n        ), prevalidated_correction_tips AS (\n         SELECT correction.id,\n            correction.refund_id,\n            correction.correction_version,\n            correction.kind,\n            correction.base_allocation_set_id,\n            correction.predecessor_correction_set_id,\n            correction.source_fingerprint_sha256,\n            correction.approved_by_admin_id,\n            correction.created_by_admin_id,\n            correction.correlation_id,\n            correction.created_at,\n            correction.refund_payment_id,\n            correction.refund_currency,\n            correction.refund_order_id,\n            correction.invalid_refund_context_count,\n            correction.invalid_settlement_source_count,\n            correction.invalid_delta_group_count,\n            correction.invalid_order_item_count,\n            correction.invalid_settlement_arithmetic_count,\n            correction.missing_settlement_base_count,\n            correction.invalid_presentment_arithmetic_count,\n            correction.missing_presentment_base_count,\n            (((((((correction.invalid_refund_context_count + correction.invalid_settlement_source_count) + correction.invalid_delta_group_count) + correction.invalid_order_item_count) + correction.invalid_settlement_arithmetic_count) + correction.missing_settlement_base_count) + correction.invalid_presentment_arithmetic_count) + correction.missing_presentment_base_count) AS invalid_noncapacity_count\n           FROM correction_prevalidation correction\n        ), effective_presentment_components AS (\n         SELECT effective_refund.payment_id,\n            base_component.refund_id,\n            base_component.order_item_id,\n            base_component.component,\n            base_component.currency,\n            (base_component.amount_minor)::bigint AS effect_minor\n           FROM (refund_presentment_components base_component\n             JOIN refunds effective_refund ON ((effective_refund.id = base_component.refund_id)))\n          WHERE ((effective_refund.status = 'succeeded'::commerce_refund_status) AND (NOT (EXISTS ( SELECT 1\n                   FROM prevalidated_correction_tips correction\n                  WHERE ((correction.refund_id = base_component.refund_id) AND (correction.invalid_noncapacity_count = 0) AND (EXISTS ( SELECT 1\n                           FROM refund_reporting_correction_items correction_item\n                          WHERE ((correction_item.correction_set_id = correction.id) AND (correction_item.domain = 'presentment'::refund_correction_domain)))))))))\n        UNION ALL\n         SELECT correction.refund_payment_id AS payment_id,\n            correction.refund_id,\n            correction_item.order_item_id,\n            correction_item.component,\n            correction_item.currency,\n            (correction_item.approved_absolute_minor)::bigint AS effect_minor\n           FROM (prevalidated_correction_tips correction\n             JOIN refund_reporting_correction_items correction_item ON (((correction_item.correction_set_id = correction.id) AND (correction_item.domain = 'presentment'::refund_correction_domain))))\n          WHERE (correction.invalid_noncapacity_count = 0)\n        ), presentment_capacity_status AS (\n         SELECT effect.payment_id,\n            effect.order_item_id,\n            effect.component,\n            effect.currency,\n            (sum(effect.effect_minor))::bigint AS cumulative_effect_minor,\n            (\n                CASE effect.component\n                    WHEN 'refund_subtotal'::financial_component THEN order_item.unit_subtotal_minor\n                    WHEN 'refund_tax'::financial_component THEN COALESCE(order_item.tax_minor, 0)\n                    ELSE 0\n                END)::bigint AS capacity_minor\n           FROM (effective_presentment_components effect\n             JOIN order_items order_item ON ((order_item.id = effect.order_item_id)))\n          GROUP BY effect.payment_id, effect.order_item_id, effect.component, effect.currency, order_item.unit_subtotal_minor, order_item.tax_minor\n        ), current_correction_tips AS (\n         SELECT correction.id,\n            correction.refund_id,\n            correction.correction_version,\n            correction.kind,\n            correction.base_allocation_set_id,\n            correction.predecessor_correction_set_id,\n            correction.source_fingerprint_sha256,\n            correction.approved_by_admin_id,\n            correction.created_by_admin_id,\n            correction.correlation_id,\n            correction.created_at,\n            correction.refund_payment_id,\n            correction.refund_currency,\n            correction.refund_order_id,\n            correction.invalid_refund_context_count,\n            correction.invalid_settlement_source_count,\n            correction.invalid_delta_group_count,\n            correction.invalid_order_item_count,\n            correction.invalid_settlement_arithmetic_count,\n            correction.missing_settlement_base_count,\n            correction.invalid_presentment_arithmetic_count,\n            correction.missing_presentment_base_count,\n            correction.invalid_noncapacity_count,\n            (correction.invalid_noncapacity_count + ( SELECT count(*) AS count\n                   FROM (refund_reporting_correction_items correction_item\n                     LEFT JOIN presentment_capacity_status capacity ON (((capacity.payment_id = correction.refund_payment_id) AND (capacity.order_item_id = correction_item.order_item_id) AND (capacity.component = correction_item.component) AND ((capacity.currency)::text = (correction_item.currency)::text))))\n                  WHERE ((correction_item.correction_set_id = correction.id) AND (correction_item.domain = 'presentment'::refund_correction_domain) AND ((capacity.order_item_id IS NULL) OR (capacity.cumulative_effect_minor < 0) OR (capacity.cumulative_effect_minor > capacity.capacity_minor))))) AS invalid_correction_count\n           FROM prevalidated_correction_tips correction\n        ), correction_rollup AS (\n         SELECT correction.refund_id,\n            (count(correction.id))::integer AS correction_count,\n            (array_agg(correction.id ORDER BY correction.id))[1] AS correction_tip_id,\n            (array_agg(correction.base_allocation_set_id ORDER BY correction.id))[1] AS anchor_base_set_id,\n            (array_agg(correction.source_fingerprint_sha256 ORDER BY correction.id))[1] AS correction_fingerprint,\n            COALESCE(sum(correction.invalid_correction_count), ((0)::bigint)::numeric) AS invalid_correction_count\n           FROM current_correction_tips correction\n          GROUP BY correction.refund_id\n        ), correction_status AS (\n         SELECT correction.refund_id,\n            correction.correction_count,\n            correction.correction_tip_id,\n            correction.anchor_base_set_id,\n            correction.correction_fingerprint,\n            correction.invalid_correction_count,\n            ((correction.correction_count = 1) AND (correction.invalid_correction_count = (0)::numeric) AND (anchor.id IS NOT NULL) AND (anchor.tip_count = 1) AND (anchor.source_kind = 'refund'::financial_allocation_source_kind) AND (anchor.source_internal_id = correction.refund_id) AND ((anchor.source_fingerprint_sha256)::text = (correction.correction_fingerprint)::text)) AS is_compatible\n           FROM (correction_rollup correction\n             LEFT JOIN eligible_base_tips anchor ON ((anchor.id = correction.anchor_base_set_id)))\n        ), correction_item_rollup AS (\n         SELECT item.source_allocation_set_id AS base_set_id,\n            item.correction_set_id,\n            (count(*))::integer AS item_count,\n            COALESCE(sum(item.approved_absolute_minor), (0)::bigint) AS item_effect_sum,\n            (count(*) FILTER (WHERE ((item.currency)::text <> (source.currency)::text)))::integer AS currency_mismatch_count\n           FROM (refund_reporting_correction_items item\n             JOIN financial_allocation_sets source ON ((source.id = item.source_allocation_set_id)))\n          WHERE (item.domain = 'settlement'::refund_correction_domain)\n          GROUP BY item.source_allocation_set_id, item.correction_set_id\n        ), open_classification_fork_issues AS (\n         SELECT issue.resource_id AS balance_transaction_id,\n            (count(*))::integer AS issue_count\n           FROM financial_reconciliation_issues issue\n          WHERE (((issue.safe_code)::text = 'classification_fork'::text) AND ((issue.resource_type)::text = 'balance_transaction'::text) AND (issue.state = 'open'::financial_issue_state) AND (issue.impact = 'exception'::financial_issue_impact))\n          GROUP BY issue.resource_id\n        ), open_allocation_set_issues AS (\n         SELECT issue.resource_id AS allocation_set_id,\n            (count(*))::integer AS issue_count,\n            ((array_agg(issue.safe_code ORDER BY\n                CASE\n                    WHEN (issue.impact = 'exception'::financial_issue_impact) THEN 0\n                    ELSE 1\n                END, (issue.safe_code COLLATE \"C\"), issue.id))[1])::character varying(100) AS issue_code\n           FROM financial_reconciliation_issues issue\n          WHERE (((issue.resource_type)::text = 'allocation_set'::text) AND (issue.state = 'open'::financial_issue_state) AND (issue.impact <> 'informational'::financial_issue_impact))\n          GROUP BY issue.resource_id\n        ), resolved AS (\n         SELECT base.balance_transaction_id,\n            base.basis,\n            base.base_count,\n            base.base_set_id,\n            base.scope,\n            base.currency,\n            base.expected_effect_minor,\n            base.source_kind,\n            base.source_internal_id,\n            base.source_fingerprint_sha256,\n            base.provider_fingerprint,\n            base.parent_decision_count,\n            base.parent_unknown_count,\n            base.fee_detail_count,\n            base.fee_detail_amount_sum,\n            base.fee_currency_mismatch_count,\n            base.fee_decision_count,\n            base.fee_unknown_count,\n            base.provider_expected_effect,\n            base.provider_fee_minor,\n            base.provider_currency,\n            COALESCE(items.item_count, 0) AS base_item_count,\n            COALESCE(items.item_effect_sum, (0)::bigint) AS base_item_effect_sum,\n            COALESCE(items.currency_mismatch_count, 0) AS base_item_currency_mismatch_count,\n            COALESCE(correction.correction_count, 0) AS correction_count,\n            correction.correction_tip_id,\n            correction.correction_fingerprint,\n            COALESCE(correction.is_compatible, false) AS correction_is_compatible,\n            COALESCE(correction_items.item_count, 0) AS correction_item_count,\n            COALESCE(correction_items.item_effect_sum, (0)::bigint) AS correction_item_effect_sum,\n            COALESCE(correction_items.currency_mismatch_count, 0) AS correction_item_currency_mismatch_count,\n            COALESCE(classification_issue.issue_count, 0) AS classification_fork_issue_count,\n            COALESCE(selected_set_issue.issue_count, 0) AS selected_set_issue_count,\n            selected_set_issue.issue_code AS selected_set_issue_code,\n            COALESCE(active_job.marker_count, 0) AS active_job_marker_count\n           FROM ((((((base_rollup base\n             LEFT JOIN base_item_rollup items ON ((items.base_set_id = base.base_set_id)))\n             LEFT JOIN correction_status correction ON (((base.source_kind = 'refund'::financial_allocation_source_kind) AND (correction.refund_id = base.source_internal_id))))\n             LEFT JOIN correction_item_rollup correction_items ON (((correction_items.base_set_id = base.base_set_id) AND (correction_items.correction_set_id = correction.correction_tip_id))))\n             LEFT JOIN open_classification_fork_issues classification_issue ON ((classification_issue.balance_transaction_id = base.balance_transaction_id)))\n             LEFT JOIN open_allocation_set_issues selected_set_issue ON ((selected_set_issue.allocation_set_id = base.base_set_id)))\n             LEFT JOIN active_classification_job_markers active_job ON ((active_job.balance_transaction_id = base.balance_transaction_id)))\n        )\n SELECT balance_transaction_id,\n    basis,\n        CASE\n            WHEN ((base_count = 1) AND (classification_fork_issue_count = 0) AND (selected_set_issue_count = 0) AND (active_job_marker_count = 0)) THEN base_set_id\n            ELSE NULL::uuid\n        END AS base_set_id,\n        CASE\n            WHEN ((base_count = 1) AND (classification_fork_issue_count = 0) AND (selected_set_issue_count = 0) AND (active_job_marker_count = 0) AND (correction_count = 1) AND correction_is_compatible) THEN correction_tip_id\n            ELSE NULL::uuid\n        END AS compatible_correction_tip_id,\n        CASE\n            WHEN ((base_count = 1) AND (classification_fork_issue_count = 0) AND (selected_set_issue_count = 0) AND (active_job_marker_count = 0)) THEN scope\n            ELSE NULL::financial_allocation_scope\n        END AS scope,\n        CASE\n            WHEN ((base_count = 1) AND (classification_fork_issue_count = 0) AND (selected_set_issue_count = 0) AND (active_job_marker_count = 0)) THEN currency\n            ELSE NULL::character varying(3)\n        END AS currency,\n        CASE\n            WHEN ((base_count = 1) AND (classification_fork_issue_count = 0) AND (selected_set_issue_count = 0) AND (active_job_marker_count = 0)) THEN expected_effect_minor\n            ELSE NULL::integer\n        END AS expected_effect_minor,\n    ((classification_fork_issue_count = 0) AND (selected_set_issue_count = 0) AND (active_job_marker_count = 0) AND (base_count = 1) AND (scope <> 'unresolved'::financial_allocation_scope) AND (parent_decision_count = 1) AND (parent_unknown_count = 0) AND ((basis <> 'fee'::financial_allocation_basis) OR ((fee_decision_count = fee_detail_count) AND (fee_unknown_count = 0) AND (fee_detail_amount_sum = provider_fee_minor) AND (fee_currency_mismatch_count = 0))) AND ((source_fingerprint_sha256)::text = (provider_fingerprint)::text) AND ((currency)::text = (provider_currency)::text) AND (expected_effect_minor = provider_expected_effect) AND (((correction_count = 0) AND (((scope = 'title'::financial_allocation_scope) AND ((base_item_count > 0) OR (expected_effect_minor = 0)) AND (base_item_currency_mismatch_count = 0) AND (base_item_effect_sum = expected_effect_minor)) OR ((scope = 'account'::financial_allocation_scope) AND (base_item_count = 0)))) OR ((correction_count = 1) AND correction_is_compatible AND (((correction_item_count > 0) AND (scope = 'title'::financial_allocation_scope) AND (correction_item_currency_mismatch_count = 0) AND (correction_item_effect_sum = expected_effect_minor)) OR ((correction_item_count = 0) AND (((scope = 'title'::financial_allocation_scope) AND ((base_item_count > 0) OR (expected_effect_minor = 0)) AND (base_item_currency_mismatch_count = 0) AND (base_item_effect_sum = expected_effect_minor)) OR ((scope = 'account'::financial_allocation_scope) AND (base_item_count = 0)))))))) AS is_complete,\n        CASE\n            WHEN (selected_set_issue_count > 0) THEN 1\n            WHEN (classification_fork_issue_count > 0) THEN 1\n            WHEN (active_job_marker_count > 0) THEN 1\n            WHEN ((base_count = 1) AND (scope <> 'unresolved'::financial_allocation_scope) AND (parent_decision_count = 1) AND (parent_unknown_count = 0) AND ((basis <> 'fee'::financial_allocation_basis) OR ((fee_decision_count = fee_detail_count) AND (fee_unknown_count = 0) AND (fee_detail_amount_sum = provider_fee_minor) AND (fee_currency_mismatch_count = 0))) AND ((source_fingerprint_sha256)::text = (provider_fingerprint)::text) AND ((currency)::text = (provider_currency)::text) AND (expected_effect_minor = provider_expected_effect) AND (((correction_count = 0) AND (((scope = 'title'::financial_allocation_scope) AND ((base_item_count > 0) OR (expected_effect_minor = 0)) AND (base_item_currency_mismatch_count = 0) AND (base_item_effect_sum = expected_effect_minor)) OR ((scope = 'account'::financial_allocation_scope) AND (base_item_count = 0)))) OR ((correction_count = 1) AND correction_is_compatible AND (((correction_item_count > 0) AND (scope = 'title'::financial_allocation_scope) AND (correction_item_currency_mismatch_count = 0) AND (correction_item_effect_sum = expected_effect_minor)) OR ((correction_item_count = 0) AND (((scope = 'title'::financial_allocation_scope) AND ((base_item_count > 0) OR (expected_effect_minor = 0)) AND (base_item_currency_mismatch_count = 0) AND (base_item_effect_sum = expected_effect_minor)) OR ((scope = 'account'::financial_allocation_scope) AND (base_item_count = 0)))))))) THEN 0\n            ELSE 1\n        END AS missing_source_count,\n        CASE\n            WHEN (selected_set_issue_count > 0) THEN selected_set_issue_code\n            WHEN (classification_fork_issue_count > 0) THEN 'classification_fork'::character varying(100)\n            WHEN (parent_decision_count = 0) THEN 'missing_source'::character varying(100)\n            WHEN (parent_decision_count > 1) THEN 'classification_fork'::character varying(100)\n            WHEN (parent_unknown_count > 0) THEN 'unsupported_category'::character varying(100)\n            WHEN ((basis = 'fee'::financial_allocation_basis) AND (fee_currency_mismatch_count > 0)) THEN 'currency_mismatch'::character varying(100)\n            WHEN ((basis = 'fee'::financial_allocation_basis) AND (fee_detail_amount_sum <> provider_fee_minor)) THEN 'allocation_mismatch'::character varying(100)\n            WHEN ((basis = 'fee'::financial_allocation_basis) AND (fee_decision_count > fee_detail_count)) THEN 'classification_fork'::character varying(100)\n            WHEN ((basis = 'fee'::financial_allocation_basis) AND (fee_unknown_count > 0)) THEN 'unsupported_category'::character varying(100)\n            WHEN ((basis = 'fee'::financial_allocation_basis) AND (fee_decision_count < fee_detail_count)) THEN 'missing_source'::character varying(100)\n            WHEN (active_job_marker_count > 0) THEN 'missing_source'::character varying(100)\n            WHEN (base_count = 0) THEN 'missing_source'::character varying(100)\n            WHEN (base_count > 1) THEN 'allocation_fork'::character varying(100)\n            WHEN ((source_fingerprint_sha256)::text <> (provider_fingerprint)::text) THEN 'immutable_mismatch'::character varying(100)\n            WHEN ((currency)::text <> (provider_currency)::text) THEN 'currency_mismatch'::character varying(100)\n            WHEN (expected_effect_minor <> provider_expected_effect) THEN 'allocation_mismatch'::character varying(100)\n            WHEN (scope = 'unresolved'::financial_allocation_scope) THEN 'allocation_incomplete'::character varying(100)\n            WHEN (correction_count > 1) THEN 'correction_rebase_required'::character varying(100)\n            WHEN ((correction_count = 1) AND (NOT correction_is_compatible)) THEN 'correction_rebase_required'::character varying(100)\n            WHEN ((correction_count = 1) AND (correction_item_count > 0) AND (correction_item_currency_mismatch_count > 0)) THEN 'currency_mismatch'::character varying(100)\n            WHEN ((correction_count = 1) AND (correction_item_count > 0) AND ((scope <> 'title'::financial_allocation_scope) OR (correction_item_effect_sum <> expected_effect_minor))) THEN 'allocation_mismatch'::character varying(100)\n            WHEN (((correction_count = 0) OR (correction_item_count = 0)) AND (base_item_currency_mismatch_count > 0)) THEN 'currency_mismatch'::character varying(100)\n            WHEN (((correction_count = 0) OR (correction_item_count = 0)) AND (((scope = 'title'::financial_allocation_scope) AND (((base_item_count = 0) AND (expected_effect_minor <> 0)) OR (base_item_effect_sum <> expected_effect_minor))) OR ((scope = 'account'::financial_allocation_scope) AND (base_item_count <> 0)))) THEN 'allocation_mismatch'::character varying(100)\n            ELSE NULL::character varying(100)\n        END AS proposed_issue_code\n   FROM resolved;", "reloptions": [], "persistence": "p", "row_security": false, "force_row_security": false}$catalog$::jsonb),
  ('view', 'public', null, 'current_financial_projection_items', null, '60da7301dabbe95e3d985f05bc7818424da663b695cdd8908dc298cb09299f0b', $catalog${"acl": [{"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "DELETE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "INSERT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "MAINTAIN"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "REFERENCES"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRIGGER"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "TRUNCATE"}, {"grantee": "DATABASE_OWNER", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "UPDATE"}, {"grantee": "pale_orbit_runtime", "grantor": "DATABASE_OWNER", "grantable": false, "privilege": "SELECT"}], "owner": "DATABASE_OWNER", "columns": [{"acl": [], "name": "balance_transaction_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "basis", "type": "financial_allocation_basis", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "base_set_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "compatible_correction_tip_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "order_item_id", "type": "uuid", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "component", "type": "financial_component", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "effect_minor", "type": "integer", "default": null, "identity": "", "not_null": false, "collation": null, "generated": ""}, {"acl": [], "name": "currency", "type": "character varying(3)", "default": null, "identity": "", "not_null": false, "collation": "pg_catalog.default", "generated": ""}], "relkind": "v", "definition": " SELECT head.balance_transaction_id,\n    head.basis,\n    head.base_set_id,\n    head.compatible_correction_tip_id,\n    base.order_item_id,\n    base.component,\n    base.effect_minor,\n    base.currency\n   FROM (current_financial_projection_heads head\n     JOIN financial_item_allocations base ON ((base.allocation_set_id = head.base_set_id)))\n  WHERE (head.is_complete AND (head.scope = 'title'::financial_allocation_scope) AND (NOT (EXISTS ( SELECT 1\n           FROM refund_reporting_correction_items correction\n          WHERE ((correction.correction_set_id = head.compatible_correction_tip_id) AND (correction.source_allocation_set_id = head.base_set_id) AND (correction.domain = 'settlement'::refund_correction_domain))))))\nUNION ALL\n SELECT head.balance_transaction_id,\n    head.basis,\n    head.base_set_id,\n    head.compatible_correction_tip_id,\n    correction.order_item_id,\n    correction.component,\n    correction.approved_absolute_minor AS effect_minor,\n    correction.currency\n   FROM (current_financial_projection_heads head\n     JOIN refund_reporting_correction_items correction ON (((correction.correction_set_id = head.compatible_correction_tip_id) AND (correction.source_allocation_set_id = head.base_set_id) AND (correction.domain = 'settlement'::refund_correction_domain))))\n  WHERE (head.is_complete AND (head.scope = 'title'::financial_allocation_scope));", "reloptions": [], "persistence": "p", "row_security": false, "force_row_security": false}$catalog$::jsonb)
), expected_claim_columns(column_name) as (values
  ('claim_proof_sha256'),
  ('auth_token_sha256'),
  ('normalized_email'),
  ('anchor_order_id'),
  ('kind'),
  ('state'),
  ('authorized_user_id'),
  ('issued_at'),
  ('expires_at'),
  ('authorized_at'),
  ('consumed_at'),
  ('result_disposition'),
  ('result_changed'),
  ('result_order_count'),
  ('result_title_count')
), expected_lock_only_worker_columns(
  grantee_name, relation_name, column_name, privilege_type
) as (values
  ('pale_orbit_financial_worker', 'refund_allocation_drafts', 'id', 'UPDATE'),
  ('pale_orbit_financial_worker', 'refund_allocation_draft_items', 'id', 'UPDATE'),
  ('pale_orbit_financial_worker', 'refund_allocations', 'id', 'UPDATE'),
  ('pale_orbit_financial_worker', 'refund_allocation_components', 'id', 'UPDATE'),
  ('pale_orbit_financial_worker', 'refund_reporting_correction_sets', 'id', 'UPDATE'),
  ('pale_orbit_financial_worker', 'refund_reporting_correction_items', 'id', 'UPDATE'),
  ('pale_orbit_financial_worker', 'dispute_item_allocations', 'id', 'UPDATE'),
  ('pale_orbit_financial_worker', 'stripe_payout_balance_transactions', 'id', 'UPDATE'),
  ('pale_orbit_financial_worker', 'stripe_balance_transaction_fee_details', 'id', 'UPDATE'),
  ('pale_orbit_financial_worker', 'financial_classification_versions', 'id', 'UPDATE'),
  ('pale_orbit_financial_worker', 'financial_allocation_sets', 'id', 'UPDATE'),
  ('pale_orbit_financial_worker', 'financial_item_allocations', 'id', 'UPDATE'),
  ('pale_orbit_financial_worker', 'payout_import_run_entries', 'id', 'UPDATE')
), cleanup_group as (
  select role_row.oid as group_oid
  from pg_catalog.pg_roles role_row
  where role_row.rolname = 'pale_orbit_storage_cleanup'
), cleanup_login as (
  select member_role.oid as login_oid, member_role.rolname as login_name
  from cleanup_group cleanup
  join pg_catalog.pg_auth_members membership on membership.roleid = cleanup.group_oid
  join pg_catalog.pg_roles member_role on member_role.oid = membership.member
), role_labels(role_oid, role_label) as (
  select 0::oid, 'PUBLIC'::text
  union all
  select role_row.oid,
    case
      when role_row.rolname in (session_user, 'pg_database_owner')
        or role_row.oid = (
          select database_row.datdba
          from pg_catalog.pg_database database_row
          where database_row.datname = pg_catalog.current_database()
        ) then 'DATABASE_OWNER'
      when role_row.oid in (select cleanup_login.login_oid from cleanup_login)
        then 'STORAGE_CLEANUP_LOGIN'
      else role_row.rolname
    end
  from pg_catalog.pg_roles role_row
), catalog_relation_acl as (
  select relation_row.oid as object_oid,
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'grantee', grantee.role_label,
          'grantor', grantor.role_label,
          'privilege', acl.privilege_type,
          'grantable', acl.is_grantable
        )
        order by grantee.role_label collate "C", acl.privilege_type collate "C",
          grantor.role_label collate "C", acl.is_grantable
      ),
      '[]'::jsonb
    ) as acl
  from pg_catalog.pg_class relation_row
  cross join lateral pg_catalog.aclexplode(
    coalesce(
      relation_row.relacl,
      pg_catalog.acldefault('r', relation_row.relowner)
    )
  ) acl
  left join role_labels grantee on grantee.role_oid = acl.grantee
  left join role_labels grantor on grantor.role_oid = acl.grantor
  group by relation_row.oid
), catalog_column_acl as (
  select attribute_row.attrelid as object_oid, attribute_row.attnum,
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'grantee', grantee.role_label,
          'grantor', grantor.role_label,
          'privilege', acl.privilege_type,
          'grantable', acl.is_grantable
        )
        order by grantee.role_label collate "C", acl.privilege_type collate "C",
          grantor.role_label collate "C", acl.is_grantable
      ),
      '[]'::jsonb
    ) as acl
  from pg_catalog.pg_attribute attribute_row
  join pg_catalog.pg_class relation_row on relation_row.oid = attribute_row.attrelid
  cross join lateral pg_catalog.aclexplode(
    coalesce(
      attribute_row.attacl,
      pg_catalog.acldefault('c', relation_row.relowner)
    )
  ) acl
  left join role_labels grantee on grantee.role_oid = acl.grantee
  left join role_labels grantor on grantor.role_oid = acl.grantor
  where attribute_row.attnum > 0 and not attribute_row.attisdropped
  group by attribute_row.attrelid, attribute_row.attnum
), catalog_function_acl as (
  select routine.oid as object_oid,
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'grantee', grantee.role_label,
          'grantor', grantor.role_label,
          'privilege', acl.privilege_type,
          'grantable', acl.is_grantable
        )
        order by grantee.role_label collate "C", acl.privilege_type collate "C",
          grantor.role_label collate "C", acl.is_grantable
      ),
      '[]'::jsonb
    ) as acl
  from pg_catalog.pg_proc routine
  cross join lateral pg_catalog.aclexplode(
    coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
  ) acl
  left join role_labels grantee on grantee.role_oid = acl.grantee
  left join role_labels grantor on grantor.role_oid = acl.grantor
  group by routine.oid
), catalog_type_acl as (
  select type_row.oid as object_oid,
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'grantee', grantee.role_label,
          'grantor', grantor.role_label,
          'privilege', acl.privilege_type,
          'grantable', acl.is_grantable
        )
        order by grantee.role_label collate "C", acl.privilege_type collate "C",
          grantor.role_label collate "C", acl.is_grantable
      ),
      '[]'::jsonb
    ) as acl
  from pg_catalog.pg_type type_row
  cross join lateral pg_catalog.aclexplode(
    coalesce(type_row.typacl, pg_catalog.acldefault('T', type_row.typowner))
  ) acl
  left join role_labels grantee on grantee.role_oid = acl.grantee
  left join role_labels grantor on grantor.role_oid = acl.grantor
  group by type_row.oid
), catalog_column_descriptors(
  object_oid, attnum, column_name, descriptor
) as (
  select relation_row.oid, attribute_row.attnum, attribute_row.attname,
    pg_catalog.jsonb_build_object(
      'name', attribute_row.attname,
      'type', pg_catalog.format_type(attribute_row.atttypid, attribute_row.atttypmod),
      'not_null', attribute_row.attnotnull,
      'default', pg_catalog.pg_get_expr(
        default_row.adbin, default_row.adrelid, false
      ),
      'identity', attribute_row.attidentity,
      'generated', attribute_row.attgenerated,
      'collation', case
        when attribute_row.attcollation = 0 then null
        else collation_namespace.nspname || '.' || collation_row.collname
      end,
      'acl', coalesce(column_acl.acl, '[]'::jsonb)
    )
  from pg_catalog.pg_class relation_row
  join pg_catalog.pg_attribute attribute_row
    on attribute_row.attrelid = relation_row.oid
   and attribute_row.attnum > 0
   and not attribute_row.attisdropped
  left join pg_catalog.pg_attrdef default_row
    on default_row.adrelid = attribute_row.attrelid
   and default_row.adnum = attribute_row.attnum
  left join pg_catalog.pg_collation collation_row
    on collation_row.oid = attribute_row.attcollation
  left join pg_catalog.pg_namespace collation_namespace
    on collation_namespace.oid = collation_row.collnamespace
  left join catalog_column_acl column_acl
    on column_acl.object_oid = attribute_row.attrelid
   and column_acl.attnum = attribute_row.attnum
), catalog_relation_columns as (
  select column_descriptor.object_oid,
    pg_catalog.jsonb_agg(
      column_descriptor.descriptor order by column_descriptor.attnum
    ) as columns
  from catalog_column_descriptors column_descriptor
  group by column_descriptor.object_oid
), catalog_table_object_inventory(
  object_oid, constraints, referencing_foreign_keys, explicit_indexes,
  triggers, rules, inheritance_edges
) as (
  select relation_row.oid,
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'name', constraint_row.conname,
          'type', constraint_row.contype,
          'definition', pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
          'validated', constraint_row.convalidated,
          'enforced', constraint_row.conenforced,
          'deferrable', constraint_row.condeferrable,
          'initially_deferred', constraint_row.condeferred,
          'internal_trigger_modes', coalesce((
            select pg_catalog.jsonb_agg(
              constraint_trigger.tgenabled order by constraint_trigger.tgenabled
            )
            from pg_catalog.pg_trigger constraint_trigger
            where constraint_trigger.tgconstraint = constraint_row.oid
              and constraint_trigger.tgisinternal
          ), '[]'::jsonb)
        ) order by constraint_row.conname collate "C"
      )
      from pg_catalog.pg_constraint constraint_row
      where constraint_row.conrelid = relation_row.oid
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'source_schema', source_namespace.nspname,
          'source_table', source_relation.relname,
          'name', constraint_row.conname,
          'definition', pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
          'validated', constraint_row.convalidated,
          'enforced', constraint_row.conenforced,
          'deferrable', constraint_row.condeferrable,
          'initially_deferred', constraint_row.condeferred,
          'internal_trigger_modes', coalesce((
            select pg_catalog.jsonb_agg(
              constraint_trigger.tgenabled order by constraint_trigger.tgenabled
            )
            from pg_catalog.pg_trigger constraint_trigger
            where constraint_trigger.tgconstraint = constraint_row.oid
              and constraint_trigger.tgisinternal
          ), '[]'::jsonb)
        ) order by source_namespace.nspname collate "C",
          source_relation.relname collate "C", constraint_row.conname collate "C"
      )
      from pg_catalog.pg_constraint constraint_row
      join pg_catalog.pg_class source_relation
        on source_relation.oid = constraint_row.conrelid
      join pg_catalog.pg_namespace source_namespace
        on source_namespace.oid = source_relation.relnamespace
      where constraint_row.contype = 'f'
        and constraint_row.confrelid = relation_row.oid
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'name', index_row.relname,
          'definition', pg_catalog.pg_get_indexdef(index_row.oid),
          'valid', index_state.indisvalid,
          'ready', index_state.indisready,
          'unique', index_state.indisunique,
          'primary', index_state.indisprimary,
          'exclusion', index_state.indisexclusion,
          'owner', coalesce(
            index_owner_label.role_label,
            pg_catalog.pg_get_userbyid(index_row.relowner)
          )
        ) order by index_row.relname collate "C"
      )
      from pg_catalog.pg_index index_state
      join pg_catalog.pg_class index_row on index_row.oid = index_state.indexrelid
      left join role_labels index_owner_label
        on index_owner_label.role_oid = index_row.relowner
      where index_state.indrelid = relation_row.oid
        and not exists (
          select 1
          from pg_catalog.pg_constraint constraint_row
          where constraint_row.conindid = index_row.oid
        )
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'name', trigger_row.tgname,
          'definition', pg_catalog.pg_get_triggerdef(trigger_row.oid, false),
          'enabled', trigger_row.tgenabled
        ) order by trigger_row.tgname collate "C"
      )
      from pg_catalog.pg_trigger trigger_row
      where trigger_row.tgrelid = relation_row.oid
        and not trigger_row.tgisinternal
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'name', rule_row.rulename,
          'definition', pg_catalog.pg_get_ruledef(rule_row.oid, false),
          'enabled', rule_row.ev_enabled
        ) order by rule_row.rulename collate "C"
      )
      from pg_catalog.pg_rewrite rule_row
      where rule_row.ev_class = relation_row.oid
        and rule_row.rulename <> '_RETURN'
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'direction', case
            when inheritance_row.inhrelid = relation_row.oid then 'inherits_from'
            else 'inherited_by'
          end,
          'child_schema', child_namespace.nspname,
          'child_table', child_relation.relname,
          'parent_schema', parent_namespace.nspname,
          'parent_table', parent_relation.relname,
          'sequence', inheritance_row.inhseqno,
          'detach_pending', inheritance_row.inhdetachpending
        ) order by
          (case when inheritance_row.inhrelid = relation_row.oid
            then 'inherits_from' else 'inherited_by' end) collate "C",
          child_namespace.nspname collate "C", child_relation.relname collate "C",
          parent_namespace.nspname collate "C", parent_relation.relname collate "C",
          inheritance_row.inhseqno
      )
      from pg_catalog.pg_inherits inheritance_row
      join pg_catalog.pg_class child_relation
        on child_relation.oid = inheritance_row.inhrelid
      join pg_catalog.pg_namespace child_namespace
        on child_namespace.oid = child_relation.relnamespace
      join pg_catalog.pg_class parent_relation
        on parent_relation.oid = inheritance_row.inhparent
      join pg_catalog.pg_namespace parent_namespace
        on parent_namespace.oid = parent_relation.relnamespace
      where inheritance_row.inhrelid = relation_row.oid
        or inheritance_row.inhparent = relation_row.oid
    ), '[]'::jsonb)
  from required_catalog_objects required
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.nspname = required.schema_name
  join pg_catalog.pg_class relation_row
    on relation_row.relnamespace = namespace_row.oid
   and relation_row.relname = required.object_name
   and relation_row.relkind in ('r', 'p')
  where required.object_kind = 'table'
), actual_catalog_objects(
  object_kind, schema_name, parent_name, object_name, identity_arguments,
  actual_catalog
) as (
  select required.object_kind, required.schema_name, required.parent_name,
    required.object_name, required.identity_arguments,
    pg_catalog.jsonb_build_object(
      'columns', relation_columns.columns,
      'relkind', relation_row.relkind,
      'persistence', relation_row.relpersistence,
      'row_security', relation_row.relrowsecurity,
      'force_row_security', relation_row.relforcerowsecurity,
      'is_partition', relation_row.relispartition,
      'constraints', table_inventory.constraints,
      'referencing_foreign_keys', table_inventory.referencing_foreign_keys,
      'explicit_indexes', table_inventory.explicit_indexes,
      'triggers', table_inventory.triggers,
      'rules', table_inventory.rules,
      'inheritance_edges', table_inventory.inheritance_edges,
      'primary_key', (
        select pg_catalog.jsonb_build_object(
          'name', primary_key.conname,
          'definition', pg_catalog.pg_get_constraintdef(primary_key.oid, false),
          'validated', primary_key.convalidated,
          'enforced', primary_key.conenforced,
          'deferrable', primary_key.condeferrable,
          'initially_deferred', primary_key.condeferred
        )
        from pg_catalog.pg_constraint primary_key
        where primary_key.conrelid = relation_row.oid
          and primary_key.contype = 'p'
      ),
      'reloptions', pg_catalog.to_jsonb(
        coalesce(relation_row.reloptions, array[]::text[])
      ),
      'owner', coalesce(
        owner_label.role_label,
        pg_catalog.pg_get_userbyid(relation_row.relowner)
      ),
      'acl', relation_acl.acl
    )
  from required_catalog_objects required
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.nspname = required.schema_name
  join pg_catalog.pg_class relation_row
    on relation_row.relnamespace = namespace_row.oid
   and relation_row.relname = required.object_name
   and relation_row.relkind in ('r', 'p')
  join catalog_relation_columns relation_columns
    on relation_columns.object_oid = relation_row.oid
  join catalog_relation_acl relation_acl
    on relation_acl.object_oid = relation_row.oid
  join catalog_table_object_inventory table_inventory
    on table_inventory.object_oid = relation_row.oid
  left join role_labels owner_label on owner_label.role_oid = relation_row.relowner
  where required.object_kind = 'table'

  union all

  select required.object_kind, required.schema_name, required.parent_name,
    required.object_name, required.identity_arguments,
    pg_catalog.jsonb_build_object(
      'definition', pg_catalog.pg_get_viewdef(relation_row.oid, false),
      'columns', relation_columns.columns,
      'relkind', relation_row.relkind,
      'persistence', relation_row.relpersistence,
      'row_security', relation_row.relrowsecurity,
      'force_row_security', relation_row.relforcerowsecurity,
      'reloptions', pg_catalog.to_jsonb(
        coalesce(relation_row.reloptions, array[]::text[])
      ),
      'owner', coalesce(
        owner_label.role_label,
        pg_catalog.pg_get_userbyid(relation_row.relowner)
      ),
      'acl', relation_acl.acl
    )
  from required_catalog_objects required
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.nspname = required.schema_name
  join pg_catalog.pg_class relation_row
    on relation_row.relnamespace = namespace_row.oid
   and relation_row.relname = required.object_name
   and relation_row.relkind = 'v'
  join catalog_relation_columns relation_columns
    on relation_columns.object_oid = relation_row.oid
  join catalog_relation_acl relation_acl
    on relation_acl.object_oid = relation_row.oid
  left join role_labels owner_label on owner_label.role_oid = relation_row.relowner
  where required.object_kind = 'view'

  union all

  select required.object_kind, required.schema_name, required.parent_name,
    required.object_name, required.identity_arguments,
    column_descriptor.descriptor
  from required_catalog_objects required
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.nspname = required.schema_name
  join pg_catalog.pg_class relation_row
    on relation_row.relnamespace = namespace_row.oid
   and relation_row.relname = required.parent_name
   and relation_row.relkind in ('r', 'p')
  join catalog_column_descriptors column_descriptor
    on column_descriptor.object_oid = relation_row.oid
   and column_descriptor.column_name = required.object_name
  where required.object_kind = 'column'

  union all

  select required.object_kind, required.schema_name, required.parent_name,
    required.object_name, required.identity_arguments,
    pg_catalog.jsonb_build_object(
      'labels', (
        select pg_catalog.jsonb_agg(
          enum_row.enumlabel order by enum_row.enumsortorder
        )
        from pg_catalog.pg_enum enum_row
        where enum_row.enumtypid = type_row.oid
      ),
      'owner', coalesce(
        owner_label.role_label,
        pg_catalog.pg_get_userbyid(type_row.typowner)
      ),
      'acl', type_acl.acl
    )
  from required_catalog_objects required
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.nspname = required.schema_name
  join pg_catalog.pg_type type_row
    on type_row.typnamespace = namespace_row.oid
   and type_row.typname = required.object_name
   and type_row.typtype = 'e'
  join catalog_type_acl type_acl on type_acl.object_oid = type_row.oid
  left join role_labels owner_label on owner_label.role_oid = type_row.typowner
  where required.object_kind = 'enum'

  union all

  select required.object_kind, required.schema_name, required.parent_name,
    required.object_name, required.identity_arguments,
    pg_catalog.jsonb_build_object(
      'relkind', relation_row.relkind,
      'persistence', relation_row.relpersistence,
      'row_security', relation_row.relrowsecurity,
      'force_row_security', relation_row.relforcerowsecurity
    )
  from required_catalog_objects required
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.nspname = required.schema_name
  join pg_catalog.pg_class relation_row
    on relation_row.relnamespace = namespace_row.oid
   and relation_row.relname = required.object_name
   and relation_row.relkind in ('r', 'p')
  where required.object_kind = 'sensitive_relation_state'

  union all

  select required.object_kind, required.schema_name, required.parent_name,
    required.object_name, required.identity_arguments,
    pg_catalog.jsonb_build_object(
      'definition', pg_catalog.pg_get_functiondef(routine.oid),
      'identity_arguments',
        pg_catalog.pg_get_function_identity_arguments(routine.oid),
      'result', pg_catalog.pg_get_function_result(routine.oid),
      'language', language_row.lanname,
      'security_definer', routine.prosecdef,
      'volatility', routine.provolatile,
      'parallel', routine.proparallel,
      'strict', routine.proisstrict,
      'leakproof', routine.proleakproof,
      'config', pg_catalog.to_jsonb(
        coalesce(routine.proconfig, array[]::text[])
      ),
      'owner', coalesce(
        owner_label.role_label,
        pg_catalog.pg_get_userbyid(routine.proowner)
      ),
      'acl', function_acl.acl
    )
  from required_catalog_objects required
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.nspname = required.schema_name
  join pg_catalog.pg_proc routine
    on routine.pronamespace = namespace_row.oid
   and routine.proname = required.object_name
   and pg_catalog.oidvectortypes(routine.proargtypes) =
     required.identity_arguments
   and routine.prokind = 'f'
  join pg_catalog.pg_language language_row on language_row.oid = routine.prolang
  join catalog_function_acl function_acl on function_acl.object_oid = routine.oid
  left join role_labels owner_label on owner_label.role_oid = routine.proowner
  where required.object_kind = 'function'

  union all

  select required.object_kind, required.schema_name, required.parent_name,
    required.object_name, required.identity_arguments,
    pg_catalog.jsonb_build_object(
      'definition', pg_catalog.pg_get_triggerdef(trigger_row.oid, false),
      'enabled', trigger_row.tgenabled
    )
  from required_catalog_objects required
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.nspname = required.schema_name
  join pg_catalog.pg_class target_row
    on target_row.relnamespace = namespace_row.oid
   and target_row.relname = required.parent_name
  join pg_catalog.pg_trigger trigger_row
    on trigger_row.tgrelid = target_row.oid
   and trigger_row.tgname = required.object_name
   and not trigger_row.tgisinternal
  where required.object_kind = 'trigger'

  union all

  select required.object_kind, required.schema_name, required.parent_name,
    required.object_name, required.identity_arguments,
    pg_catalog.jsonb_build_object(
      'definition', pg_catalog.pg_get_indexdef(index_row.oid),
      'valid', index_state.indisvalid,
      'ready', index_state.indisready,
      'unique', index_state.indisunique,
      'primary', index_state.indisprimary,
      'exclusion', index_state.indisexclusion,
      'owner', coalesce(
        owner_label.role_label,
        pg_catalog.pg_get_userbyid(index_row.relowner)
      )
    )
  from required_catalog_objects required
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.nspname = required.schema_name
  join pg_catalog.pg_class index_row
    on index_row.relnamespace = namespace_row.oid
   and index_row.relname = required.object_name
   and index_row.relkind in ('i', 'I')
  join pg_catalog.pg_index index_state on index_state.indexrelid = index_row.oid
  join pg_catalog.pg_class target_row
    on target_row.oid = index_state.indrelid
   and target_row.relname = required.parent_name
  left join role_labels owner_label on owner_label.role_oid = index_row.relowner
  where required.object_kind = 'index'

  union all

  select required.object_kind, required.schema_name, required.parent_name,
    required.object_name, required.identity_arguments,
    pg_catalog.jsonb_build_object(
      'definition', pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
      'type', constraint_row.contype,
      'validated', constraint_row.convalidated,
      'enforced', constraint_row.conenforced,
      'deferrable', constraint_row.condeferrable,
      'initially_deferred', constraint_row.condeferred
    )
  from required_catalog_objects required
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.nspname = required.schema_name
  join pg_catalog.pg_class target_row
    on target_row.relnamespace = namespace_row.oid
   and target_row.relname = required.parent_name
  join pg_catalog.pg_constraint constraint_row
    on constraint_row.conrelid = target_row.oid
   and constraint_row.conname = pg_catalog.left(required.object_name, 63)
  where required.object_kind = 'constraint'
), duplicate_contract_objects as (
  select object_kind, schema_name, parent_name, object_name, identity_arguments
  from required_catalog_objects
  group by object_kind, schema_name, parent_name, object_name, identity_arguments
  having pg_catalog.count(*) <> 1
), duplicate_truncated_constraint_keys as (
  select schema_name, parent_name,
    pg_catalog.left(object_name, 63) as object_name
  from required_catalog_objects
  where object_kind = 'constraint'
  group by schema_name, parent_name, pg_catalog.left(object_name, 63)
  having pg_catalog.count(*) <> 1
), duplicate_actual_objects as (
  select object_kind, schema_name, parent_name, object_name, identity_arguments
  from actual_catalog_objects
  group by object_kind, schema_name, parent_name, object_name, identity_arguments
  having pg_catalog.count(*) <> 1
), invalid_contract_fingerprints as (
  select object_kind, schema_name, parent_name, object_name, identity_arguments
  from required_catalog_objects
  where expected_fingerprint_sha256 !~ '^[0-9a-f]{64}$'
    or expected_fingerprint_sha256 = pg_catalog.repeat('0', 64)
), missing_or_mismatched_objects as (
  select required.object_kind, required.schema_name, required.parent_name,
    required.object_name, required.identity_arguments
  from required_catalog_objects required
  left join actual_catalog_objects actual
    on actual.object_kind = required.object_kind
   and actual.schema_name = required.schema_name
   and actual.parent_name is not distinct from required.parent_name
   and actual.object_name = required.object_name
   and actual.identity_arguments is not distinct from required.identity_arguments
  where actual.object_name is null
    or actual.actual_catalog is distinct from required.expected_catalog
    or pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(actual.actual_catalog::text, 'UTF8')),
      'hex'
    ) is distinct from required.expected_fingerprint_sha256
), unexpected_protected_routine_kinds as (
  select 'function'::text as object_kind, namespace_row.nspname as schema_name,
    null::text as parent_name, routine.proname as object_name,
    pg_catalog.oidvectortypes(routine.proargtypes) as identity_arguments
  from pg_catalog.pg_proc routine
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.oid = routine.pronamespace
  where namespace_row.nspname = 'public'
    and routine.proname in (
      select required.object_name
      from required_catalog_objects required
      where required.object_kind = 'function'
    )
    and routine.prokind <> 'f'
), unexpected_protected_objects as (
  select 'function'::text as object_kind, namespace_row.nspname as schema_name,
    null::text as parent_name, routine.proname as object_name,
    pg_catalog.oidvectortypes(routine.proargtypes) as identity_arguments
  from pg_catalog.pg_proc routine
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.oid = routine.pronamespace
  where namespace_row.nspname = 'public'
    and (
      routine.proname = 'resolve_financial_reconciliation_issue'
      or routine.proname in (
        select required.object_name
        from required_catalog_objects required
        where required.object_kind = 'function'
      )
    )
    and not exists (
      select 1
      from required_catalog_objects required
      where required.object_kind = 'function'
        and required.schema_name = namespace_row.nspname
        and required.object_name = routine.proname
        and required.identity_arguments =
          pg_catalog.oidvectortypes(routine.proargtypes)
    )
  union all
  select 'trigger', namespace_row.nspname, target_row.relname,
    trigger_row.tgname, null::text
  from pg_catalog.pg_trigger trigger_row
  join pg_catalog.pg_class target_row on target_row.oid = trigger_row.tgrelid
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.oid = target_row.relnamespace
  where namespace_row.nspname = 'public'
    and not trigger_row.tgisinternal
    and trigger_row.tgname in (
      select required.object_name
      from required_catalog_objects required
      where required.object_kind = 'trigger'
    )
    and not exists (
      select 1
      from required_catalog_objects required
      where required.object_kind = 'trigger'
        and required.schema_name = namespace_row.nspname
        and required.parent_name = target_row.relname
        and required.object_name = trigger_row.tgname
    )
), forbidden_retired_types(schema_name, type_name) as (values
  ('public', 'entitlement_grant_source_legacy'),
  ('public', 'financial_reconciliation_status')
), unexpected_forbidden_types as (
  select namespace_row.nspname as schema_name, type_row.typname as type_name
  from forbidden_retired_types forbidden
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.nspname = forbidden.schema_name
  join pg_catalog.pg_type type_row
    on type_row.typnamespace = namespace_row.oid
   and type_row.typname = forbidden.type_name
), forbidden_retired_columns(schema_name, relation_name, column_name) as (values
  ('public', 'disputes', 'reconciliation_status'),
  ('public', 'payments', 'reconciliation_status'),
  ('public', 'refunds', 'reconciliation_status')
), unexpected_forbidden_columns as (
  select namespace_row.nspname as schema_name, relation_row.relname as relation_name,
    attribute_row.attname as column_name
  from forbidden_retired_columns forbidden
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.nspname = forbidden.schema_name
  join pg_catalog.pg_class relation_row
    on relation_row.relnamespace = namespace_row.oid
   and relation_row.relname = forbidden.relation_name
  join pg_catalog.pg_attribute attribute_row
    on attribute_row.attrelid = relation_row.oid
   and attribute_row.attname = forbidden.column_name
   and attribute_row.attnum > 0
   and not attribute_row.attisdropped
), disabled_protected_constraint_triggers(
  schema_name, parent_name, object_name
) as (
  select namespace_row.nspname, target_row.relname, constraint_row.conname
  from pg_catalog.pg_trigger trigger_row
  join pg_catalog.pg_constraint constraint_row
    on constraint_row.oid = trigger_row.tgconstraint
  join pg_catalog.pg_class target_row on target_row.oid = constraint_row.conrelid
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.oid = target_row.relnamespace
  where trigger_row.tgisinternal
    and trigger_row.tgconstraint <> 0
    and trigger_row.tgenabled <> 'O'
    and (
      exists (
        select 1
        from required_catalog_objects required
        where required.object_kind = 'table'
          and required.schema_name = namespace_row.nspname
          and required.object_name = target_row.relname
      )
      or exists (
        select 1
        from required_catalog_objects required
        where required.object_kind = 'constraint'
          and required.schema_name = namespace_row.nspname
          and required.parent_name = target_row.relname
          and pg_catalog.left(required.object_name, 63) = constraint_row.conname
      )
    )
), expected_base_direct_acl(
  object_kind, schema_name, parent_name, object_name, identity_arguments,
  subobject_name, grantee_name, privilege_type, is_grantable
) as (values
  ('database', null, null, 'CURRENT_DATABASE', null, null,
    'pale_orbit_runtime', 'CONNECT', false),
  ('database', null, null, 'CURRENT_DATABASE', null, null,
    'pale_orbit_financial_worker', 'CONNECT', false),
  ('database', null, null, 'CURRENT_DATABASE', null, null,
    'pale_orbit_storage_cleanup', 'CONNECT', false),
  ('schema', null, null, 'public', null, null,
    'pale_orbit_runtime', 'USAGE', false),
  ('schema', null, null, 'public', null, null,
    'pale_orbit_storage_cleanup', 'USAGE', false),
  ('function', 'public', null, 'authorize_commerce_claim_issuance', 'text, text',
    null, 'pale_orbit_runtime', 'EXECUTE', false),
  ('function', 'public', null, 'claim_guest_purchases_after_authorization', 'text, text',
    null, 'pale_orbit_runtime', 'EXECUTE', false),
  ('function', 'public', null, 'outbox_message_exists_by_deduplication_key', 'text',
    null, 'pale_orbit_runtime', 'EXECUTE', false),
  ('function', 'public', null, 'outbox_message_deduplication_metadata',
    'text, text, jsonb', null, 'pale_orbit_runtime', 'EXECUTE', false),
  ('function', 'public', null, 'register_commerce_claim_issuance',
    'text, text, text, uuid, text, timestamp with time zone',
    null, 'pale_orbit_financial_worker', 'EXECUTE', false),
  ('function', 'public', null, 'purge_commerce_claim_issuances', '',
    null, 'pale_orbit_financial_worker', 'EXECUTE', false),
  ('function', 'public', null, 'storage_cleanup_referenced_keys', 'text[]',
    null, 'pale_orbit_storage_cleanup', 'EXECUTE', false),
  ('relation', 'public', null, 'outbox_messages', null,
    null, 'pale_orbit_financial_worker', 'SELECT', false),
  ('relation', 'public', null, 'guest_identities', null,
    null, 'pale_orbit_runtime', 'SELECT', false),
  ('relation', 'public', null, 'entitlement_grants', null,
    null, 'pale_orbit_runtime', 'SELECT', false),
  ('relation', 'public', null, 'entitlement_grants', null,
    null, 'pale_orbit_financial_worker', 'INSERT', false),
  ('relation', 'public', null, 'entitlement_grants', null,
    null, 'pale_orbit_financial_worker', 'UPDATE', false),
  ('relation', 'public', null, 'entitlements', null,
    null, 'pale_orbit_runtime', 'SELECT', false),
  ('relation', 'public', null, 'entitlements', null,
    null, 'pale_orbit_financial_worker', 'INSERT', false),
  ('relation', 'public', null, 'entitlements', null,
    null, 'pale_orbit_financial_worker', 'UPDATE', false),
  ('column', 'public', 'guest_identities', 'guest_identities', null,
    'email', 'pale_orbit_runtime', 'INSERT', false),
  ('column', 'public', 'guest_identities', 'guest_identities', null,
    'updated_at', 'pale_orbit_runtime', 'UPDATE', false),
  ('column', 'public', 'outbox_messages', 'outbox_messages', null,
    'id', 'pale_orbit_runtime', 'SELECT', false),
  ('column', 'public', 'outbox_messages', 'outbox_messages', null,
    'topic', 'pale_orbit_runtime', 'SELECT', false),
  ('column', 'public', 'outbox_messages', 'outbox_messages', null,
    'deduplication_key', 'pale_orbit_runtime', 'SELECT', false),
  ('column', 'public', 'outbox_messages', 'outbox_messages', null,
    'dispatch_job_id', 'pale_orbit_runtime', 'SELECT', false),
  ('column', 'public', 'outbox_messages', 'outbox_messages', null,
    'status', 'pale_orbit_runtime', 'SELECT', false),
  ('column', 'public', 'outbox_messages', 'outbox_messages', null,
    'last_error', 'pale_orbit_runtime', 'SELECT', false),
  ('column', 'public', 'outbox_messages', 'outbox_messages', null,
    'delivered_at', 'pale_orbit_runtime', 'SELECT', false),
  ('column', 'public', 'outbox_messages', 'outbox_messages', null,
    'created_at', 'pale_orbit_runtime', 'SELECT', false),
  ('column', 'public', 'outbox_messages', 'outbox_messages', null,
    'updated_at', 'pale_orbit_runtime', 'SELECT', false),
  ('column', 'public', 'outbox_messages', 'outbox_messages', null,
    'id', 'pale_orbit_runtime', 'INSERT', false),
  ('column', 'public', 'outbox_messages', 'outbox_messages', null,
    'topic', 'pale_orbit_runtime', 'INSERT', false),
  ('column', 'public', 'outbox_messages', 'outbox_messages', null,
    'payload', 'pale_orbit_runtime', 'INSERT', false),
  ('column', 'public', 'outbox_messages', 'outbox_messages', null,
    'deduplication_key', 'pale_orbit_runtime', 'INSERT', false),
  ('column', 'public', 'outbox_messages', 'outbox_messages', null,
    'dispatch_job_id', 'pale_orbit_runtime', 'INSERT', false),
  ('column', 'public', 'outbox_messages', 'outbox_messages', null,
    'status', 'pale_orbit_financial_worker', 'UPDATE', false),
  ('column', 'public', 'outbox_messages', 'outbox_messages', null,
    'last_error', 'pale_orbit_financial_worker', 'UPDATE', false),
  ('column', 'public', 'outbox_messages', 'outbox_messages', null,
    'delivered_at', 'pale_orbit_financial_worker', 'UPDATE', false),
  ('column', 'public', 'outbox_messages', 'outbox_messages', null,
    'updated_at', 'pale_orbit_financial_worker', 'UPDATE', false)
), expected_direct_acl(
  object_kind, schema_name, parent_name, object_name, identity_arguments,
  subobject_name, grantee_name, grantor_name, privilege_type, is_grantable
) as (
  select object_kind, schema_name, parent_name, object_name, identity_arguments,
    subobject_name, grantee_name, 'DATABASE_OWNER', privilege_type, is_grantable
  from expected_base_direct_acl
  union all
  select 'column', 'public', lock_column.relation_name,
    lock_column.relation_name, null, lock_column.column_name,
    lock_column.grantee_name, 'DATABASE_OWNER', lock_column.privilege_type, false
  from expected_lock_only_worker_columns lock_column
), actual_direct_acl(
  object_kind, schema_name, parent_name, object_name, identity_arguments,
  subobject_name, grantee_name, grantor_name, privilege_type, is_grantable
) as (
  select 'database', null::text, null::text, 'CURRENT_DATABASE', null::text,
    null::text, grantee.role_label,
    case
      when acl.grantor = database_row.datdba then 'DATABASE_OWNER'
      else pg_catalog.pg_get_userbyid(acl.grantor)
    end,
    acl.privilege_type, acl.is_grantable
  from pg_catalog.pg_database database_row
  cross join lateral pg_catalog.aclexplode(database_row.datacl) acl
  join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl.grantee
  join role_labels grantee on grantee.role_oid = acl.grantee
  where database_row.datname = pg_catalog.current_database()
    and grantee_role.rolname in (
      'pale_orbit_runtime',
      'pale_orbit_financial_worker',
      'pale_orbit_storage_cleanup'
    )

  union all

  select 'schema', null::text, null::text, namespace_row.nspname, null::text,
    null::text, grantee.role_label, grantor.role_label,
    acl.privilege_type, acl.is_grantable
  from pg_catalog.pg_namespace namespace_row
  cross join lateral pg_catalog.aclexplode(namespace_row.nspacl) acl
  join role_labels grantee on grantee.role_oid = acl.grantee
  join role_labels grantor on grantor.role_oid = acl.grantor
  where namespace_row.nspname = 'public'
    and acl.grantee <> namespace_row.nspowner

  union all

  select 'relation', namespace_row.nspname, null::text, relation_row.relname,
    null::text, null::text, grantee.role_label, grantor.role_label, acl.privilege_type,
    acl.is_grantable
  from pg_catalog.pg_class relation_row
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.oid = relation_row.relnamespace
  cross join lateral pg_catalog.aclexplode(relation_row.relacl) acl
  join role_labels grantee on grantee.role_oid = acl.grantee
  join role_labels grantor on grantor.role_oid = acl.grantor
  where namespace_row.nspname = 'public'
    and (
      relation_row.relname in (
        'commerce_claim_issuances', 'outbox_messages', 'guest_identities',
        'entitlement_grants', 'entitlements'
      )
      or (
        acl.privilege_type = 'UPDATE'
        and relation_row.relname in (
          select lock_column.relation_name
          from expected_lock_only_worker_columns lock_column
        )
      )
    )
    and acl.grantee <> relation_row.relowner

  union all

  select 'column', namespace_row.nspname, relation_row.relname,
    relation_row.relname, null::text, attribute_row.attname,
    grantee.role_label, grantor.role_label, acl.privilege_type, acl.is_grantable
  from pg_catalog.pg_attribute attribute_row
  join pg_catalog.pg_class relation_row on relation_row.oid = attribute_row.attrelid
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.oid = relation_row.relnamespace
  cross join lateral pg_catalog.aclexplode(attribute_row.attacl) acl
  join role_labels grantee on grantee.role_oid = acl.grantee
  join role_labels grantor on grantor.role_oid = acl.grantor
  where namespace_row.nspname = 'public'
    and attribute_row.attnum > 0
    and not attribute_row.attisdropped
    and (
      relation_row.relname in (
        'guest_identities', 'outbox_messages', 'entitlement_grants', 'entitlements'
      )
      or (
        acl.privilege_type = 'UPDATE'
        and relation_row.relname in (
          select lock_column.relation_name
          from expected_lock_only_worker_columns lock_column
        )
      )
    )
    and acl.grantee <> relation_row.relowner

  union all

  select 'function', namespace_row.nspname, null::text, routine.proname,
    pg_catalog.oidvectortypes(routine.proargtypes), null::text,
    grantee.role_label, grantor.role_label, acl.privilege_type, acl.is_grantable
  from pg_catalog.pg_proc routine
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.oid = routine.pronamespace
  cross join lateral pg_catalog.aclexplode(
    coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
  ) acl
  join role_labels grantee on grantee.role_oid = acl.grantee
  join role_labels grantor on grantor.role_oid = acl.grantor
  where namespace_row.nspname = 'public'
    and routine.proname in (
      'authorize_commerce_claim_issuance',
      'claim_guest_purchases_after_authorization',
      'outbox_message_exists_by_deduplication_key',
      'outbox_message_deduplication_metadata',
      'register_commerce_claim_issuance',
      'purge_commerce_claim_issuances',
      'storage_cleanup_referenced_keys'
    )
    and acl.grantee <> routine.proowner
), missing_direct_acl as (
  select * from expected_direct_acl
  except
  select * from actual_direct_acl
), unexpected_direct_acl as (
  select * from actual_direct_acl
  except
  select * from expected_direct_acl
), database_direct_acl_count_mismatch as (
  select 'database-direct-acl-count'::text as failure_key
  where (
    select pg_catalog.count(*)
    from actual_direct_acl
    where object_kind = 'database'
  ) <> 3
), claim_column_differences as (
  select expected.column_name
  from expected_claim_columns expected
  where not exists (
    select 1
    from pg_catalog.pg_attribute attribute_row
    where attribute_row.attrelid = pg_catalog.to_regclass(
        'public.commerce_claim_issuances'
      )
      and attribute_row.attnum > 0
      and not attribute_row.attisdropped
      and attribute_row.attname = expected.column_name
  )
  union all
  select attribute_row.attname
  from pg_catalog.pg_attribute attribute_row
  where attribute_row.attrelid = pg_catalog.to_regclass(
      'public.commerce_claim_issuances'
    )
    and attribute_row.attnum > 0
    and not attribute_row.attisdropped
    and not exists (
      select 1
      from expected_claim_columns expected
      where expected.column_name = attribute_row.attname
    )
), catalog_contract_failures(failure_key) as (
  select 'duplicate-contract:' || object_kind || ':' || object_name
  from duplicate_contract_objects
  union
  select 'duplicate-truncated-constraint:' || parent_name || ':' || object_name
  from duplicate_truncated_constraint_keys
  union
  select 'duplicate-actual:' || object_kind || ':' || object_name
  from duplicate_actual_objects
  union
  select 'invalid-fingerprint:' || object_kind || ':' || object_name
  from invalid_contract_fingerprints
  union
  select object_kind || ':' || coalesce(parent_name || ':', '') ||
    object_name || ':' || coalesce(identity_arguments, '')
  from missing_or_mismatched_objects
  union
  select object_kind || ':' || coalesce(parent_name || ':', '') ||
    object_name || ':' || coalesce(identity_arguments, '')
  from unexpected_protected_objects
  union
  select 'forbidden-type:' || schema_name || ':' || type_name
  from unexpected_forbidden_types
  union
  select 'forbidden-column:' || schema_name || ':' || relation_name || ':' || column_name
  from unexpected_forbidden_columns
  union
  select 'disabled-constraint-trigger:' || parent_name || ':' || object_name
  from disabled_protected_constraint_triggers
  union
  select object_kind || ':' || object_name || ':' ||
    coalesce(identity_arguments, '')
  from unexpected_protected_routine_kinds
  union
  select object_kind || ':' || coalesce(parent_name || ':', '') ||
    object_name || ':' || coalesce(identity_arguments, '')
  from missing_direct_acl
  union
  select object_kind || ':' || coalesce(parent_name || ':', '') ||
    object_name || ':' || coalesce(identity_arguments, '')
  from unexpected_direct_acl
  union
  select failure_key
  from database_direct_acl_count_mismatch
  union
  select 'claim-column:' || column_name
  from claim_column_differences
)
select 'financial_schema_object_manifest', pg_catalog.count(*)::bigint
from catalog_contract_failures;

insert into restore_financial_checks (check_name, violation_count)
with cleanup_group as (
  select role_row.*
  from pg_catalog.pg_roles role_row
  where role_row.rolname = 'pale_orbit_storage_cleanup'
), cleanup_login as (
  select member_role.*, membership.admin_option, membership.inherit_option,
    membership.set_option
  from cleanup_group cleanup
  join pg_catalog.pg_auth_members membership on membership.roleid = cleanup.oid
  join pg_catalog.pg_roles member_role on member_role.oid = membership.member
), protected_cleanup_roles as (
  select cleanup.oid, cleanup.rolname from cleanup_group cleanup
  union all
  select login.oid, 'STORAGE_CLEANUP_LOGIN'::name from cleanup_login login
), storage_cleanup_authority_violations(reason) as (
  select 'missing-or-duplicate-group'
  where (select pg_catalog.count(*) from cleanup_group) <> 1

  union all

  select 'missing-or-duplicate-login'
  where (select pg_catalog.count(*) from cleanup_login) <> 1

  union all

  select 'unsafe-group-attributes'
  from cleanup_group cleanup
  where cleanup.rolcanlogin or cleanup.rolsuper or cleanup.rolcreatedb
    or cleanup.rolcreaterole or not cleanup.rolinherit
    or cleanup.rolreplication or cleanup.rolbypassrls
    or cleanup.rolconnlimit <> -1 or cleanup.rolvaliduntil is not null
    or cleanup.rolconfig is not null

  union all

  select 'unsafe-login-attributes'
  from cleanup_login login
  where not login.rolcanlogin or login.rolsuper or login.rolcreatedb
    or login.rolcreaterole or not login.rolinherit
    or login.rolreplication or login.rolbypassrls
    or login.rolconnlimit <> -1
    or login.rolvaliduntil is distinct from 'infinity'::timestamp with time zone
    or login.rolconfig is not null

  union all

  select 'unsafe-membership'
  where exists (
    select 1
    from pg_catalog.pg_auth_members membership
    where (
      membership.roleid in (select role_row.oid from protected_cleanup_roles role_row)
      or membership.member in (select role_row.oid from protected_cleanup_roles role_row)
    )
      and not (
        membership.roleid = (select cleanup.oid from cleanup_group cleanup)
        and membership.member = (select login.oid from cleanup_login login)
        and not membership.admin_option
        and membership.inherit_option
        and not membership.set_option
      )
  ) or exists (
    select 1
    from cleanup_login login
    where login.admin_option or not login.inherit_option or login.set_option
  )

  union all

  select 'unsafe-role-setting'
  where exists (
    select 1
    from pg_catalog.pg_db_role_setting setting_row
    where setting_row.setrole in (
      select role_row.oid from protected_cleanup_roles role_row
    )
  )

  union all

  select 'unsafe-ownership'
  where exists (
    select 1
    from pg_catalog.pg_shdepend dependency
    where dependency.refclassid =
        'pg_catalog.pg_authid'::pg_catalog.regclass
      and dependency.refobjid in (
        select role_row.oid from protected_cleanup_roles role_row
      )
      and dependency.deptype = 'o'
  )

  union all

  select 'unsafe-database-authority'
  from protected_cleanup_roles role_row
  where pg_catalog.has_database_privilege(
    role_row.oid, pg_catalog.current_database(), 'CREATE'
  )

  union all

  select 'missing-cleanup-connect'
  from protected_cleanup_roles role_row
  where not pg_catalog.has_database_privilege(
    role_row.oid, pg_catalog.current_database(), 'CONNECT'
  )

  union all

  select 'cleanup-login-direct-database-acl'
  from cleanup_login login
  cross join pg_catalog.pg_database database_row
  cross join lateral pg_catalog.aclexplode(database_row.datacl) acl
  where database_row.datname = pg_catalog.current_database()
    and acl.grantee = login.oid

  union all

  select 'unsafe-schema-authority'
  from protected_cleanup_roles role_row
  cross join pg_catalog.pg_namespace namespace_row
  where namespace_row.nspname !~ '^pg_'
    and namespace_row.nspname <> 'information_schema'
    and (
      (
        namespace_row.nspname = 'public'
        and (
          not pg_catalog.has_schema_privilege(
            role_row.oid, namespace_row.oid, 'USAGE'
          )
          or pg_catalog.has_schema_privilege(
            role_row.oid, namespace_row.oid, 'CREATE'
          )
        )
      )
      or (
        namespace_row.nspname <> 'public'
        and (
          pg_catalog.has_schema_privilege(
            role_row.oid, namespace_row.oid, 'USAGE'
          )
          or pg_catalog.has_schema_privilege(
            role_row.oid, namespace_row.oid, 'CREATE'
          )
        )
      )
    )

  union all

  select 'unsafe-relation-authority'
  from protected_cleanup_roles role_row
  cross join pg_catalog.pg_class relation_row
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.oid = relation_row.relnamespace
  cross join pg_catalog.unnest(array[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
    'REFERENCES', 'TRIGGER', 'MAINTAIN'
  ]::text[]) privilege(privilege_name)
  where namespace_row.nspname = 'public'
    and relation_row.relkind in ('r', 'p', 'v', 'm', 'f')
    and pg_catalog.has_table_privilege(
      role_row.oid, relation_row.oid, privilege.privilege_name
    )

  union all

  select 'unsafe-column-authority'
  from protected_cleanup_roles role_row
  cross join pg_catalog.pg_class relation_row
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.oid = relation_row.relnamespace
  cross join pg_catalog.unnest(
    array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']::text[]
  ) privilege(privilege_name)
  where namespace_row.nspname = 'public'
    and relation_row.relkind in ('r', 'p', 'v', 'm', 'f')
    and pg_catalog.has_any_column_privilege(
      role_row.oid, relation_row.oid, privilege.privilege_name
    )

  union all

  select 'unsafe-sequence-authority'
  from protected_cleanup_roles role_row
  cross join pg_catalog.pg_class sequence_row
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.oid = sequence_row.relnamespace
  cross join pg_catalog.unnest(array['SELECT', 'USAGE', 'UPDATE']::text[])
    privilege(privilege_name)
  where namespace_row.nspname = 'public'
    and sequence_row.relkind = 'S'
    and pg_catalog.has_sequence_privilege(
      role_row.oid, sequence_row.oid, privilege.privilege_name
    )

  union all

  select 'unsafe-routine-authority'
  from protected_cleanup_roles role_row
  cross join pg_catalog.pg_proc routine
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.oid = routine.pronamespace
  where namespace_row.nspname !~ '^pg_'
    and namespace_row.nspname <> 'information_schema'
    and routine.oid is distinct from pg_catalog.to_regprocedure(
      'public.storage_cleanup_referenced_keys(text[])'
    )
    and pg_catalog.has_function_privilege(
      role_row.oid, routine.oid, 'EXECUTE'
    )

  union all

  select 'missing-routine-authority'
  from protected_cleanup_roles role_row
  where pg_catalog.to_regprocedure(
      'public.storage_cleanup_referenced_keys(text[])'
    ) is null
    or not pg_catalog.has_function_privilege(
      role_row.oid,
      'public.storage_cleanup_referenced_keys(text[])',
      'EXECUTE'
    )

  union all

  select 'runtime-inherited-cleanup-authority'
  where pg_catalog.has_function_privilege(
      'pale_orbit_runtime',
      'public.storage_cleanup_referenced_keys(text[])',
      'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'pale_orbit_financial_worker',
      'public.storage_cleanup_referenced_keys(text[])',
      'EXECUTE'
    )
)
select 'storage_cleanup_effective_authority',
  pg_catalog.count(distinct reason)::bigint
from storage_cleanup_authority_violations;
-- END financial_schema_object_manifest

insert into restore_financial_checks (check_name, violation_count)
select 'credential_authority_missing_or_mismatched', count(*)::bigint
from account credential
left join credential_authority authority on authority.user_id = credential.user_id
where credential.provider_id = 'credential'
  and (
    credential.password is null
    or authority.user_id is null
    or authority.authorized_password_hash is null
    or authority.authorized_password_hash is distinct from credential.password
  );

insert into restore_financial_checks (check_name, violation_count)
select 'credential_authority_duplicate_account', count(*)::bigint
from (
  select user_id
  from account
  where provider_id = 'credential'
  group by user_id
  having count(*) <> 1
) duplicate_credentials;

insert into restore_financial_checks (check_name, violation_count)
select 'credential_authority_orphan_hash', count(*)::bigint
from credential_authority authority
where authority.authorized_password_hash is not null
  and (
    select count(*)
    from account credential
    where credential.user_id = authority.user_id
      and credential.provider_id = 'credential'
      and credential.password = authority.authorized_password_hash
  ) <> 1;

insert into restore_financial_checks (check_name, violation_count)
select 'credential_authority_invalid_pending_reset', count(*)::bigint
from credential_authority authority
where authority.authorized_password_hash is null
  and (
    authority.reset_epoch_sha256 is null
    or authority.reset_epoch_sha256 !~ '^[0-9a-f]{64}$'
  );

insert into restore_financial_checks (check_name, violation_count)
select 'financial_projection_singleton',
  (abs(count(*) filter (where singleton is true) - 1)
    + count(*) filter (where singleton is distinct from true))::bigint
from financial_projection_versions;

insert into restore_financial_checks (check_name, violation_count)
select 'financial_payout_discovery_singleton',
  (abs(count(*) filter (where singleton is true) - 1)
    + count(*) filter (where singleton is distinct from true))::bigint
from financial_payout_discovery_state;

insert into restore_financial_checks (check_name, violation_count)
with active as (
  select classifier_version, allocation_algorithm_version
  from financial_projection_versions
  where singleton = true
), active_sets as (
  select s.*
  from financial_allocation_sets s
  cross join active a
  where s.classifier_version = a.classifier_version
    and s.algorithm_version = a.allocation_algorithm_version
), tips as (
  select s.balance_transaction_id, s.basis, count(*)::bigint as tip_count
  from active_sets s
  where not exists (
    select 1
    from active_sets successor
    where successor.supersedes_set_id = s.id
  )
  group by s.balance_transaction_id, s.basis
)
select 'financial_projection_tip_ambiguity', count(*)::bigint
from tips
where tip_count > 1;

insert into restore_financial_checks (check_name, violation_count)
select 'financial_classification_decision_ambiguity', count(*)::bigint
from (
  select subject_type, subject_id, classifier_version, source_fingerprint_sha256
  from financial_classification_versions
  group by subject_type, subject_id, classifier_version, source_fingerprint_sha256
  having count(*) > 1
) ambiguous_decisions;

insert into restore_financial_checks (check_name, violation_count)
with allowed_issue_triples(resource_type, safe_code, impact) as (values
  ('payment', 'allocation_fork', 'exception'),
  ('payment', 'allocation_incomplete', 'pending'),
  ('payment', 'allocation_mismatch', 'exception'),
  ('payment', 'classification_fork', 'exception'),
  ('payment', 'correction_rebase_required', 'exception'),
  ('payment', 'currency_mismatch', 'exception'),
  ('payment', 'immutable_mismatch', 'exception'),
  ('payment', 'missing_source', 'pending'),
  ('payment', 'source_linkage_mismatch', 'exception'),
  ('payment', 'unsupported_category', 'exception'),
  ('refund', 'allocation_fork', 'exception'),
  ('refund', 'allocation_incomplete', 'pending'),
  ('refund', 'allocation_mismatch', 'exception'),
  ('refund', 'classification_fork', 'exception'),
  ('refund', 'correction_rebase_required', 'exception'),
  ('refund', 'currency_mismatch', 'exception'),
  ('refund', 'immutable_mismatch', 'exception'),
  ('refund', 'missing_source', 'pending'),
  ('refund', 'source_linkage_mismatch', 'exception'),
  ('refund', 'unsupported_category', 'exception'),
  ('dispute', 'allocation_fork', 'exception'),
  ('dispute', 'allocation_incomplete', 'pending'),
  ('dispute', 'allocation_mismatch', 'exception'),
  ('dispute', 'classification_fork', 'exception'),
  ('dispute', 'correction_rebase_required', 'exception'),
  ('dispute', 'currency_mismatch', 'exception'),
  ('dispute', 'immutable_mismatch', 'exception'),
  ('dispute', 'missing_source', 'pending'),
  ('dispute', 'source_linkage_mismatch', 'exception'),
  ('dispute', 'unsupported_category', 'exception'),
  ('allocation_set', 'allocation_fork', 'exception'),
  ('allocation_set', 'allocation_incomplete', 'pending'),
  ('allocation_set', 'allocation_mismatch', 'exception'),
  ('allocation_set', 'classification_fork', 'exception'),
  ('allocation_set', 'correction_rebase_required', 'exception'),
  ('allocation_set', 'currency_mismatch', 'exception'),
  ('allocation_set', 'immutable_mismatch', 'exception'),
  ('allocation_set', 'missing_source', 'pending'),
  ('allocation_set', 'source_linkage_mismatch', 'exception'),
  ('allocation_set', 'unsupported_category', 'exception'),
  ('payout', 'currency_mismatch', 'exception'),
  ('payout', 'generation_exhausted', 'exception'),
  ('payout', 'immutable_mismatch', 'exception'),
  ('payout', 'payout_membership_conflict', 'exception'),
  ('payout', 'payout_reversal_incomplete', 'exception'),
  ('balance_transaction', 'classification_fork', 'exception'),
  ('balance_transaction', 'immutable_mismatch', 'exception'),
  ('financial_classification', 'unsupported_category', 'exception')
), orphan_counts as (
  select 'fee_detail_balance_transaction' as check_name, count(*)::bigint as violation_count
  from stripe_balance_transaction_fee_details d
  left join stripe_balance_transactions bt on bt.id = d.balance_transaction_id
  where bt.id is null

  union all
  select 'classification_subject', count(*)::bigint
  from financial_classification_versions c
  left join stripe_balance_transactions bt
    on c.subject_type = 'balance_transaction' and bt.id = c.subject_id
  left join stripe_balance_transaction_fee_details fd
    on c.subject_type = 'fee_detail' and fd.id = c.subject_id
  left join stripe_balance_transactions fee_parent_bt
    on fee_parent_bt.id = fd.balance_transaction_id
  left join financial_classification_versions fee_parent_classification
    on fee_parent_classification.subject_type = 'balance_transaction'
   and fee_parent_classification.subject_id = fd.balance_transaction_id
   and fee_parent_classification.classifier_version = c.classifier_version
   and fee_parent_classification.source_fingerprint_sha256 =
     fee_parent_bt.fingerprint_sha256
  where (c.subject_type = 'balance_transaction' and (
       bt.id is null
       or c.source_fingerprint_sha256 is distinct from bt.fingerprint_sha256
     ))
     or (c.subject_type = 'fee_detail' and (
       fd.id is null
       or c.source_fingerprint_sha256 is distinct from fd.fingerprint_sha256
       or fee_parent_classification.id is null
     ))

  union all
  select 'payout_linked_balance_transaction', count(*)::bigint
  from stripe_payouts p
  left join stripe_balance_transactions bt on bt.id = p.balance_transaction_id
  left join stripe_balance_transactions failure_bt on failure_bt.id = p.failure_balance_transaction_id
  where (p.balance_transaction_id is not null and bt.id is null)
     or (p.failure_balance_transaction_id is not null and failure_bt.id is null)

  union all
  select 'payout_import_run_payout', count(*)::bigint
  from payout_import_runs r
  left join stripe_payouts p on p.id = r.payout_id
  where p.id is null

  union all
  select 'payout_import_entry_parent', count(*)::bigint
  from payout_import_run_entries e
  left join payout_import_runs r on r.id = e.run_id
  left join stripe_balance_transactions bt on bt.id = e.balance_transaction_id
  where r.id is null or bt.id is null

  union all
  select 'published_payout_membership_parent', count(*)::bigint
  from stripe_payout_balance_transactions m
  left join stripe_payouts p on p.id = m.payout_id
  left join stripe_balance_transactions bt on bt.id = m.balance_transaction_id
  left join payout_import_runs r
    on r.id = m.published_from_run_id and r.payout_id = m.payout_id
  where p.id is null or bt.id is null or r.id is null

  union all
  select 'allocation_set_parent_or_chain', count(*)::bigint
  from financial_allocation_sets s
  left join stripe_balance_transactions bt on bt.id = s.balance_transaction_id
  left join financial_allocation_sets predecessor on predecessor.id = s.supersedes_set_id
  left join financial_allocation_sets reversal on reversal.id = s.reversal_of_set_id
  left join financial_classification_versions parent_classification
    on parent_classification.subject_type = 'balance_transaction'
    and parent_classification.subject_id = s.balance_transaction_id
    and parent_classification.classifier_version = s.classifier_version
    and parent_classification.source_fingerprint_sha256 = s.source_fingerprint_sha256
  where bt.id is null
     or parent_classification.id is null
     or parent_classification.classification = 'unknown'
     or (s.supersedes_set_id is not null and predecessor.id is null)
     or (s.reversal_of_set_id is not null and reversal.id is null)
     or (s.reversal_of_set_id is not null and (
       reversal.source_kind <> s.source_kind
       or reversal.source_internal_id <> s.source_internal_id
       or reversal.basis <> s.basis
       or reversal.currency <> s.currency
       or reversal.reversal_of_set_id is not null
       or reversal.classifier_version <> s.classifier_version
       or reversal.algorithm_version <> s.algorithm_version
     ))
     or (s.supersedes_set_id is not null and (
       predecessor.balance_transaction_id <> s.balance_transaction_id
       or predecessor.basis <> s.basis
       or predecessor.currency <> s.currency
       or predecessor.expected_effect_minor <> s.expected_effect_minor
       or predecessor.source_fingerprint_sha256 <> s.source_fingerprint_sha256
       or predecessor.classifier_version > s.classifier_version
       or predecessor.algorithm_version > s.algorithm_version
       or not coalesce((
         (
           predecessor.source_kind = s.source_kind
           and predecessor.source_internal_id = s.source_internal_id
           and (
             predecessor.reversal_of_set_id is not distinct from s.reversal_of_set_id
             or (
               predecessor.reversal_of_set_id is not null
               and s.reversal_of_set_id is not null
               and reversal.supersedes_set_id = predecessor.reversal_of_set_id
             )
           )
         )
         or (
           predecessor.source_kind = 'adjustment'
           and predecessor.source_internal_id = s.balance_transaction_id
           and predecessor.scope = 'account'
           and predecessor.reversal_of_set_id is null
           and s.source_kind in ('payment', 'refund', 'dispute')
           and parent_classification.id is not null
           and (
             (s.reversal_of_set_id is null and (
               (s.source_kind = 'payment'
                 and parent_classification.classification = 'charge'
                 and bt.amount_minor > 0)
               or (s.source_kind = 'refund' and (
                 (parent_classification.classification = 'refund' and bt.amount_minor < 0)
                 or (parent_classification.classification = 'refund_failure'
                   and bt.amount_minor > 0)
               ))
               or (s.source_kind = 'dispute' and (
                 (parent_classification.classification = 'dispute_withdrawal'
                   and bt.amount_minor < 0)
                 or (parent_classification.classification in (
                   'dispute_reinstatement', 'fee_credit'
                 ) and bt.amount_minor > 0)
               ))
             ))
             or (s.reversal_of_set_id is not null
               and s.basis = 'gross_amount'
               and s.expected_effect_minor > 0
               and bt.amount_minor > 0
               and (
                 (s.source_kind = 'refund'
                   and parent_classification.classification = 'refund_failure')
                 or (s.source_kind = 'dispute'
                   and parent_classification.classification = 'dispute_reinstatement')
               ))
           )
         )
       ), false)
      ))

  union all
  select 'allocation_set_detail_classification', count(*)::bigint
  from financial_allocation_sets s
  where exists (
    select 1
    from stripe_balance_transaction_fee_details allocation_detail
    left join financial_classification_versions allocation_detail_classification
      on allocation_detail_classification.subject_type = 'fee_detail'
     and allocation_detail_classification.subject_id = allocation_detail.id
     and allocation_detail_classification.classifier_version = s.classifier_version
     and allocation_detail_classification.source_fingerprint_sha256 =
       allocation_detail.fingerprint_sha256
    where allocation_detail.balance_transaction_id = s.balance_transaction_id
      and (
        allocation_detail_classification.id is null
        or allocation_detail_classification.classification = 'unknown'
      )
  )

  union all
  select 'allocation_set_semantic_source', count(*)::bigint
  from financial_allocation_sets s
  left join stripe_balance_transactions source_bt on source_bt.id = s.balance_transaction_id
  left join payments payment_source
    on s.source_kind = 'payment' and payment_source.id = s.source_internal_id
  left join refunds refund_source
    on s.source_kind = 'refund' and refund_source.id = s.source_internal_id
  left join disputes dispute_source
    on s.source_kind = 'dispute' and dispute_source.id = s.source_internal_id
  left join financial_classification_versions source_classification
    on source_classification.subject_type = 'balance_transaction'
   and source_classification.subject_id = s.balance_transaction_id
   and source_classification.classifier_version = s.classifier_version
   and source_classification.source_fingerprint_sha256 =
     s.source_fingerprint_sha256
  left join stripe_payouts payout_source
    on s.source_kind = 'payout' and payout_source.id = s.source_internal_id
  left join stripe_balance_transactions adjustment_source
    on s.source_kind = 'adjustment' and adjustment_source.id = s.source_internal_id
  where source_bt.id is null
     or s.source_fingerprint_sha256 is distinct from source_bt.fingerprint_sha256
     or (s.source_kind = 'payment' and (
       payment_source.id is null
       or payment_source.stripe_latest_charge_id is null
       or source_bt.source_family is distinct from 'charge'
       or source_bt.source_id is distinct from payment_source.stripe_latest_charge_id
       or source_classification.classification is distinct from 'charge'
       or (payment_source.currency = source_bt.currency
         and source_bt.amount_minor <> payment_source.amount_minor)
       or not coalesce((
         (payment_source.currency = source_bt.currency
           and source_bt.exchange_rate is null
           and source_bt.exchange_source_currency is null
           and source_bt.exchange_target_currency is null)
         or (payment_source.currency <> source_bt.currency
           and source_bt.exchange_rate is not null
           and source_bt.exchange_source_currency = payment_source.currency
           and source_bt.exchange_target_currency = source_bt.currency)
       ), false)
     ))
     or (s.source_kind = 'refund' and (
       refund_source.id is null
       or source_bt.source_family is distinct from 'refund'
       or source_bt.source_id is distinct from refund_source.stripe_refund_id
       or source_classification.classification not in ('refund', 'refund_failure')
       or (source_classification.classification = 'refund'
         and refund_source.currency = source_bt.currency
         and source_bt.amount_minor <> -refund_source.amount_minor)
       or not coalesce((
         (refund_source.currency = source_bt.currency
           and source_bt.exchange_rate is null
           and source_bt.exchange_source_currency is null
           and source_bt.exchange_target_currency is null)
         or (refund_source.currency <> source_bt.currency
           and source_bt.exchange_rate is not null
           and source_bt.exchange_source_currency = refund_source.currency
           and source_bt.exchange_target_currency = source_bt.currency)
       ), false)
     ))
     or (s.source_kind = 'dispute' and (
       dispute_source.id is null
       or source_bt.source_family is distinct from 'dispute'
       or source_bt.source_id is distinct from dispute_source.stripe_dispute_id
       or not coalesce((
         (source_classification.classification in (
           'dispute_withdrawal', 'dispute_reinstatement'
         ) and (
           (dispute_source.currency = source_bt.currency
             and source_bt.exchange_rate is null
             and source_bt.exchange_source_currency is null
             and source_bt.exchange_target_currency is null)
           or (dispute_source.currency <> source_bt.currency
             and source_bt.exchange_rate is not null
             and source_bt.exchange_source_currency = dispute_source.currency
             and source_bt.exchange_target_currency = source_bt.currency)
          ))
          or (source_classification.classification = 'fee_credit'
            and source_bt.reporting_category = 'fee'
            and source_bt.raw_type in ('stripe_fee', 'stripe_fx_fee')
            and source_bt.amount_minor > 0
            and (
              (source_bt.exchange_rate is null
                and source_bt.exchange_source_currency is null
                and source_bt.exchange_target_currency is null)
              or (dispute_source.currency <> source_bt.currency
                and source_bt.exchange_rate is not null
                and source_bt.exchange_source_currency = dispute_source.currency
                and source_bt.exchange_target_currency = source_bt.currency)
          ))
       ), false)
     ))
     or (s.source_kind = 'payout' and (
       payout_source.id is null
       or source_bt.source_family is distinct from 'payout'
       or source_bt.source_id is distinct from payout_source.provider_id
       or s.scope <> 'account'
     ))
     or (s.source_kind = 'adjustment' and (
       adjustment_source.id is null
       or s.source_internal_id <> s.balance_transaction_id
       or s.scope <> 'account'
     ))

  union all
  select 'financial_item_allocation_parent', count(*)::bigint
  from financial_item_allocations i
  left join financial_allocation_sets s on s.id = i.allocation_set_id
  left join order_items oi on oi.id = i.order_item_id
  left join payments payment_source
    on s.source_kind = 'payment' and payment_source.id = s.source_internal_id
  left join refunds refund_source
    on s.source_kind = 'refund' and refund_source.id = s.source_internal_id
  left join payments refund_payment on refund_payment.id = refund_source.payment_id
  left join disputes dispute_source
    on s.source_kind = 'dispute' and dispute_source.id = s.source_internal_id
  left join payments dispute_payment on dispute_payment.id = dispute_source.payment_id
  where s.id is null or oi.id is null
     or s.scope <> 'title'
     or i.currency <> s.currency
     or (s.source_kind = 'payment' and (
       payment_source.id is null or oi.order_id <> payment_source.order_id
     ))
     or (s.source_kind = 'refund' and (
       refund_source.id is null or refund_payment.id is null
       or oi.order_id <> refund_payment.order_id
     ))
     or (s.source_kind = 'dispute' and (
       dispute_source.id is null or dispute_payment.id is null
       or oi.order_id <> dispute_payment.order_id
     ))
     or s.source_kind in ('payout', 'adjustment')

  union all
  select 'financial_item_allocation_semantic_component', count(*)::bigint
  from financial_item_allocations i
  join financial_allocation_sets s on s.id = i.allocation_set_id
  left join financial_classification_versions component_parent_classification
    on component_parent_classification.subject_type = 'balance_transaction'
   and component_parent_classification.subject_id = s.balance_transaction_id
   and component_parent_classification.classifier_version = s.classifier_version
   and component_parent_classification.source_fingerprint_sha256 =
     s.source_fingerprint_sha256
  where not coalesce((
    s.scope = 'title' and (
      (s.basis = 'gross_amount' and (
        (s.source_kind = 'payment'
          and component_parent_classification.classification = 'charge'
          and s.reversal_of_set_id is null
          and i.component in ('sale_subtotal', 'sale_tax'))
        or (s.source_kind = 'refund'
          and i.component in ('refund_subtotal', 'refund_tax')
          and (
            (component_parent_classification.classification = 'refund'
              and s.reversal_of_set_id is null)
            or (component_parent_classification.classification = 'refund_failure'
              and s.reversal_of_set_id is not null)
          ))
        or (s.source_kind = 'dispute' and (
          (component_parent_classification.classification = 'dispute_withdrawal'
            and s.reversal_of_set_id is null
            and i.component in ('dispute_subtotal', 'dispute_tax'))
          or (component_parent_classification.classification = 'dispute_reinstatement'
            and s.reversal_of_set_id is not null
            and i.component = 'dispute_reinstatement')
          or (component_parent_classification.classification = 'fee_credit'
            and s.reversal_of_set_id is null
            and i.component = 'fee_credit')
        ))
      ))
      or (s.basis = 'fee'
        and s.reversal_of_set_id is null
        and (
          (s.source_kind = 'payment'
            and component_parent_classification.classification = 'charge'
            and i.component in (
              'processing_fee', 'provider_fee_tax', 'fee_credit', 'other'
            ))
          or (s.source_kind = 'refund'
            and component_parent_classification.classification in ('refund', 'refund_failure')
            and i.component in (
              'refund_fee', 'provider_fee_tax', 'fee_credit', 'other'
            ))
          or (s.source_kind = 'dispute'
            and component_parent_classification.classification = 'dispute_withdrawal'
            and i.component in (
              'dispute_fee', 'provider_fee_tax', 'fee_credit', 'other'
            ))
        )
        and exists (
          select 1
          from stripe_balance_transaction_fee_details component_detail
          join financial_classification_versions component_detail_classification
            on component_detail_classification.subject_type = 'fee_detail'
           and component_detail_classification.subject_id = component_detail.id
           and component_detail_classification.classifier_version = s.classifier_version
           and component_detail_classification.source_fingerprint_sha256 =
             component_detail.fingerprint_sha256
           and component_detail_classification.classification::text = i.component::text
          where component_detail.balance_transaction_id = s.balance_transaction_id
        ))
    )
  ), false)

  union all
  select 'financial_fee_detail_semantic_classification', count(*)::bigint
  from financial_allocation_sets fee_set
  join stripe_balance_transaction_fee_details fee_detail
    on fee_detail.balance_transaction_id = fee_set.balance_transaction_id
  left join financial_classification_versions fee_parent_classification
    on fee_parent_classification.subject_type = 'balance_transaction'
   and fee_parent_classification.subject_id = fee_set.balance_transaction_id
   and fee_parent_classification.classifier_version = fee_set.classifier_version
   and fee_parent_classification.source_fingerprint_sha256 =
     fee_set.source_fingerprint_sha256
  left join financial_classification_versions fee_detail_classification
    on fee_detail_classification.subject_type = 'fee_detail'
   and fee_detail_classification.subject_id = fee_detail.id
   and fee_detail_classification.classifier_version = fee_set.classifier_version
   and fee_detail_classification.source_fingerprint_sha256 = fee_detail.fingerprint_sha256
  where fee_set.basis = 'fee'
    and fee_set.reversal_of_set_id is null
    and (
      (fee_set.scope = 'title'
        and fee_set.source_kind in ('payment', 'refund', 'dispute'))
      or (fee_set.scope = 'unresolved'
        and fee_set.source_kind = 'refund')
    )
    and not coalesce((
      (fee_set.source_kind = 'payment'
        and fee_parent_classification.classification = 'charge'
        and fee_detail_classification.classification in (
          'processing_fee', 'provider_fee_tax', 'fee_credit', 'other'
        ))
      or (fee_set.source_kind = 'refund'
        and (
          (fee_set.scope = 'title'
            and fee_parent_classification.classification in ('refund', 'refund_failure'))
          or (fee_set.scope = 'unresolved'
            and fee_parent_classification.classification = 'refund')
        )
        and fee_detail_classification.classification in (
          'refund_fee', 'provider_fee_tax', 'fee_credit', 'other'
        ))
      or (fee_set.source_kind = 'dispute'
        and fee_parent_classification.classification in (
          'dispute_withdrawal', 'dispute_reinstatement'
        )
        and fee_detail_classification.classification in (
          'dispute_fee', 'provider_fee_tax', 'fee_credit', 'other'
        ))
    ), false)

  union all
  select 'financial_fee_component_conservation', count(*)::bigint
  from (
    with eligible_fee_sets as (
      select s.id, s.balance_transaction_id, s.classifier_version
      from financial_allocation_sets s
      join financial_classification_versions parent_classification
        on parent_classification.subject_type = 'balance_transaction'
       and parent_classification.subject_id = s.balance_transaction_id
       and parent_classification.classifier_version = s.classifier_version
       and parent_classification.source_fingerprint_sha256 = s.source_fingerprint_sha256
      where s.basis = 'fee'
        and s.scope = 'title'
        and s.reversal_of_set_id is null
        and (
          (s.source_kind = 'payment' and parent_classification.classification = 'charge')
          or (s.source_kind = 'refund'
            and parent_classification.classification in ('refund', 'refund_failure'))
          or (s.source_kind = 'dispute'
            and parent_classification.classification = 'dispute_withdrawal')
        )
    ), expected_components as (
      select eligible.id as allocation_set_id,
        detail_classification.classification::text as component,
        -sum(detail.amount_minor)::bigint as expected_component_minor
      from eligible_fee_sets eligible
      join stripe_balance_transaction_fee_details detail
        on detail.balance_transaction_id = eligible.balance_transaction_id
      join financial_classification_versions detail_classification
        on detail_classification.subject_type = 'fee_detail'
       and detail_classification.subject_id = detail.id
       and detail_classification.classifier_version = eligible.classifier_version
       and detail_classification.source_fingerprint_sha256 = detail.fingerprint_sha256
      where detail_classification.classification in (
        'processing_fee', 'refund_fee', 'dispute_fee',
        'provider_fee_tax', 'fee_credit', 'other'
      )
      group by eligible.id, detail_classification.classification
    ), actual_components as (
      select eligible.id as allocation_set_id, item.component::text as component,
        sum(item.effect_minor)::bigint as actual_component_minor
      from eligible_fee_sets eligible
      join financial_item_allocations item on item.allocation_set_id = eligible.id
      group by eligible.id, item.component
    ), component_keys as (
      select allocation_set_id, component from expected_components
      union
      select allocation_set_id, component from actual_components
    )
    select key.allocation_set_id, key.component
    from component_keys key
    left join expected_components expected
      on expected.allocation_set_id = key.allocation_set_id
     and expected.component = key.component
    left join actual_components actual
      on actual.allocation_set_id = key.allocation_set_id
     and actual.component = key.component
    where coalesce(actual.actual_component_minor, 0) is distinct from
      coalesce(expected.expected_component_minor, 0)
  ) mismatched_fee_component

  union all
  select 'financial_issue_vocabulary', count(*)::bigint
  from financial_reconciliation_issues i
  where not exists (
    select 1
    from allowed_issue_triples allowed
    where allowed.resource_type = i.resource_type
      and allowed.safe_code = i.safe_code
      and allowed.impact = i.impact::text
  )

  union all
  select 'financial_issue_semantic_resource', count(*)::bigint
  from financial_reconciliation_issues i
  left join payments p on i.resource_type = 'payment' and p.id = i.resource_id
  left join refunds r on i.resource_type = 'refund' and r.id = i.resource_id
  left join disputes d on i.resource_type = 'dispute' and d.id = i.resource_id
  left join stripe_payouts po on i.resource_type = 'payout' and po.id = i.resource_id
  left join payout_import_runs pr
    on i.resource_type = 'payout_import_run' and pr.id = i.resource_id
  left join stripe_balance_transactions bt
    on i.resource_type = 'balance_transaction' and bt.id = i.resource_id
  left join stripe_balance_transaction_fee_details fd
    on i.resource_type = 'fee_detail' and fd.id = i.resource_id
  left join financial_allocation_sets fas
    on i.resource_type = 'allocation_set' and fas.id = i.resource_id
  left join refund_reporting_correction_sets cs
    on i.resource_type = 'correction_set' and cs.id = i.resource_id
  left join financial_classification_versions fc
    on i.resource_type = 'financial_classification' and fc.id = i.resource_id
  left join financial_scan_runs sr
    on i.resource_type = 'financial_scan_run' and sr.id = i.resource_id
  left join "user" resolver on resolver.id = i.resolved_by_admin_id
  where (i.resource_type = 'payment' and p.id is null)
     or (i.resource_type = 'refund' and r.id is null)
     or (i.resource_type = 'dispute' and d.id is null)
     or (i.resource_type = 'payout' and po.id is null)
     or (i.resource_type = 'payout_import_run' and pr.id is null)
     or (i.resource_type = 'balance_transaction' and bt.id is null)
     or (i.resource_type = 'fee_detail' and fd.id is null)
     or (i.resource_type = 'allocation_set' and fas.id is null)
     or (i.resource_type = 'correction_set' and cs.id is null)
     or (i.resource_type = 'financial_classification' and (
       fc.id is null
       or i.safe_code <> 'unsupported_category'
       or fc.classification <> 'unknown'
       or i.impact <> 'exception'
       or i.state <> 'open'
     ))
     or (i.resource_type in ('balance_transaction', 'fee_detail')
       and i.safe_code = 'unsupported_category')
     or (i.resource_type = 'financial_scan_run' and sr.id is null)
     or (i.resolved_by_admin_id is not null and resolver.id is null)

  union all
  select 'financial_unknown_classification_issue', count(*)::bigint
  from financial_classification_versions classification
  left join financial_reconciliation_issues issue
    on issue.resource_type = 'financial_classification'
   and issue.resource_id = classification.id
   and issue.safe_code = 'unsupported_category'
   and issue.state = 'open'
   and issue.impact = 'exception'
  where classification.classification = 'unknown'
    and issue.id is null

  union all
  select 'refund_allocation_component_graph', count(*)::bigint
  from refund_allocation_components c
  left join refund_allocations ra
    on ra.id = c.refund_allocation_id
   and ra.refund_id = c.refund_id
   and ra.order_item_id = c.order_item_id
  where ra.id is null

  union all
  select 'dispute_item_allocation_graph', count(*)::bigint
  from dispute_item_allocations a
  left join disputes d on d.id = a.dispute_id
  left join payments dispute_payment on dispute_payment.id = d.payment_id
  left join financial_allocation_sets s
    on s.id = a.gross_allocation_set_id and s.source_internal_id = a.dispute_id
  left join order_items oi on oi.id = a.order_item_id
  left join dispute_item_allocations reversal on reversal.id = a.reverses_allocation_id
  left join financial_allocation_sets reversed_set
    on reversed_set.id = s.reversal_of_set_id
  where d.id is null or dispute_payment.id is null or s.id is null or oi.id is null
     or s.source_kind <> 'dispute'
     or s.basis <> 'gross_amount'
     or s.scope <> 'title'
     or oi.order_id is distinct from dispute_payment.order_id
     or a.currency is distinct from d.currency
     or a.currency is distinct from dispute_payment.currency
     or a.currency is distinct from oi.currency
     or (s.currency <> a.currency and a.effect = 'withdrawal' and (
       select coalesce(sum(presentment.total_effect_minor), 0)::bigint
       from dispute_item_allocations presentment
       where presentment.gross_allocation_set_id = s.id
     ) <> -d.amount_minor)
     or (s.currency <> a.currency and a.effect = 'reinstatement' and (
       reversed_set.id is null
       or s.expected_effect_minor is distinct from -reversed_set.expected_effect_minor
       or (
         select coalesce(sum(reinstatement_presentment.total_effect_minor), 0)::bigint
         from dispute_item_allocations reinstatement_presentment
         where reinstatement_presentment.gross_allocation_set_id = s.id
       ) is distinct from -(
         select coalesce(sum(withdrawal_presentment.total_effect_minor), 0)::bigint
         from dispute_item_allocations withdrawal_presentment
         where withdrawal_presentment.gross_allocation_set_id = s.reversal_of_set_id
       )
     ))
     or (a.reverses_allocation_id is not null and (
       reversal.id is null
       or reversal.effect <> 'withdrawal'
       or reversal.reverses_allocation_id is not null
       or reversal.dispute_id <> a.dispute_id
       or reversal.order_item_id <> a.order_item_id
       or reversal.currency <> a.currency
       or a.subtotal_effect_minor > -reversal.subtotal_effect_minor
       or a.tax_effect_minor > -reversal.tax_effect_minor
       or s.reversal_of_set_id is distinct from reversal.gross_allocation_set_id
       or (
         select count(*)
         from dispute_item_allocations candidate_reversal
         where candidate_reversal.reverses_allocation_id = a.reverses_allocation_id
       ) <> 1
     ))

  union all
  select 'dispute_presentment_child_cardinality', count(distinct s.id)::bigint
  from financial_allocation_sets s
  join financial_classification_versions classification
    on classification.subject_type = 'balance_transaction'
   and classification.subject_id = s.balance_transaction_id
   and classification.classifier_version = s.classifier_version
   and classification.source_fingerprint_sha256 = s.source_fingerprint_sha256
  where s.source_kind = 'dispute'
    and s.basis = 'gross_amount'
    and classification.classification in (
      'dispute_withdrawal', 'dispute_reinstatement', 'fee_credit'
    )
    and (
      s.scope <> 'title'
      or (classification.classification in ('dispute_withdrawal', 'fee_credit')
        and s.reversal_of_set_id is not null)
      or (classification.classification = 'dispute_reinstatement'
        and s.reversal_of_set_id is null)
      or (classification.classification in (
          'dispute_withdrawal', 'dispute_reinstatement'
        ) and (
        not exists (
          select 1 from dispute_item_allocations presentment
          where presentment.gross_allocation_set_id = s.id
        )
        or exists (
          select 1 from dispute_item_allocations presentment
          where presentment.gross_allocation_set_id = s.id
            and (
              (classification.classification = 'dispute_withdrawal'
                and (
                  presentment.effect <> 'withdrawal'
                  or presentment.reverses_allocation_id is not null
                  or presentment.subtotal_effect_minor > 0
                  or presentment.tax_effect_minor > 0
                  or presentment.total_effect_minor >= 0
                ))
              or (classification.classification = 'dispute_reinstatement'
                and (
                  presentment.effect <> 'reinstatement'
                  or presentment.reverses_allocation_id is null
                  or presentment.subtotal_effect_minor < 0
                  or presentment.tax_effect_minor < 0
                  or presentment.total_effect_minor <= 0
                ))
            )
        )
        or exists (
          select 1
          from (
            select distinct settlement.order_item_id
            from financial_item_allocations settlement
            where settlement.allocation_set_id = s.id
          ) settlement_item
          where not exists (
            select 1 from dispute_item_allocations presentment
            where presentment.gross_allocation_set_id = s.id
              and presentment.order_item_id = settlement_item.order_item_id
          )
        )
        or exists (
          select 1
          from dispute_item_allocations presentment
          where presentment.gross_allocation_set_id = s.id
            and not exists (
              select 1 from financial_item_allocations settlement
              where settlement.allocation_set_id = s.id
                and settlement.order_item_id = presentment.order_item_id
            )
        )
        ))
      or (classification.classification = 'fee_credit' and exists (
        select 1 from dispute_item_allocations presentment
        where presentment.gross_allocation_set_id = s.id
      ))
    )

  union all
  select 'dispute_first_withdrawal_source_principal', count(*)::bigint
  from (
    select allocation_set.id
    from financial_allocation_sets allocation_set
    join disputes dispute on dispute.id = allocation_set.source_internal_id
    join stripe_balance_transactions balance
      on balance.id = allocation_set.balance_transaction_id
     and balance.source_family = 'dispute'
     and balance.source_id = dispute.stripe_dispute_id
     and balance.reporting_category = 'dispute'
    join financial_classification_versions classification
      on classification.subject_type = 'balance_transaction'
     and classification.subject_id = allocation_set.balance_transaction_id
     and classification.classifier_version = allocation_set.classifier_version
     and classification.source_fingerprint_sha256 =
       allocation_set.source_fingerprint_sha256
    left join dispute_item_allocations presentment
      on presentment.gross_allocation_set_id = allocation_set.id
    where allocation_set.source_kind = 'dispute'
      and allocation_set.basis = 'gross_amount'
      and classification.classification = 'dispute_withdrawal'
      and not exists (
        select 1
        from stripe_balance_transactions earlier_balance
        where earlier_balance.source_family = 'dispute'
          and earlier_balance.source_id = dispute.stripe_dispute_id
          and earlier_balance.reporting_category = 'dispute'
          and row(
            earlier_balance.provider_created_at,
            earlier_balance.provider_id collate "C",
            earlier_balance.id
          ) < row(
            balance.provider_created_at,
            balance.provider_id collate "C",
            balance.id
          )
      )
    group by allocation_set.id, dispute.amount_minor
    having coalesce(sum(presentment.total_effect_minor), 0::bigint) <>
      -dispute.amount_minor::bigint
  ) invalid_first_withdrawal

  union all
  select 'refund_allocation_draft_graph', count(*)::bigint
  from refund_allocation_drafts d
  left join refunds r on r.id = d.refund_id
  left join "user" creator on creator.id = d.created_by_admin_id
  left join "user" updater on updater.id = d.updated_by_admin_id
  where r.id is null or creator.id is null or updater.id is null

  union all
  select 'refund_allocation_draft_item_graph', count(*)::bigint
  from refund_allocation_draft_items i
  left join refund_allocation_drafts d on d.id = i.draft_id
  left join order_items oi on oi.id = i.order_item_id
  where d.id is null or oi.id is null

  union all
  select 'refund_reporting_correction_set_graph', count(*)::bigint
  from refund_reporting_correction_sets c
  left join refunds r on r.id = c.refund_id
  left join financial_allocation_sets base on base.id = c.base_allocation_set_id
  left join refund_reporting_correction_sets predecessor
    on predecessor.id = c.predecessor_correction_set_id
   and predecessor.refund_id = c.refund_id
  left join "user" approver on approver.id = c.approved_by_admin_id
  left join "user" creator on creator.id = c.created_by_admin_id
  where r.id is null or base.id is null or approver.id is null
     or (c.predecessor_correction_set_id is not null and predecessor.id is null)
     or (c.created_by_admin_id is not null and creator.id is null)

  union all
  select 'refund_reporting_correction_item_graph', count(*)::bigint
  from refund_reporting_correction_items i
  left join refund_reporting_correction_sets c on c.id = i.correction_set_id
  left join financial_allocation_sets s on s.id = i.source_allocation_set_id
  left join order_items oi on oi.id = i.order_item_id
  where c.id is null or oi.id is null
     or (i.source_allocation_set_id is not null and s.id is null)

  union all
  select 'refund_reporting_correction_item_semantics', count(*)::bigint
  from refund_reporting_correction_items i
  left join refund_reporting_correction_sets correction
    on correction.id = i.correction_set_id
  left join financial_allocation_sets source_set
    on source_set.id = i.source_allocation_set_id
  left join financial_classification_versions source_classification
    on source_classification.subject_type = 'balance_transaction'
   and source_classification.subject_id = source_set.balance_transaction_id
   and source_classification.classifier_version = source_set.classifier_version
   and source_classification.source_fingerprint_sha256 =
     source_set.source_fingerprint_sha256
  where not coalesce((
    (i.domain = 'presentment'
      and i.source_allocation_set_id is null
      and i.component in ('refund_subtotal', 'refund_tax'))
    or (i.domain = 'settlement'
      and correction.id is not null
      and source_set.source_kind = 'refund'
      and source_set.source_internal_id = correction.refund_id
      and source_set.scope = 'title'
      and source_set.reversal_of_set_id is null
      and source_classification.classification = 'refund'
      and (
        (source_set.basis = 'gross_amount'
          and i.component in ('refund_subtotal', 'refund_tax'))
        or (source_set.basis = 'fee' and i.component = 'refund_fee')
      ))
  ), false)

  union all
  select 'refund_reporting_correction_history_semantics', count(*)::bigint
  from (
    select correction.id,
      case when
        exists (
          select 1
          from refund_reporting_correction_items correction_item
          where correction_item.correction_set_id = correction.id
        )
        and correction_refund.status = 'succeeded'
        and correction_refund.currency = correction_payment.currency
        and anchor.id is not null
        and anchor.source_kind = 'refund'
        and anchor.source_internal_id = correction.refund_id
        and anchor.source_fingerprint_sha256 = correction.source_fingerprint_sha256
      then 0 else 1 end::bigint as invalid_context,
      (
        select count(*)
        from refund_reporting_correction_items correction_item
        left join order_items correction_order_item
          on correction_order_item.id = correction_item.order_item_id
        where correction_item.correction_set_id = correction.id
          and (
            correction_order_item.id is null
            or correction_order_item.order_id <> correction_payment.order_id
            or (correction_item.domain = 'presentment' and (
              correction_item.currency <> correction_refund.currency
              or correction_order_item.currency <> correction_item.currency
            ))
          )
      )::bigint as invalid_item_owner,
      (
        select count(*)
        from refund_reporting_correction_items correction_item
        left join financial_allocation_sets item_source
          on item_source.id = correction_item.source_allocation_set_id
        where correction_item.correction_set_id = correction.id
          and correction_item.domain = 'settlement'
          and (
            item_source.id is null
            or item_source.source_kind <> 'refund'
            or item_source.source_internal_id <> correction.refund_id
            or item_source.source_fingerprint_sha256 <>
              correction.source_fingerprint_sha256
            or correction_item.currency <> item_source.currency
          )
      )::bigint as invalid_settlement_source,
      (
        select count(*)
        from refund_reporting_correction_items correction_item
        left join financial_item_allocations base_item
          on base_item.allocation_set_id = correction_item.source_allocation_set_id
         and base_item.order_item_id = correction_item.order_item_id
         and base_item.component = correction_item.component
        where correction_item.correction_set_id = correction.id
          and correction_item.domain = 'settlement'
          and (
            correction_item.approved_absolute_minor::bigint <>
              coalesce(base_item.effect_minor, 0)::bigint +
                correction_item.delta_minor::bigint
            or (base_item.id is not null
              and base_item.currency <> correction_item.currency)
          )
      )::bigint as invalid_settlement_arithmetic,
      (
        select count(*)
        from financial_item_allocations base_item
        where base_item.effect_minor <> 0
          and exists (
            select 1
            from refund_reporting_correction_items source_item
            where source_item.correction_set_id = correction.id
              and source_item.domain = 'settlement'
              and source_item.source_allocation_set_id = base_item.allocation_set_id
          )
          and not exists (
            select 1
            from refund_reporting_correction_items correction_item
            where correction_item.correction_set_id = correction.id
              and correction_item.domain = 'settlement'
              and correction_item.source_allocation_set_id = base_item.allocation_set_id
              and correction_item.order_item_id = base_item.order_item_id
              and correction_item.component = base_item.component
              and correction_item.currency = base_item.currency
          )
      )::bigint as missing_settlement_base,
      (
        select count(*)
        from refund_allocation_components base_component
        cross join lateral (values
          ('refund_subtotal'::financial_component, base_component.subtotal_minor),
          ('refund_tax'::financial_component, base_component.tax_minor)
        ) base_value(component, amount_minor)
        where base_component.refund_id = correction.refund_id
          and base_value.amount_minor <> 0
          and exists (
            select 1
            from refund_reporting_correction_items presentment_item
            where presentment_item.correction_set_id = correction.id
              and presentment_item.domain = 'presentment'
          )
          and not exists (
            select 1
            from refund_reporting_correction_items correction_item
            where correction_item.correction_set_id = correction.id
              and correction_item.domain = 'presentment'
              and correction_item.order_item_id = base_component.order_item_id
              and correction_item.component = base_value.component
              and correction_item.currency = base_component.currency
          )
      )::bigint as missing_presentment_base,
      (
        select count(*)
        from (
          select correction_item.approved_absolute_minor,
            correction_item.delta_minor,
            correction_item.currency,
            base_component.currency as base_currency,
            case correction_item.component
              when 'refund_subtotal' then coalesce(base_component.subtotal_minor, 0)
              when 'refund_tax' then coalesce(base_component.tax_minor, 0)
              else 0
            end::bigint as base_minor,
            case correction_item.component
              when 'refund_subtotal' then correction_order_item.unit_subtotal_minor
              when 'refund_tax' then coalesce(correction_order_item.tax_minor, 0)
              else 0
            end::bigint as capacity_minor
          from refund_reporting_correction_items correction_item
          left join refund_allocation_components base_component
            on base_component.refund_id = correction.refund_id
           and base_component.order_item_id = correction_item.order_item_id
          left join order_items correction_order_item
            on correction_order_item.id = correction_item.order_item_id
          where correction_item.correction_set_id = correction.id
            and correction_item.domain = 'presentment'
        ) presentment
        where presentment.approved_absolute_minor < 0
           or presentment.approved_absolute_minor::bigint <>
             presentment.base_minor + presentment.delta_minor::bigint
           or (presentment.base_currency is not null
             and presentment.base_currency <> presentment.currency)
           or presentment.approved_absolute_minor::bigint > presentment.capacity_minor
      )::bigint as invalid_presentment_arithmetic
    from refund_reporting_correction_sets correction
    left join refunds correction_refund on correction_refund.id = correction.refund_id
    left join payments correction_payment
      on correction_payment.id = correction_refund.payment_id
    left join financial_allocation_sets anchor
      on anchor.id = correction.base_allocation_set_id
  ) correction_history
  where correction_history.invalid_context
      + correction_history.invalid_item_owner
      + correction_history.invalid_settlement_source
      + correction_history.invalid_settlement_arithmetic
      + correction_history.missing_settlement_base
      + correction_history.missing_presentment_base
      + correction_history.invalid_presentment_arithmetic <> 0

  union all
  select 'refund_finalization_effect_graph', count(*)::bigint
  from refund_allocation_finalization_effects e
  left join refund_allocations ra
    on ra.id = e.refund_allocation_id
   and ra.refund_id = e.refund_id
   and ra.order_item_id = e.order_item_id
  left join refund_allocation_drafts d
    on d.id = e.draft_id
   and d.refund_id = e.refund_id
   and d.version = e.draft_version
  left join refund_allocation_draft_items di
    on di.draft_id = e.draft_id and di.order_item_id = e.order_item_id
  left join entitlement_grants g
    on g.id = e.purchase_grant_id and g.order_item_id = e.order_item_id
  where ra.id is null or d.id is null or di.id is null or g.id is null
)
select check_name, violation_count
from orphan_counts
where violation_count <> 0
order by check_name;

insert into restore_financial_checks (check_name, violation_count)
with fee_sums as (
  select bt.id, bt.fee_minor, coalesce(sum(fd.amount_minor), 0)::bigint as detail_minor,
    count(fd.id) filter (where fd.currency <> bt.currency)::bigint as currency_mismatch_count
  from stripe_balance_transactions bt
  left join stripe_balance_transaction_fee_details fd
    on fd.balance_transaction_id = bt.id
  group by bt.id, bt.fee_minor
), allocation_sums as (
  select s.id, s.scope, s.expected_effect_minor, s.currency,
    count(i.id)::bigint as item_count,
    coalesce(sum(i.effect_minor), 0)::bigint as item_minor,
    count(i.id) filter (where i.currency <> s.currency)::bigint as currency_mismatch_count
  from financial_allocation_sets s
  left join financial_item_allocations i on i.allocation_set_id = s.id
  group by s.id, s.scope, s.expected_effect_minor, s.currency
), correction_sums as (
  select correction_set_id, domain, source_allocation_set_id, currency,
    sum(delta_minor)::bigint as delta_minor
  from refund_reporting_correction_items
  group by correction_set_id, domain, source_allocation_set_id, currency
), refund_component_sequence as (
  select c.id as component_id, ra.id as allocation_id,
    ra.amount_minor::bigint as allocation_minor,
    r.id as refund_id, r.status as refund_status,
    r.allocation_status as refund_allocation_status, r.currency as refund_currency,
    r.provider_created_at, r.stripe_refund_id, p.order_id as payment_order_id,
    oi.id as order_item_id, oi.order_id as item_order_id,
    oi.unit_subtotal_minor::bigint as item_subtotal_minor,
    oi.tax_minor::bigint as item_tax_minor, oi.total_minor::bigint as item_total_minor,
    oi.currency as item_currency, c.subtotal_minor::bigint as stored_subtotal_minor,
    c.tax_minor::bigint as stored_tax_minor, c.total_minor::bigint as stored_total_minor,
    c.currency as component_currency,
    coalesce(sum(c.subtotal_minor::bigint) over (
      partition by ra.order_item_id
      order by r.provider_created_at, r.stripe_refund_id collate "C", r.id, ra.id
      rows between unbounded preceding and 1 preceding
    ), 0::bigint) as prior_subtotal_minor,
    coalesce(sum(c.tax_minor::bigint) over (
      partition by ra.order_item_id
      order by r.provider_created_at, r.stripe_refund_id collate "C", r.id, ra.id
      rows between unbounded preceding and 1 preceding
    ), 0::bigint) as prior_tax_minor
  from refund_allocation_components c
  join refund_allocations ra on ra.id = c.refund_allocation_id
  join refunds r on r.id = ra.refund_id
  join payments p on p.id = r.payment_id
  join order_items oi on oi.id = ra.order_item_id
), refund_component_capacity as (
  select *, item_subtotal_minor - prior_subtotal_minor as remaining_subtotal_minor,
    item_tax_minor - prior_tax_minor as remaining_tax_minor
  from refund_component_sequence
), refund_component_ratios as (
  select *, remaining_subtotal_minor + remaining_tax_minor as remaining_total_minor,
    (allocation_minor >= 0 and remaining_subtotal_minor >= 0 and remaining_tax_minor >= 0
      and allocation_minor <= remaining_subtotal_minor + remaining_tax_minor
      and (allocation_minor = 0 or remaining_subtotal_minor + remaining_tax_minor > 0)
    ) as capacity_valid
  from refund_component_capacity
), refund_component_bases as (
  select *,
    case when capacity_valid and allocation_minor = 0 then 0::bigint
      when capacity_valid then div(
        allocation_minor * remaining_subtotal_minor, remaining_total_minor
      )::bigint
    end as base_subtotal_minor,
    case when capacity_valid and allocation_minor = 0 then 0::bigint
      when capacity_valid then div(
        allocation_minor * remaining_tax_minor, remaining_total_minor
      )::bigint
    end as base_tax_minor,
    case when capacity_valid and allocation_minor = 0 then 0::bigint
      when capacity_valid then mod(
        allocation_minor * remaining_subtotal_minor, remaining_total_minor
      )
    end as subtotal_remainder,
    case when capacity_valid and allocation_minor = 0 then 0::bigint
      when capacity_valid then mod(
        allocation_minor * remaining_tax_minor, remaining_total_minor
      )
    end as tax_remainder
  from refund_component_ratios
), refund_component_expected as (
  select *, allocation_minor - base_subtotal_minor - base_tax_minor as leftover_minor,
    base_subtotal_minor + case
      when allocation_minor - base_subtotal_minor - base_tax_minor = 1 and (
        subtotal_remainder > tax_remainder or (
          subtotal_remainder = tax_remainder and
          (order_item_id::text || ':subtotal') collate "C" <
            (order_item_id::text || ':tax') collate "C"
        )
      ) then 1 else 0 end as expected_subtotal_minor,
    base_tax_minor + case
      when allocation_minor - base_subtotal_minor - base_tax_minor = 1 and not (
        subtotal_remainder > tax_remainder or (
          subtotal_remainder = tax_remainder and
          (order_item_id::text || ':subtotal') collate "C" <
            (order_item_id::text || ':tax') collate "C"
        )
      ) then 1 else 0 end as expected_tax_minor
  from refund_component_bases
  where capacity_valid
), combined_active_projection as (
  select classifier_version, allocation_algorithm_version
  from financial_projection_versions
  where singleton = true
), combined_capacity_seeds as (
  select p.id as payment_id, oi.id as order_item_id, oi.currency as presentment_currency,
    oi.unit_subtotal_minor::bigint as original_subtotal_minor,
    oi.tax_minor::bigint as original_tax_minor
  from payments p
  join order_items oi on oi.order_id = p.order_id
), combined_refund_events as (
  select r.payment_id, c.order_item_id, c.currency as presentment_currency,
    r.provider_created_at, r.stripe_refund_id as provider_id,
    r.id as source_internal_id, ra.id as local_event_id,
    -c.subtotal_minor::bigint as subtotal_delta_minor,
    -c.tax_minor::bigint as tax_delta_minor
  from refund_allocation_components c
  join refund_allocations ra
    on ra.id = c.refund_allocation_id
   and ra.refund_id = c.refund_id
   and ra.order_item_id = c.order_item_id
  join refunds r on r.id = c.refund_id
  where r.status = 'succeeded'
    and r.allocation_status in ('finalized', 'exception')
), combined_current_dispute_events as (
  select d.payment_id, a.order_item_id, a.currency as presentment_currency,
    bt.provider_created_at, bt.provider_id, d.id as source_internal_id,
    a.id as local_event_id, a.effect, a.reverses_allocation_id,
    a.subtotal_effect_minor::bigint as subtotal_delta_minor,
    a.tax_effect_minor::bigint as tax_delta_minor,
    a.total_effect_minor::bigint as total_delta_minor,
    s.id as allocation_set_id, s.reversal_of_set_id, s.scope,
    d.currency as dispute_currency, p.currency as payment_currency,
    p.order_id as payment_order_id, oi.order_id as item_order_id,
    oi.currency as item_currency,
    oi.unit_subtotal_minor::bigint as item_subtotal_minor,
    oi.tax_minor::bigint as item_tax_minor, oi.total_minor::bigint as item_total_minor
  from combined_active_projection active
  join financial_allocation_sets s
    on s.classifier_version = active.classifier_version
   and s.algorithm_version = active.allocation_algorithm_version
   and s.source_kind = 'dispute'
   and s.basis = 'gross_amount'
  join stripe_balance_transactions bt on bt.id = s.balance_transaction_id
  join disputes d on d.id = s.source_internal_id
  join dispute_item_allocations a
    on a.gross_allocation_set_id = s.id
   and a.dispute_id = d.id
  left join payments p on p.id = d.payment_id
  left join order_items oi on oi.id = a.order_item_id
  where not exists (
    select 1
    from financial_allocation_sets successor
    where successor.supersedes_set_id = s.id
      and successor.classifier_version = s.classifier_version
      and successor.algorithm_version = s.algorithm_version
  )
), combined_dispute_events as (
  select *, count(*) filter (where effect = 'reinstatement') over (
    partition by reverses_allocation_id
  )::bigint as current_reversal_count
  from combined_current_dispute_events
), combined_events as (
  select payment_id, order_item_id, presentment_currency, provider_created_at,
    provider_id, source_internal_id, local_event_id,
    subtotal_delta_minor, tax_delta_minor
  from combined_refund_events
  union all
  select payment_id, order_item_id, presentment_currency, provider_created_at,
    provider_id, source_internal_id, local_event_id,
    subtotal_delta_minor, tax_delta_minor
  from combined_dispute_events
), combined_duplicate_chronology as (
  select payment_id, order_item_id, presentment_currency, provider_created_at,
    provider_id, source_internal_id, local_event_id
  from combined_events
  group by payment_id, order_item_id, presentment_currency, provider_created_at,
    provider_id, source_internal_id, local_event_id
  having count(*) > 1
), combined_ordered_events as (
  select event.*, seed.original_subtotal_minor, seed.original_tax_minor,
    seed.original_subtotal_minor + sum(event.subtotal_delta_minor) over (
      partition by event.payment_id, event.order_item_id, event.presentment_currency
      order by event.provider_created_at, event.provider_id collate "C",
        event.source_internal_id, event.local_event_id
      rows between unbounded preceding and current row
    ) as remaining_subtotal_minor,
    seed.original_tax_minor + sum(event.tax_delta_minor) over (
      partition by event.payment_id, event.order_item_id, event.presentment_currency
      order by event.provider_created_at, event.provider_id collate "C",
        event.source_internal_id, event.local_event_id
      rows between unbounded preceding and current row
    ) as remaining_tax_minor
  from combined_events event
  join combined_capacity_seeds seed
    on seed.payment_id = event.payment_id
   and seed.order_item_id = event.order_item_id
   and seed.presentment_currency = event.presentment_currency
), combined_refund_dispute_violations as (
  select 1 as violation
  from combined_dispute_events event
  where event.scope <> 'title'
     or event.payment_order_id is distinct from event.item_order_id
     or event.presentment_currency is distinct from event.item_currency
     or event.presentment_currency is distinct from event.dispute_currency
     or event.presentment_currency is distinct from event.payment_currency
     or event.item_tax_minor is null or event.item_total_minor is null
     or event.item_total_minor <> event.item_subtotal_minor + event.item_tax_minor
     or event.total_delta_minor <> event.subtotal_delta_minor + event.tax_delta_minor
     or (event.effect = 'withdrawal' and (
       event.reverses_allocation_id is not null
       or event.reversal_of_set_id is not null
       or event.subtotal_delta_minor > 0 or event.tax_delta_minor > 0
       or event.total_delta_minor >= 0
     ))
     or (event.effect = 'reinstatement' and (
       event.reverses_allocation_id is null
       or event.reversal_of_set_id is null
       or event.subtotal_delta_minor < 0 or event.tax_delta_minor < 0
       or event.total_delta_minor <= 0
     ))

  union all
  select 1
  from combined_dispute_events reinstatement
  left join combined_dispute_events withdrawal
    on withdrawal.local_event_id = reinstatement.reverses_allocation_id
  where reinstatement.effect = 'reinstatement'
    and (
      withdrawal.local_event_id is null
      or withdrawal.effect <> 'withdrawal'
      or withdrawal.reverses_allocation_id is not null
      or withdrawal.reversal_of_set_id is not null
      or reinstatement.source_internal_id <> withdrawal.source_internal_id
      or reinstatement.reversal_of_set_id <> withdrawal.allocation_set_id
      or reinstatement.order_item_id <> withdrawal.order_item_id
      or reinstatement.presentment_currency <> withdrawal.presentment_currency
      or reinstatement.subtotal_delta_minor > -withdrawal.subtotal_delta_minor
      or reinstatement.tax_delta_minor > -withdrawal.tax_delta_minor
      or reinstatement.current_reversal_count <> 1
      or row(
        withdrawal.provider_created_at,
        withdrawal.provider_id collate "C",
        withdrawal.source_internal_id,
        withdrawal.local_event_id
      ) >= row(
        reinstatement.provider_created_at,
        reinstatement.provider_id collate "C",
        reinstatement.source_internal_id,
        reinstatement.local_event_id
      )
    )

  union all
  select 1
  from combined_duplicate_chronology

  union all
  select 1
  from combined_ordered_events
  where remaining_subtotal_minor not between 0 and original_subtotal_minor
     or remaining_tax_minor not between 0 and original_tax_minor
), conservation_counts as (
  select 'balance_transaction_net_equation' as check_name, count(*)::bigint as violation_count
  from stripe_balance_transactions
  where net_minor <> amount_minor - fee_minor

  union all
  select 'fee_detail_sum', count(*)::bigint
  from fee_sums
  where detail_minor <> fee_minor or currency_mismatch_count <> 0

  union all
  select 'allocation_set_provider_target', count(*)::bigint
  from financial_allocation_sets s
  join stripe_balance_transactions bt on bt.id = s.balance_transaction_id
  where s.currency <> bt.currency
     or s.expected_effect_minor <>
       case s.basis when 'gross_amount' then bt.amount_minor else -bt.fee_minor end

  union all
  select 'allocation_item_conservation', count(*)::bigint
  from allocation_sums
  where currency_mismatch_count <> 0
     or (scope = 'title' and item_minor <> expected_effect_minor)
     or (scope = 'title' and expected_effect_minor <> 0 and item_count = 0)
     or (scope in ('account', 'unresolved') and item_count <> 0)

  union all
  select 'refund_component_equation', count(*)::bigint
  from refund_allocation_components c
  join refund_allocations ra on ra.id = c.refund_allocation_id
  join refunds r on r.id = c.refund_id
  where c.total_minor <> c.subtotal_minor + c.tax_minor
     or c.total_minor <> ra.amount_minor
     or c.currency <> r.currency

  union all
  select 'refund_component_chronology_capacity', count(*)::bigint
  from refund_component_ratios
  where refund_status <> 'succeeded'
     or refund_allocation_status not in ('finalized', 'exception')
     or item_tax_minor is null or item_total_minor is null
     or item_total_minor <> item_subtotal_minor + item_tax_minor
     or payment_order_id <> item_order_id
     or refund_currency <> item_currency
     or refund_currency <> component_currency
     or stored_subtotal_minor > remaining_subtotal_minor
     or stored_tax_minor > remaining_tax_minor
     or capacity_valid is distinct from true

  union all
  select 'refund_component_deterministic_split', count(*)::bigint
  from refund_component_expected
  where leftover_minor not between 0 and 1
     or stored_subtotal_minor is distinct from expected_subtotal_minor
     or stored_tax_minor is distinct from expected_tax_minor

  union all
  select 'combined_refund_dispute_chronology_capacity', count(*)::bigint
  from combined_refund_dispute_violations

  union all
  select 'finalized_refund_allocation_shape', count(*)::bigint
  from refunds r
  left join lateral (
    select count(ra.id)::bigint as allocation_count,
      count(c.id)::bigint as component_count,
      coalesce(sum(ra.amount_minor), 0)::bigint as allocation_minor,
      coalesce(sum(c.total_minor), 0)::bigint as component_minor
    from refund_allocations ra
    left join refund_allocation_components c on c.refund_allocation_id = ra.id
    where ra.refund_id = r.id
  ) totals on true
  where r.allocation_status = 'finalized'
    and (totals.allocation_count = 0
      or totals.component_count <> totals.allocation_count
      or totals.allocation_minor <> r.amount_minor
      or totals.component_minor <> r.amount_minor)

  union all
  select 'dispute_component_equation', count(*)::bigint
  from dispute_item_allocations
  where total_effect_minor <> subtotal_effect_minor + tax_effect_minor

  union all
  select 'reporting_correction_zero_sum', count(*)::bigint
  from correction_sums
  where delta_minor <> 0
)
select check_name, violation_count
from conservation_counts
order by check_name;

insert into restore_financial_checks (check_name, violation_count)
with entry_counts as (
  select r.id, r.payout_id, r.generation, r.state, r.candidate_count,
    count(e.id)::bigint as entry_count
  from payout_import_runs r
  left join payout_import_run_entries e on e.run_id = r.id
  group by r.id, r.payout_id, r.generation, r.state, r.candidate_count
), payout_membership_counts as (
  select r.id, count(m.id)::bigint as membership_count
  from payout_import_runs r
  left join stripe_payout_balance_transactions m on m.payout_id = r.payout_id
  group by r.id
), payout_checks as (
  select 'run_candidate_count' as check_name, count(*)::bigint as violation_count
  from entry_counts
  where entry_count <> candidate_count

  union all
  select 'run_generation_order', count(*)::bigint
  from payout_import_runs r
  join stripe_payouts p on p.id = r.payout_id
  where r.generation > p.financial_generation
     or (r.state in ('collecting', 'publishable') and r.generation <> p.financial_generation)
     or (r.state = 'published' and r.generation = p.financial_generation and not exists (
       select 1
       from payout_import_runs history
       where history.payout_id = r.payout_id
         and history.id <> r.id
         and history.state = 'published'
         and history.generation::bigint + 1 < r.generation::bigint
     ))

  union all
  select 'published_membership_count', count(*)::bigint
  from entry_counts e
  join payout_membership_counts m on m.id = e.id
  where e.state = 'published' and e.entry_count <> m.membership_count

  union all
  select 'membership_nonpublished_run', count(*)::bigint
  from stripe_payout_balance_transactions m
  join payout_import_runs r on r.id = m.published_from_run_id
  where r.state <> 'published'

  union all
  select 'payout_membership_currency', count(*)::bigint
  from stripe_payout_balance_transactions membership
  join stripe_payouts payout on payout.id = membership.payout_id
  join stripe_balance_transactions balance
    on balance.id = membership.balance_transaction_id
  where balance.currency is distinct from payout.currency

  union all
  select 'published_entry_missing_membership', count(*)::bigint
  from payout_import_run_entries e
  join payout_import_runs r on r.id = e.run_id and r.state = 'published'
  where not exists (
    select 1
    from stripe_payout_balance_transactions m
    where m.payout_id = r.payout_id
      and m.balance_transaction_id = e.balance_transaction_id
  )

  union all
  select 'published_membership_missing_entry', count(*)::bigint
  from stripe_payout_balance_transactions m
  join payout_import_runs r on r.id = m.published_from_run_id
  where r.state = 'published'
    and not exists (
      select 1
      from payout_import_run_entries e
      where e.run_id = m.published_from_run_id
        and e.balance_transaction_id = m.balance_transaction_id
    )

  union all
  select 'unsupported_authoritative_membership', count(*)::bigint
  from stripe_payout_balance_transactions m
  join stripe_payouts p on p.id = m.payout_id
  where not p.automatic or p.method <> 'standard' or p.reconciliation_status <> 'completed'

  union all
  select 'missing_current_generation_impact_job', count(*)::bigint
  from stripe_payouts p
  where p.financial_generation > 0
    and not exists (
      select 1
      from jobs j
      where j.deduplication_key =
        'financial:payout-impact:' || p.id::text || ':' || p.financial_generation::text
        and j.type = 'commerce.financial-scan'
        and j.max_attempts = 8
        and j.payload = jsonb_build_object(
          'kind', 'payout_impact',
          'payoutId', p.id,
          'payoutGeneration', p.financial_generation
        )
    )
)
select check_name, violation_count
from payout_checks
order by check_name;

insert into restore_financial_checks (check_name, violation_count)
with pending_replay_children as (
  select version.pending_scan_run_id, version.pending_classifier_version,
    version.pending_allocation_algorithm_version, version.pending_replay_id,
    replay.id as replay_run_id, replay.enqueued_count,
    children.child_count, children.invalid_count, children.incomplete_count,
    children.exhausted_count, children.permanent_count
  from financial_projection_versions version
  left join financial_scan_runs replay on replay.id = version.pending_scan_run_id
  left join lateral (
    select count(*)::bigint as child_count,
      count(*) filter (where
        child.payload ->> 'classifierVersion' is distinct from
          version.pending_classifier_version::text
        or child.payload ->> 'allocationAlgorithmVersion' is distinct from
          version.pending_allocation_algorithm_version::text
        or child.payload ->> 'replayId' is distinct from version.pending_replay_id
      )::bigint as invalid_count,
      count(*) filter (where child.status <> 'succeeded')::bigint as incomplete_count,
      count(*) filter (where
        child.status = 'failed' and child.attempts >= child.max_attempts
      )::bigint as exhausted_count,
      count(*) filter (where
        child.status = 'failed' and child.attempts < child.max_attempts
      )::bigint as permanent_count
    from jobs child
    where child.type = 'commerce.financial-classification'
      and child.payload ->> 'scanRunId' = version.pending_scan_run_id::text
  ) children on true
  where version.singleton = true and version.pending_scan_run_id is not null
), scan_checks as (
  select 'scan_root_job_missing' as check_name, count(*)::bigint as violation_count
  from financial_scan_runs r
  where not exists (
    select 1 from jobs j
    where j.deduplication_key = r.root_key
      and j.type = 'commerce.financial-scan'
      and j.max_attempts = 8
      and case r.kind
        when 'initial_backfill' then r.root_key = 'commerce.financial-scan:initial:v1'
          and j.payload = '{"kind":"initial","version":1}'::jsonb
        when 'hourly' then r.root_key ~ '^commerce\.financial-scan:[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):00:00\.000Z$'
          and substring(r.root_key from char_length('commerce.financial-scan:') + 1 for 4) <> '0000'
          and substring(r.root_key from char_length('commerce.financial-scan:') + 1 for 10) =
            to_char(
              make_date(
                substring(r.root_key from char_length('commerce.financial-scan:') + 1 for 4)::int,
                substring(r.root_key from char_length('commerce.financial-scan:') + 6 for 2)::int,
                1
              ) + (
                substring(r.root_key from char_length('commerce.financial-scan:') + 9 for 2)::int - 1
              ),
              'YYYY-MM-DD'
            )
          and j.payload = jsonb_build_object(
          'kind', 'hourly', 'scanGenerationHour',
          substring(r.root_key from char_length('commerce.financial-scan:') + 1)
        )
        when 'payout_impact' then r.root_key =
          'financial:payout-impact:' || (j.payload ->> 'payoutId') || ':' ||
          (j.payload ->> 'payoutGeneration')
          and (j.payload ->> 'payoutId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          and jsonb_typeof(j.payload -> 'payoutGeneration') = 'number'
          and (j.payload ->> 'payoutGeneration') ~ '^[1-9][0-9]{0,9}$'
          and case when (j.payload ->> 'payoutGeneration') ~ '^[1-9][0-9]{0,9}$'
            then (j.payload ->> 'payoutGeneration')::bigint <= 2147483647 else false end
          and j.payload = jsonb_build_object(
          'kind', 'payout_impact',
          'payoutId', j.payload ->> 'payoutId',
          'payoutGeneration', j.payload -> 'payoutGeneration'
        )
        when 'classification_replay' then r.root_key =
          'commerce.financial-classification:scan:' || r.classifier_version::text || ':' ||
          r.allocation_algorithm_version::text
          and j.payload = jsonb_build_object(
          'kind', 'composite_replay',
          'classifierVersion', r.classifier_version,
          'allocationAlgorithmVersion', r.allocation_algorithm_version,
          'replayId', r.replay_id
        )
        else false
      end
  )

  union all
  select 'running_scan_resume_job_missing', count(*)::bigint
  from financial_scan_runs r
  where r.state = 'running'
    and not exists (
      select 1
      from jobs j
      where j.deduplication_key = (case
        when r.cursor_digest_sha256 is null then r.root_key
        else 'commerce.financial-scan:' || r.id::text || ':' || r.phase || ':' || r.cursor_digest_sha256
      end)
        and j.type = 'commerce.financial-scan'
        and j.max_attempts = 8
        and j.status in ('pending', 'running', 'failed')
        and (j.status <> 'pending' or j.attempts < j.max_attempts)
        and case
          when r.cursor_digest_sha256 is not null then j.payload = jsonb_build_object(
            'kind', 'continuation',
            'scanRunId', r.id,
            'phase', r.phase,
            'cursorDigestSha256', r.cursor_digest_sha256,
            'limit', 100
          )
          when r.kind = 'initial_backfill' then
            r.root_key = 'commerce.financial-scan:initial:v1'
            and j.payload = '{"kind":"initial","version":1}'::jsonb
          when r.kind = 'hourly' then
            r.root_key ~ '^commerce\.financial-scan:[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):00:00\.000Z$'
            and substring(r.root_key from char_length('commerce.financial-scan:') + 1 for 4) <> '0000'
            and substring(r.root_key from char_length('commerce.financial-scan:') + 1 for 10) =
              to_char(
                make_date(
                  substring(r.root_key from char_length('commerce.financial-scan:') + 1 for 4)::int,
                  substring(r.root_key from char_length('commerce.financial-scan:') + 6 for 2)::int,
                  1
                ) + (
                  substring(r.root_key from char_length('commerce.financial-scan:') + 9 for 2)::int - 1
                ),
                'YYYY-MM-DD'
              )
            and j.payload = jsonb_build_object(
            'kind', 'hourly', 'scanGenerationHour',
            substring(r.root_key from char_length('commerce.financial-scan:') + 1)
          )
          when r.kind = 'payout_impact' then
            r.root_key = 'financial:payout-impact:' || (j.payload ->> 'payoutId') || ':' ||
              (j.payload ->> 'payoutGeneration')
            and (j.payload ->> 'payoutId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            and jsonb_typeof(j.payload -> 'payoutGeneration') = 'number'
            and (j.payload ->> 'payoutGeneration') ~ '^[1-9][0-9]{0,9}$'
            and case when (j.payload ->> 'payoutGeneration') ~ '^[1-9][0-9]{0,9}$'
              then (j.payload ->> 'payoutGeneration')::bigint <= 2147483647 else false end
            and j.payload = jsonb_build_object(
            'kind', 'payout_impact',
            'payoutId', j.payload ->> 'payoutId',
            'payoutGeneration', j.payload -> 'payoutGeneration'
          )
          when r.kind = 'classification_replay' then
            r.root_key = 'commerce.financial-classification:scan:' ||
              r.classifier_version::text || ':' || r.allocation_algorithm_version::text
            and j.payload = jsonb_build_object(
            'kind', 'composite_replay',
            'classifierVersion', r.classifier_version,
            'allocationAlgorithmVersion', r.allocation_algorithm_version,
            'replayId', r.replay_id
          )
          else false
        end
    )

  union all
  select 'running_scan_cursor_integrity', count(*)::bigint
  from financial_scan_runs r
  where r.state = 'running'
    and r.checkpoint is not null and r.cursor_digest_sha256 is null
    or (r.state = 'running' and r.cursor_digest_sha256 is not null and
      r.cursor_digest_sha256 <> encode(sha256(
        convert_to(r.phase, 'UTF8') || decode('00', 'hex') ||
        convert_to(coalesce(r.checkpoint, ''), 'UTF8')
      ), 'hex'))

  union all
  select 'scan_phase_checkpoint_shape', count(*)::bigint
  from financial_scan_runs r
  where r.phase not in (
      'source_page', 'payout_discovery_page', 'incomplete_payout_run_page',
      'payout_impact_page', 'classification_replay_page',
      'classification_replay_finalize'
    )
    or (r.kind = 'classification_replay' and
      r.phase not in ('classification_replay_page', 'classification_replay_finalize'))
    or (r.kind = 'classification_replay' and r.state = 'completed' and
      r.phase <> 'classification_replay_finalize')
    or (r.kind = 'payout_impact' and r.phase <> 'payout_impact_page')
    or (r.kind in ('initial_backfill', 'hourly') and
      r.phase not in ('source_page', 'payout_discovery_page', 'incomplete_payout_run_page'))
    or (r.phase in ('source_page', 'payout_impact_page') and r.checkpoint is not null and
      r.checkpoint !~ '^(payment|refund|dispute):[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    or (r.phase = 'incomplete_payout_run_page' and r.checkpoint is not null and
      r.checkpoint !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    or (r.phase = 'classification_replay_page' and r.checkpoint is not null and
      r.checkpoint !~ '^(balance_transaction|fee_detail):[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    or (r.phase = 'classification_replay_finalize' and r.checkpoint is not null)

  union all
  select 'scan_lifecycle_shape', count(*)::bigint
  from financial_scan_runs
  where ((state in ('completed', 'exception')) <> (completed_at is not null))
     or processed_count < 0 or enqueued_count < 0 or page_count < 0

  union all
  select 'completed_scan_retains_cursor', count(*)::bigint
  from financial_scan_runs
  where state = 'completed'
    and (checkpoint is not null or cursor_digest_sha256 is not null
      or safe_outcome is distinct from 'completed')

  union all
  select 'replay_identity_mismatch', count(*)::bigint
  from financial_scan_runs
  where (classifier_version is null) <> (allocation_algorithm_version is null)
     or (classifier_version is null) <> (replay_id is null)
     or ((kind = 'classification_replay') <> (classifier_version is not null))
     or (replay_id is not null and replay_id <>
       'c' || classifier_version::text || '-a' || allocation_algorithm_version::text)

  union all
  select 'pending_replay_authority_mismatch', count(*)::bigint
  from financial_projection_versions version
  left join financial_scan_runs replay on replay.id = version.pending_scan_run_id
  where version.singleton = true and version.pending_scan_run_id is not null
    and (replay.id is null
      or replay.kind is distinct from 'classification_replay'
      or replay.state is distinct from 'running'
      or replay.phase not in ('classification_replay_page', 'classification_replay_finalize')
      or replay.classifier_version is distinct from version.pending_classifier_version
      or replay.allocation_algorithm_version is distinct from
        version.pending_allocation_algorithm_version
      or replay.replay_id is distinct from version.pending_replay_id)

  union all
  select 'pending_replay_child_count_mismatch', count(*)::bigint
  from pending_replay_children pending
  where pending.replay_run_id is not null
    and pending.child_count < pending.enqueued_count

  union all
  select 'pending_replay_child_version_mismatch',
    coalesce(sum(invalid_count), 0)::bigint
  from pending_replay_children

  union all
  select 'pending_replay_child_incomplete',
    coalesce(sum(incomplete_count), 0)::bigint
  from pending_replay_children

  union all
  select 'pending_replay_child_retry_exhausted',
    coalesce(sum(exhausted_count), 0)::bigint
  from pending_replay_children

  union all
  select 'pending_replay_child_permanent',
    coalesce(sum(permanent_count), 0)::bigint
  from pending_replay_children

  union all
  select 'failed_running_scan_retry_exhausted', count(*)::bigint
  from financial_scan_runs r
  join jobs j on j.deduplication_key = (case
    when r.cursor_digest_sha256 is null then r.root_key
    else 'commerce.financial-scan:' || r.id::text || ':' || r.phase || ':' || r.cursor_digest_sha256
  end)
  where r.state = 'running' and j.status = 'failed' and j.attempts >= j.max_attempts

  union all
  select 'failed_running_scan_permanent', count(*)::bigint
  from financial_scan_runs r
  join jobs j on j.deduplication_key = (case
    when r.cursor_digest_sha256 is null then r.root_key
    else 'commerce.financial-scan:' || r.id::text || ':' || r.phase || ':' || r.cursor_digest_sha256
  end)
  where r.state = 'running' and j.status = 'failed' and j.attempts < j.max_attempts
)
select check_name, violation_count
from scan_checks
order by check_name;

insert into restore_financial_checks (check_name, violation_count)
select 'classification_replay_completed_phase', count(*)::bigint
from financial_scan_runs replay
where replay.kind = 'classification_replay'
  and replay.state = 'completed'
  and (
    replay.phase is distinct from 'classification_replay_finalize'
    or replay.checkpoint is not null
    or replay.cursor_digest_sha256 is not null
  );

-- BEGIN financial_title_allocation_determinism
insert into restore_financial_checks (check_name, violation_count)
with deterministic_sets as (
  select allocation_set.id, allocation_set.source_kind,
    allocation_set.source_internal_id, allocation_set.balance_transaction_id,
    allocation_set.reversal_of_set_id, allocation_set.currency,
    balance.amount_minor::bigint as amount_minor,
    classification.classification
  from financial_allocation_sets allocation_set
  join stripe_balance_transactions balance
    on balance.id = allocation_set.balance_transaction_id
  join financial_classification_versions classification
    on classification.subject_type = 'balance_transaction'
   and classification.subject_id = balance.id
   and classification.classifier_version = allocation_set.classifier_version
   and classification.source_fingerprint_sha256 = allocation_set.source_fingerprint_sha256
  where allocation_set.algorithm_version = 1
    and allocation_set.basis = 'gross_amount'
    and allocation_set.scope = 'title'
    and (
      (allocation_set.source_kind = 'payment'
        and classification.classification = 'charge'
        and allocation_set.reversal_of_set_id is null)
      or (allocation_set.source_kind = 'refund'
        and classification.classification = 'refund'
        and allocation_set.reversal_of_set_id is null)
      or (allocation_set.source_kind = 'refund'
        and classification.classification = 'refund_failure'
        and allocation_set.reversal_of_set_id is not null)
    )
), allocation_weights as (
  select deterministic.id as allocation_set_id,
    item.id as order_item_id,
    component.component::financial_component as component,
    component.weight_minor::bigint as weight_minor,
    item.id::text || ':' || component.tie_suffix as deterministic_tie_key
  from deterministic_sets deterministic
  join payments payment
    on deterministic.source_kind = 'payment'
   and payment.id = deterministic.source_internal_id
  join order_items item on item.order_id = payment.order_id
  cross join lateral (values
    ('sale_subtotal', item.unit_subtotal_minor, 'subtotal'),
    ('sale_tax', coalesce(item.tax_minor, 0), 'tax')
  ) component(component, weight_minor, tie_suffix)
  where deterministic.classification = 'charge'
    and deterministic.amount_minor <> 0
    and component.weight_minor > 0

  union all
  select deterministic.id, component.order_item_id,
    component_kind.component::financial_component,
    component_kind.weight_minor::bigint,
    component.order_item_id::text || ':' || component_kind.tie_suffix
  from deterministic_sets deterministic
  join refund_allocation_components component
    on deterministic.source_kind = 'refund'
   and component.refund_id = deterministic.source_internal_id
  cross join lateral (values
    ('refund_subtotal', component.subtotal_minor, 'subtotal'),
    ('refund_tax', component.tax_minor, 'tax')
  ) component_kind(component, weight_minor, tie_suffix)
  where deterministic.classification = 'refund'
    and component_kind.weight_minor > 0

  union all
  select deterministic.id, original_item.order_item_id,
    original_item.component,
    abs(original_item.effect_minor::bigint),
    original_item.tie_break_key
  from deterministic_sets deterministic
  join financial_allocation_sets original
    on original.id = deterministic.reversal_of_set_id
  join financial_item_allocations original_item
    on original_item.allocation_set_id = original.id
  where deterministic.classification = 'refund_failure'
    and original_item.effect_minor <> 0
), weighted_allocations as (
  select deterministic.id as allocation_set_id, deterministic.currency,
    deterministic.amount_minor, weight.order_item_id, weight.component,
    weight.deterministic_tie_key, weight.weight_minor,
    sum(weight.weight_minor) over (
      partition by deterministic.id
    )::bigint as total_weight_minor
  from deterministic_sets deterministic
  join allocation_weights weight on weight.allocation_set_id = deterministic.id
), allocation_floors as (
  select weighted.*,
    abs(weighted.amount_minor) * weighted.weight_minor / weighted.total_weight_minor
      as floor_minor,
    abs(weighted.amount_minor) * weighted.weight_minor % weighted.total_weight_minor
      as remainder_minor
  from weighted_allocations weighted
), ranked_allocations as (
  select allocation_floor.*,
    abs(allocation_floor.amount_minor) - sum(allocation_floor.floor_minor) over (
      partition by allocation_floor.allocation_set_id
    ) as undistributed_minor,
    row_number() over (
      partition by allocation_floor.allocation_set_id
      order by allocation_floor.remainder_minor desc,
        allocation_floor.deterministic_tie_key collate "C"
    )::bigint as remainder_rank
  from allocation_floors allocation_floor
), expected_allocations as (
  select ranked.allocation_set_id, ranked.order_item_id, ranked.component,
    ranked.currency,
    (case when ranked.amount_minor < 0 then -1 else 1 end *
      (ranked.floor_minor + case
        when ranked.remainder_rank <= ranked.undistributed_minor then 1 else 0
      end))::bigint as effect_minor
  from ranked_allocations ranked
), mismatched_sets as (
  select expected.allocation_set_id
  from expected_allocations expected
  left join financial_item_allocations actual
    on actual.allocation_set_id = expected.allocation_set_id
   and actual.order_item_id = expected.order_item_id
   and actual.component = expected.component
  where actual.id is null
     or actual.currency is distinct from expected.currency
     or actual.effect_minor::bigint is distinct from expected.effect_minor

  union
  select actual.allocation_set_id
  from deterministic_sets deterministic
  join financial_item_allocations actual
    on actual.allocation_set_id = deterministic.id
  left join expected_allocations expected
    on expected.allocation_set_id = actual.allocation_set_id
   and expected.order_item_id = actual.order_item_id
   and expected.component = actual.component
  where expected.allocation_set_id is null

  union
  select deterministic.id
  from deterministic_sets deterministic
  where deterministic.amount_minor <> 0
    and not exists (
      select 1
      from allocation_weights weight
      where weight.allocation_set_id = deterministic.id
    )
)
select 'financial_title_allocation_determinism', count(*)::bigint
from mismatched_sets;
-- END financial_title_allocation_determinism

-- BEGIN source_evidence_projection_parity
insert into restore_financial_checks (check_name, violation_count)
with financial_sources(
  source_type, source_id, provider_source_id, source_amount_minor,
  source_currency, evidence_status
) as (
  select 'payment'::text, payment.id, payment.stripe_latest_charge_id,
    payment.amount_minor, payment.currency,
    payment.financial_evidence_status
  from payments payment
  union all
  select 'refund', refund.id, refund.stripe_refund_id,
    refund.amount_minor, refund.currency,
    refund.financial_evidence_status
  from refunds refund
  union all
  select 'dispute', dispute.id, dispute.stripe_dispute_id,
    dispute.amount_minor, dispute.currency,
    dispute.financial_evidence_status
  from disputes dispute
), current_head_state as materialized (
  select head.balance_transaction_id,
    count(*) = 2
      and count(distinct head.basis) = 2
      and bool_and(head.is_complete) as exact_and_complete
  from current_financial_projection_heads head
  group by head.balance_transaction_id
), source_balance_state as materialized (
  select balance.source_family::text as source_family, balance.source_id,
    count(*)::bigint as balance_count,
    bool_and(coalesce(head.exact_and_complete, false)) as all_heads_exact_and_complete
  from stripe_balance_transactions balance
  left join current_head_state head on head.balance_transaction_id = balance.id
  where balance.source_id is not null
  group by balance.source_family, balance.source_id
), direct_source_principal_state as materialized (
  select source.source_type, source.source_id,
    count(balance.id) > 0 as has_canonical_source_principal,
    coalesce(bool_and(
      balance.currency <> source.source_currency
      or balance.amount_minor = case source.source_type
        when 'payment' then source.source_amount_minor
        else -source.source_amount_minor
      end
    ) filter (where balance.id is not null), false)
      as all_source_principals_consistent
  from financial_sources source
  left join stripe_balance_transactions balance
    on source.source_type in ('payment', 'refund')
   and balance.source_family = case source.source_type
     when 'payment' then 'charge'::stripe_balance_transaction_source_family
     else 'refund'::stripe_balance_transaction_source_family
   end
   and balance.source_id = source.provider_source_id
   and balance.reporting_category = case source.source_type
     when 'payment' then 'charge'
     else 'refund'
   end
  where source.source_type in ('payment', 'refund')
  group by source.source_type, source.source_id
), first_dispute_withdrawal_balance as materialized (
  select distinct on (source.source_id)
    source.source_id, source.source_amount_minor,
    balance.id as balance_transaction_id
  from financial_sources source
  join stripe_balance_transactions balance
    on balance.source_family = 'dispute'
   and balance.source_id = source.provider_source_id
   and balance.reporting_category = 'dispute'
  where source.source_type = 'dispute'
  order by source.source_id, balance.provider_created_at,
    balance.provider_id collate "C", balance.id
), current_dispute_principal_state as materialized (
  select first_withdrawal.source_id,
    head.base_set_id is not null and count(presentment.id) > 0
      as has_canonical_source_principal,
    head.base_set_id is not null
      and coalesce(sum(presentment.total_effect_minor), 0::bigint) =
        -first_withdrawal.source_amount_minor::bigint
      as all_source_principals_consistent
  from first_dispute_withdrawal_balance first_withdrawal
  left join current_financial_projection_heads head
    on head.balance_transaction_id = first_withdrawal.balance_transaction_id
   and head.basis = 'gross_amount'
  left join dispute_item_allocations presentment
    on presentment.gross_allocation_set_id = head.base_set_id
  group by first_withdrawal.source_id, first_withdrawal.source_amount_minor,
    head.base_set_id
), open_issue_state as materialized (
  select issue.resource_type::text as resource_type, issue.resource_id,
    bool_or(issue.impact = 'exception') as has_open_exception_issue,
    bool_or(issue.impact <> 'informational') as has_open_blocking_issue
  from financial_reconciliation_issues issue
  where issue.state = 'open'
  group by issue.resource_type, issue.resource_id
), source_state as (
  select source.*,
    coalesce(balance.balance_count, 0) > 0 as has_relevant_balance,
    coalesce(balance.all_heads_exact_and_complete, false)
      as all_heads_exact_and_complete,
    case source.source_type
      when 'dispute' then coalesce(
        dispute_principal.has_canonical_source_principal, false
      )
      else coalesce(direct_principal.has_canonical_source_principal, false)
    end as has_canonical_source_principal,
    case source.source_type
      when 'dispute' then coalesce(
        dispute_principal.all_source_principals_consistent, false
      )
      else coalesce(direct_principal.all_source_principals_consistent, false)
    end as all_source_principals_consistent,
    coalesce(issue.has_open_exception_issue, false) as has_open_exception_issue,
    coalesce(issue.has_open_blocking_issue, false) as has_open_blocking_issue
  from financial_sources source
  left join source_balance_state balance
    on balance.source_family = case source.source_type
      when 'payment' then 'charge'
      else source.source_type
    end
   and balance.source_id = source.provider_source_id
  left join direct_source_principal_state direct_principal
    on direct_principal.source_type = source.source_type
   and direct_principal.source_id = source.source_id
  left join current_dispute_principal_state dispute_principal
    on dispute_principal.source_id = source.source_id
   and source.source_type = 'dispute'
  left join open_issue_state issue
    on issue.resource_type = source.source_type
   and issue.resource_id = source.source_id
)
select 'source_evidence_projection_parity', count(*)::bigint
from source_state source
where (source.evidence_status = 'fee_reconciled' and (
    not source.has_relevant_balance
    or not source.all_heads_exact_and_complete
    or not source.has_canonical_source_principal
    or not source.all_source_principals_consistent
    or source.has_open_blocking_issue
  ))
  or (source.evidence_status = 'exception' and not source.has_open_exception_issue)
  or (source.evidence_status = 'pending' and source.has_open_exception_issue);
-- END source_evidence_projection_parity

-- BEGIN resolved_issue_audit_provenance
insert into restore_financial_checks (check_name, violation_count)
with legacy_commerce_worker_issue_pairs(resource_type, safe_code) as (values
  ('dispute', 'allocation_fork'),
  ('dispute', 'allocation_incomplete'),
  ('dispute', 'allocation_mismatch'),
  ('dispute', 'classification_fork'),
  ('dispute', 'correction_rebase_required'),
  ('dispute', 'currency_mismatch'),
  ('dispute', 'immutable_mismatch'),
  ('dispute', 'missing_source'),
  ('dispute', 'source_linkage_mismatch'),
  ('dispute', 'unsupported_category'),
  ('allocation_set', 'allocation_mismatch'),
  ('allocation_set', 'classification_fork'),
  ('allocation_set', 'correction_rebase_required'),
  ('allocation_set', 'currency_mismatch'),
  ('allocation_set', 'immutable_mismatch'),
  ('allocation_set', 'source_linkage_mismatch'),
  ('allocation_set', 'unsupported_category')
), canonical_resolved_audits as (
  select audit.id as audit_id, issue.id as issue_id
  from audit_events audit
  join financial_reconciliation_issues issue
    on issue.id::text = audit.resource_id
   and issue.state = 'resolved'
  where audit.action = 'financial.issue.resolved'
    and audit.outcome = 'succeeded'
    and audit.resource_type = 'financial_issue'
    and audit.correlation_id is not null
    and char_length(audit.correlation_id) between 1 and 100
    and (
      (issue.resolved_by_admin_id is null
        and audit.actor_type = 'system'
        and (
          audit.actor_id = 'financial-worker'
          or (audit.actor_id = 'commerce-worker' and exists (
            select 1
            from legacy_commerce_worker_issue_pairs legacy
            where legacy.resource_type = issue.resource_type
              and legacy.safe_code = issue.safe_code
          ))
        ))
      or (issue.resolved_by_admin_id is not null
        and audit.actor_type = 'user'
        and audit.actor_id = issue.resolved_by_admin_id::text)
    )
    and audit.after = jsonb_build_object(
      'resourceType', issue.resource_type,
      'resourceId', issue.resource_id,
      'safeCode', issue.safe_code,
      'impact', issue.impact,
      'state', issue.state,
      'occurrenceCount', issue.occurrence_count
    )
), invalid_resolved_issues as (
  select issue.id
  from financial_reconciliation_issues issue
  left join canonical_resolved_audits audit on audit.issue_id = issue.id
  where issue.state = 'resolved'
  group by issue.id
  having count(audit.audit_id) <> 1
), invalid_resolved_audits as (
  select audit.id
  from audit_events audit
  left join canonical_resolved_audits canonical on canonical.audit_id = audit.id
  where audit.action = 'financial.issue.resolved'
    and canonical.audit_id is null
), provenance_violations as (
  select id from invalid_resolved_issues
  union all
  select id from invalid_resolved_audits
)
select 'resolved_issue_audit_provenance', count(*)::bigint
from provenance_violations;
-- END resolved_issue_audit_provenance

do $restore_verifier$
declare
  total_violations bigint;
  failed_checks text;
begin
  select coalesce(sum(violation_count), 0),
    string_agg(check_name || '=' || violation_count::text, ', ' order by check_name collate "C")
  into total_violations, failed_checks
  from restore_financial_checks
  where violation_count <> 0
    and check_name not in (
      'failed_running_scan_retry_exhausted',
      'failed_running_scan_permanent',
      'pending_replay_child_incomplete',
      'pending_replay_child_retry_exhausted',
      'pending_replay_child_permanent'
    );

  if total_violations <> 0 then
    raise exception 'restore financial/credential invariant violation: %', failed_checks;
  end if;
end
$restore_verifier$;

select check_name, violation_count
from restore_financial_checks
where check_name in (
  'failed_running_scan_permanent',
  'failed_running_scan_retry_exhausted',
  'pending_replay_child_incomplete',
  'pending_replay_child_permanent',
  'pending_replay_child_retry_exhausted'
)
order by check_name collate "C";

rollback;
