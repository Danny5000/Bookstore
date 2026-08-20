LOCK TABLE "public"."guest_identities", "public"."orders", "public"."order_items",
  "public"."payments", "public"."refunds", "public"."refund_allocations",
  "public"."disputes", "public"."entitlement_grants", "public"."entitlements",
  "public"."user", "public"."account", "public"."credential_authority",
  "public"."audit_events", "public"."outbox_messages"
IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."guest_identities" identity
    JOIN "public"."user" claimant ON claimant.id = identity.claimed_by_user_id
    WHERE identity.claimed_by_user_id IS NOT NULL
      AND (
        NOT claimant.email_verified OR
        claimant.email <> pg_catalog.lower(pg_catalog.btrim(claimant.email)) OR
        claimant.email <> identity.email
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'existing guest identity claim is not backed by the verified normalized user email';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."entitlement_grants" grant_row
    JOIN "public"."order_items" item ON item.id = grant_row.order_item_id
    JOIN "public"."orders" purchase_order ON purchase_order.id = item.order_id
    LEFT JOIN "public"."guest_identities" identity
      ON identity.id = purchase_order.guest_identity_id
    WHERE grant_row.source = 'purchase'
      AND (
        (purchase_order.initiating_user_id IS NOT NULL AND (
          purchase_order.guest_identity_id IS NOT NULL OR
          grant_row.user_id IS DISTINCT FROM purchase_order.initiating_user_id
        )) OR
        (purchase_order.initiating_user_id IS NULL AND (
          identity.id IS NULL OR
          identity.claimed_by_user_id IS DISTINCT FROM grant_row.user_id OR
          identity.email IS DISTINCT FROM purchase_order.purchase_email
        ))
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'existing purchase grant assignment is not backed by its claimed guest identity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."orders" purchase_order
    JOIN "public"."order_items" item ON item.order_id = purchase_order.id
    LEFT JOIN "public"."entitlement_grants" purchase_grant
      ON purchase_grant.order_item_id = item.id AND purchase_grant.source = 'purchase'
    WHERE purchase_order.status = 'paid'
      AND purchase_order.initiating_user_id IS NULL
      AND purchase_order.guest_identity_id IS NOT NULL
      AND purchase_grant.id IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'existing paid guest item is missing its purchase grant';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."entitlements" entitlement
    WHERE (entitlement.revoked_at IS NULL) IS DISTINCT FROM EXISTS (
      SELECT 1
      FROM "public"."entitlement_grants" grant_row
      WHERE grant_row.user_id = entitlement.user_id
        AND grant_row.title_id = entitlement.title_id
        AND grant_row.state = 'active'
    )
  ) OR EXISTS (
    SELECT 1
    FROM "public"."entitlement_grants" grant_row
    WHERE grant_row.state = 'active'
      AND NOT EXISTS (
        SELECT 1
        FROM "public"."entitlements" entitlement
        WHERE entitlement.user_id = grant_row.user_id
          AND entitlement.title_id = grant_row.title_id
          AND entitlement.revoked_at IS NULL
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'existing effective entitlement projection is inconsistent with grant state';
  END IF;
END;
$$;--> statement-breakpoint
CREATE TABLE "public"."commerce_claim_issuances" (
  "claim_proof_sha256" text PRIMARY KEY NOT NULL,
  "auth_token_sha256" text,
  "normalized_email" text,
  "anchor_order_id" uuid,
  "kind" text NOT NULL,
  "state" text DEFAULT 'issued' NOT NULL,
  "authorized_user_id" uuid,
  "issued_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "authorized_at" timestamp with time zone,
  "consumed_at" timestamp with time zone,
  "result_disposition" text,
  "result_changed" boolean,
  "result_order_count" integer,
  "result_title_count" integer,
  CONSTRAINT "commerce_claim_issuances_claim_proof_sha256_valid"
    CHECK (claim_proof_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "commerce_claim_issuances_auth_token_sha256_valid"
    CHECK (auth_token_sha256 IS NULL OR auth_token_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "commerce_claim_issuances_email_normalized"
    CHECK (normalized_email IS NULL OR normalized_email = pg_catalog.lower(pg_catalog.btrim(normalized_email))),
  CONSTRAINT "commerce_claim_issuances_kind_valid"
    CHECK (kind IN ('password-reset', 'commerce-magic')),
  CONSTRAINT "commerce_claim_issuances_lifecycle_consistent" CHECK (
    (state = 'issued' AND auth_token_sha256 IS NOT NULL AND normalized_email IS NOT NULL
      AND anchor_order_id IS NOT NULL AND authorized_user_id IS NULL
      AND authorized_at IS NULL AND consumed_at IS NULL
      AND result_disposition IS NULL AND result_changed IS NULL
      AND result_order_count IS NULL AND result_title_count IS NULL)
    OR
    (state = 'authorized' AND auth_token_sha256 IS NOT NULL AND normalized_email IS NOT NULL
      AND anchor_order_id IS NOT NULL AND authorized_user_id IS NOT NULL
      AND authorized_at IS NOT NULL AND consumed_at IS NULL
      AND result_disposition IS NULL AND result_changed IS NULL
      AND result_order_count IS NULL AND result_title_count IS NULL)
    OR
    (state = 'consumed' AND auth_token_sha256 IS NULL AND normalized_email IS NULL
      AND anchor_order_id IS NULL AND authorized_user_id IS NULL
      AND authorized_at IS NOT NULL AND consumed_at IS NOT NULL
      AND result_disposition IS NOT NULL AND result_changed IS NOT NULL
      AND result_order_count IS NOT NULL AND result_title_count IS NOT NULL)
  ),
  CONSTRAINT "commerce_claim_issuances_result_valid" CHECK (
    (result_disposition IS NULL AND result_changed IS NULL
      AND result_order_count IS NULL AND result_title_count IS NULL)
    OR
    (result_disposition IN (
        'claimed', 'not_eligible', 'definitive_invalid', 'identity_conflict'
      ) AND result_changed IS NOT NULL
      AND result_order_count IS NOT NULL AND result_order_count >= 0
      AND result_title_count IS NOT NULL AND result_title_count >= 0
      AND (
        (result_disposition = 'claimed'
          AND result_order_count > 0 AND result_title_count > 0)
        OR
        (result_disposition <> 'claimed' AND NOT result_changed
          AND result_order_count = 0 AND result_title_count = 0)
      ))
  ),
  CONSTRAINT "commerce_claim_issuances_timestamp_order" CHECK (
    expires_at > issued_at AND
    (authorized_at IS NULL OR authorized_at >= issued_at) AND
    (consumed_at IS NULL OR consumed_at >= authorized_at)
  ),
  CONSTRAINT "commerce_claim_issuances_anchor_order_id_orders_id_fk"
    FOREIGN KEY (anchor_order_id) REFERENCES "public"."orders"("id")
    ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "commerce_claim_issuances_authorized_user_id_user_id_fk"
    FOREIGN KEY (authorized_user_id) REFERENCES "public"."user"("id")
    ON DELETE restrict ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_claim_issuances_auth_token_sha256_unique"
ON "public"."commerce_claim_issuances" USING btree ("auth_token_sha256")
WHERE "auth_token_sha256" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "commerce_claim_issuances_live_email_idx"
ON "public"."commerce_claim_issuances" USING btree
  ("normalized_email", "state", "claim_proof_sha256")
WHERE "normalized_email" IS NOT NULL AND "state" IN ('issued', 'authorized');--> statement-breakpoint
CREATE INDEX "commerce_claim_issuances_retention_idx"
ON "public"."commerce_claim_issuances" USING btree
  ("state", "expires_at", "consumed_at");--> statement-breakpoint
CREATE FUNCTION "public"."purge_commerce_claim_issuances"()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $$
DECLARE
  deleted_count integer;
  purged_at timestamp with time zone := pg_catalog.clock_timestamp();
BEGIN
  WITH candidates AS (
    SELECT issuance.claim_proof_sha256
    FROM "public"."commerce_claim_issuances" issuance
    WHERE (issuance.state IN ('issued', 'authorized') AND
        issuance.expires_at <= purged_at)
      OR (issuance.state = 'consumed' AND
        issuance.consumed_at <= purged_at - INTERVAL '24 hours')
    ORDER BY issuance.claim_proof_sha256
    FOR UPDATE SKIP LOCKED
    LIMIT 500
  )
  DELETE FROM "public"."commerce_claim_issuances" issuance
  USING candidates
  WHERE issuance.claim_proof_sha256 = candidates.claim_proof_sha256;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "public"."outbox_message_exists_by_deduplication_key"(
  p_deduplication_key text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $$
  SELECT p_deduplication_key IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "public"."outbox_messages" message
    WHERE message.deduplication_key = p_deduplication_key
  );
$$;--> statement-breakpoint
CREATE FUNCTION "public"."outbox_message_deduplication_metadata"(
  p_deduplication_key text,
  p_topic text,
  p_expected_payload jsonb
) RETURNS TABLE (
  id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $$
  SELECT message.id
  FROM "public"."outbox_messages" message
  WHERE p_deduplication_key IS NOT NULL
    AND p_topic IS NOT NULL
    AND p_expected_payload IS NOT NULL
    AND message.deduplication_key = p_deduplication_key
    AND message.topic = p_topic
    AND message.payload = p_expected_payload
  LIMIT 1;
$$;--> statement-breakpoint
CREATE FUNCTION "public"."claim_guest_purchases_after_authorization"(
  p_raw_claim_proof text,
  p_correlation_id text
) RETURNS TABLE (
  claimed boolean,
  changed boolean,
  claimed_order_count integer,
  claimed_title_count integer,
  definitive_invalid boolean,
  conflict_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $$
DECLARE
  claim_digest text;
  candidate "public"."commerce_claim_issuances"%ROWTYPE;
  locked_issuance "public"."commerce_claim_issuances"%ROWTYPE;
  locked_identity "public"."guest_identities"%ROWTYPE;
  locked_user "public"."user"%ROWTYPE;
  locked_authority "public"."credential_authority"%ROWTYPE;
  locked_entitlement "public"."entitlements"%ROWTYPE;
  identity_candidate_id uuid;
  order_ids uuid[] := ARRAY[]::uuid[];
  payment_ids uuid[] := ARRAY[]::uuid[];
  refund_ids uuid[] := ARRAY[]::uuid[];
  item_ids uuid[] := ARRAY[]::uuid[];
  title_ids uuid[] := ARRAY[]::uuid[];
  current_title_id uuid;
  grant_fact record;
  credential_count integer;
  credential_password text;
  has_authority boolean := false;
  has_entitlement boolean;
  has_active_grant boolean;
  has_lost_dispute boolean;
  has_open_dispute boolean;
  eligible boolean := false;
  identity_conflict boolean := false;
  identity_changed boolean := false;
  any_changed boolean := false;
  allocated_minor bigint;
  next_state text;
  next_reason text;
  order_count integer := 0;
  title_count integer := 0;
  claim_at timestamp with time zone := pg_catalog.clock_timestamp();
BEGIN
  IF p_raw_claim_proof IS NULL OR p_raw_claim_proof !~ '^[A-Za-z0-9_-]{43}$' OR
    p_correlation_id IS NULL OR
    p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' THEN
    RETURN QUERY SELECT false, false, 0, 0, true, NULL::text;
    RETURN;
  END IF;
  claim_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_raw_claim_proof, 'UTF8')), 'hex'
  );
  SELECT * INTO candidate
  FROM "public"."commerce_claim_issuances" issuance
  WHERE issuance.claim_proof_sha256 = claim_digest;
  IF FOUND AND candidate.state = 'consumed' THEN
    IF candidate.result_disposition = 'claimed' THEN
      RETURN QUERY SELECT true, candidate.result_changed,
        candidate.result_order_count, candidate.result_title_count, false, NULL::text;
    ELSIF candidate.result_disposition = 'not_eligible' THEN
      RETURN QUERY SELECT false, false, 0, 0, false, NULL::text;
    ELSIF candidate.result_disposition = 'definitive_invalid' THEN
      RETURN QUERY SELECT false, false, 0, 0, true, NULL::text;
    ELSIF candidate.result_disposition = 'identity_conflict' THEN
      RETURN QUERY SELECT false, false, 0, 0, false,
        'IDENTITY_ALREADY_CLAIMED'::text;
    ELSE
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'consumed commerce claim has no replayable result';
    END IF;
    RETURN;
  END IF;
  IF NOT FOUND OR candidate.state <> 'authorized' OR
    candidate.normalized_email IS NULL OR candidate.anchor_order_id IS NULL OR
    candidate.authorized_user_id IS NULL THEN
    RETURN QUERY SELECT false, false, 0, 0, true, NULL::text;
    RETURN;
  END IF;

  SELECT identity.id INTO identity_candidate_id
  FROM "public"."guest_identities" identity
  WHERE identity.email = candidate.normalized_email;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'authorized commerce claim lost its guest identity';
  END IF;
  SELECT * INTO locked_identity
  FROM "public"."guest_identities" identity
  WHERE identity.id = identity_candidate_id
  FOR UPDATE;
  IF NOT FOUND OR locked_identity.email <> candidate.normalized_email THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'authorized commerce claim guest identity changed';
  END IF;
  identity_conflict := locked_identity.claimed_by_user_id IS NOT NULL AND
    locked_identity.claimed_by_user_id <> candidate.authorized_user_id;

  PERFORM 1
  FROM "public"."orders" purchase_order
  WHERE purchase_order.guest_identity_id = locked_identity.id
    AND purchase_order.status = 'paid'
    AND purchase_order.initiating_user_id IS NULL
  ORDER BY purchase_order.id
  FOR UPDATE;
  SELECT coalesce(pg_catalog.array_agg(purchase_order.id ORDER BY purchase_order.id),
      ARRAY[]::uuid[]), pg_catalog.count(*)::integer
  INTO order_ids, order_count
  FROM "public"."orders" purchase_order
  WHERE purchase_order.guest_identity_id = locked_identity.id
    AND purchase_order.status = 'paid'
    AND purchase_order.initiating_user_id IS NULL;
  eligible := order_count > 0 AND candidate.anchor_order_id = ANY(order_ids);

  IF eligible AND NOT identity_conflict THEN
    IF EXISTS (
      SELECT 1 FROM "public"."orders" purchase_order
      WHERE purchase_order.id = ANY(order_ids)
        AND purchase_order.purchase_email IS DISTINCT FROM candidate.normalized_email
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'commerce claim order email is inconsistent';
    END IF;

    PERFORM 1 FROM "public"."payments" payment
    WHERE payment.order_id = ANY(order_ids)
    ORDER BY payment.id
    FOR UPDATE;
    SELECT coalesce(pg_catalog.array_agg(payment.id ORDER BY payment.id),
        ARRAY[]::uuid[])
    INTO payment_ids
    FROM "public"."payments" payment
    WHERE payment.order_id = ANY(order_ids);

    PERFORM 1 FROM "public"."refunds" refund
    WHERE refund.payment_id = ANY(payment_ids)
    ORDER BY refund.id
    FOR UPDATE;
    SELECT coalesce(pg_catalog.array_agg(refund.id ORDER BY refund.id),
        ARRAY[]::uuid[])
    INTO refund_ids
    FROM "public"."refunds" refund
    WHERE refund.payment_id = ANY(payment_ids);

    PERFORM 1 FROM "public"."refund_allocations" allocation
    WHERE allocation.refund_id = ANY(refund_ids)
    ORDER BY allocation.id
    FOR UPDATE;
    PERFORM 1 FROM "public"."disputes" dispute
    WHERE dispute.payment_id = ANY(payment_ids)
    ORDER BY dispute.id
    FOR UPDATE;

    PERFORM 1 FROM "public"."order_items" item
    WHERE item.order_id = ANY(order_ids)
    ORDER BY item.id
    FOR UPDATE;
    SELECT
      coalesce(pg_catalog.array_agg(item.id ORDER BY item.id), ARRAY[]::uuid[]),
      coalesce(pg_catalog.array_agg(DISTINCT item.title_id ORDER BY item.title_id),
        ARRAY[]::uuid[])
    INTO item_ids, title_ids
    FROM "public"."order_items" item
    WHERE item.order_id = ANY(order_ids);
    title_count := pg_catalog.cardinality(title_ids);

    FOR current_title_id IN SELECT pg_catalog.unnest(title_ids) ORDER BY 1 LOOP
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'pale-orbit:commerce:entitlement:' || candidate.authorized_user_id::text ||
          ':' || current_title_id::text,
        0
      ));
    END LOOP;
  END IF;

  SELECT * INTO locked_user
  FROM "public"."user" claimant
  WHERE claimant.id = candidate.authorized_user_id
  FOR UPDATE;
  IF NOT FOUND OR NOT locked_user.email_verified OR
    locked_user.email <> candidate.normalized_email OR
    locked_user.email <> pg_catalog.lower(pg_catalog.btrim(locked_user.email)) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'authorized commerce claim user changed';
  END IF;

  IF eligible AND NOT identity_conflict THEN
    PERFORM 1
    FROM "public"."entitlement_grants" grant_row
    WHERE grant_row.order_item_id = ANY(item_ids) OR
      (grant_row.user_id = locked_user.id AND grant_row.title_id = ANY(title_ids))
    ORDER BY grant_row.id
    FOR UPDATE;
  END IF;

  SELECT * INTO locked_authority
  FROM "public"."credential_authority" authority
  WHERE authority.user_id = locked_user.id
  FOR UPDATE;
  has_authority := FOUND;
  PERFORM 1
  FROM "public"."account" account_row
  WHERE account_row.user_id = locked_user.id
  ORDER BY account_row.id
  FOR UPDATE;
  SELECT pg_catalog.count(*)::integer, pg_catalog.max(account_row.password)
  INTO credential_count, credential_password
  FROM "public"."account" account_row
  WHERE account_row.user_id = locked_user.id AND account_row.provider_id = 'credential';

  SELECT * INTO locked_issuance
  FROM "public"."commerce_claim_issuances" issuance
  WHERE issuance.claim_proof_sha256 = claim_digest
  FOR UPDATE;
  IF FOUND AND locked_issuance.state = 'consumed' THEN
    IF locked_issuance.result_disposition = 'claimed' THEN
      RETURN QUERY SELECT true, locked_issuance.result_changed,
        locked_issuance.result_order_count, locked_issuance.result_title_count,
        false, NULL::text;
    ELSIF locked_issuance.result_disposition = 'not_eligible' THEN
      RETURN QUERY SELECT false, false, 0, 0, false, NULL::text;
    ELSIF locked_issuance.result_disposition = 'definitive_invalid' THEN
      RETURN QUERY SELECT false, false, 0, 0, true, NULL::text;
    ELSIF locked_issuance.result_disposition = 'identity_conflict' THEN
      RETURN QUERY SELECT false, false, 0, 0, false,
        'IDENTITY_ALREADY_CLAIMED'::text;
    ELSE
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'consumed commerce claim has no replayable result';
    END IF;
    RETURN;
  END IF;
  IF NOT FOUND OR locked_issuance.state <> 'authorized' OR
    locked_issuance.normalized_email <> locked_user.email OR
    locked_issuance.authorized_user_id <> locked_user.id OR
    locked_issuance.expires_at <= claim_at THEN
    RETURN QUERY SELECT false, false, 0, 0, true, NULL::text;
    RETURN;
  END IF;
  IF locked_issuance.kind = 'commerce-magic' THEN
    IF credential_count <> 0 OR has_authority THEN
      UPDATE "public"."commerce_claim_issuances"
      SET state = 'consumed', auth_token_sha256 = NULL, normalized_email = NULL,
        anchor_order_id = NULL, authorized_user_id = NULL, consumed_at = claim_at,
        result_disposition = 'definitive_invalid', result_changed = false,
        result_order_count = 0, result_title_count = 0
      WHERE claim_proof_sha256 = claim_digest;
      RETURN QUERY SELECT false, false, 0, 0, true, NULL::text;
      RETURN;
    END IF;
  ELSIF locked_issuance.kind = 'password-reset' THEN
    IF credential_count <> 1 OR credential_password IS NULL OR NOT has_authority OR
      locked_authority.authorized_password_hash IS DISTINCT FROM credential_password OR
      locked_authority.reset_epoch_sha256 IS NOT NULL THEN
      UPDATE "public"."commerce_claim_issuances"
      SET state = 'consumed', auth_token_sha256 = NULL, normalized_email = NULL,
        anchor_order_id = NULL, authorized_user_id = NULL, consumed_at = claim_at,
        result_disposition = 'definitive_invalid', result_changed = false,
        result_order_count = 0, result_title_count = 0
      WHERE claim_proof_sha256 = claim_digest;
      RETURN QUERY SELECT false, false, 0, 0, true, NULL::text;
      RETURN;
    END IF;
  ELSE
    UPDATE "public"."commerce_claim_issuances"
    SET state = 'consumed', auth_token_sha256 = NULL, normalized_email = NULL,
      anchor_order_id = NULL, authorized_user_id = NULL, consumed_at = claim_at,
      result_disposition = 'definitive_invalid', result_changed = false,
      result_order_count = 0, result_title_count = 0
    WHERE claim_proof_sha256 = claim_digest;
    RETURN QUERY SELECT false, false, 0, 0, true, NULL::text;
    RETURN;
  END IF;

  IF identity_conflict THEN
    UPDATE "public"."commerce_claim_issuances"
    SET state = 'consumed', auth_token_sha256 = NULL, normalized_email = NULL,
      anchor_order_id = NULL, authorized_user_id = NULL, consumed_at = claim_at,
      result_disposition = 'identity_conflict', result_changed = false,
      result_order_count = 0, result_title_count = 0
    WHERE claim_proof_sha256 = claim_digest;
    RETURN QUERY SELECT false, false, 0, 0, false, 'IDENTITY_ALREADY_CLAIMED'::text;
    RETURN;
  END IF;
  IF NOT eligible THEN
    UPDATE "public"."commerce_claim_issuances"
    SET state = 'consumed', auth_token_sha256 = NULL, normalized_email = NULL,
      anchor_order_id = NULL, authorized_user_id = NULL, consumed_at = claim_at,
      result_disposition = 'not_eligible', result_changed = false,
      result_order_count = 0, result_title_count = 0
    WHERE claim_proof_sha256 = claim_digest;
    RETURN QUERY SELECT false, false, 0, 0, false, NULL::text;
    RETURN;
  END IF;

  IF pg_catalog.cardinality(payment_ids) <> order_count OR EXISTS (
    SELECT 1 FROM "public"."payments" payment
    WHERE payment.id = ANY(payment_ids) AND payment.status <> 'succeeded'
  ) OR pg_catalog.cardinality(item_ids) = 0 OR EXISTS (
    SELECT 1 FROM "public"."order_items" item
    WHERE item.id = ANY(item_ids) AND (item.total_minor IS NULL OR item.total_minor < 1)
  ) OR (SELECT pg_catalog.count(*) FROM "public"."entitlement_grants" grant_row
        WHERE grant_row.order_item_id = ANY(item_ids) AND grant_row.source = 'purchase')
       <> pg_catalog.cardinality(item_ids) OR EXISTS (
    SELECT 1 FROM "public"."entitlement_grants" grant_row
    WHERE grant_row.order_item_id = ANY(item_ids) AND grant_row.source = 'purchase'
      AND grant_row.user_id IS NOT NULL AND grant_row.user_id <> locked_user.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'commerce claim financial or grant facts are inconsistent';
  END IF;

  FOR grant_fact IN
    SELECT grant_row.id AS grant_id, grant_row.user_id, grant_row.state,
      grant_row.state_reason, grant_row.granted_at, grant_row.suspended_at,
      grant_row.revoked_at, item.id AS item_id, item.title_id, item.total_minor,
      payment.id AS payment_id
    FROM "public"."order_items" item
    JOIN "public"."payments" payment ON payment.order_id = item.order_id
    JOIN "public"."entitlement_grants" grant_row
      ON grant_row.order_item_id = item.id AND grant_row.source = 'purchase'
    WHERE item.id = ANY(item_ids)
    ORDER BY grant_row.id
  LOOP
    IF grant_fact.user_id = locked_user.id THEN CONTINUE; END IF;
    SELECT coalesce(pg_catalog.sum(allocation.amount_minor), 0)
    INTO allocated_minor
    FROM "public"."refund_allocations" allocation
    JOIN "public"."refunds" refund ON refund.id = allocation.refund_id
    WHERE allocation.order_item_id = grant_fact.item_id
      AND refund.status = 'succeeded';
    IF allocated_minor < 0 OR allocated_minor > grant_fact.total_minor THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'commerce claim refund allocation is inconsistent';
    END IF;
    SELECT coalesce(pg_catalog.bool_or(dispute.status = 'lost'), false),
      coalesce(pg_catalog.bool_or(dispute.status = 'open'), false)
    INTO has_lost_dispute, has_open_dispute
    FROM "public"."disputes" dispute
    WHERE dispute.payment_id = grant_fact.payment_id;

    IF grant_fact.state = 'revoked' THEN
      next_state := 'revoked';
      next_reason := grant_fact.state_reason;
    ELSIF allocated_minor = grant_fact.total_minor THEN
      next_state := 'revoked';
      next_reason := 'refund_fully_allocated';
    ELSIF has_lost_dispute THEN
      next_state := 'revoked';
      next_reason := 'dispute_lost';
    ELSIF has_open_dispute THEN
      next_state := 'suspended';
      next_reason := 'dispute_open';
    ELSE
      next_state := 'active';
      next_reason := 'payment_succeeded';
    END IF;

    UPDATE "public"."entitlement_grants"
    SET user_id = locked_user.id,
      state = next_state::"public"."entitlement_grant_status",
      state_reason = next_reason,
      suspended_at = CASE WHEN next_state = 'suspended'
        THEN coalesce(grant_fact.suspended_at,
          greatest(claim_at, grant_fact.granted_at)) ELSE NULL END,
      revoked_at = CASE WHEN next_state = 'revoked'
        THEN coalesce(grant_fact.revoked_at,
          greatest(claim_at, grant_fact.granted_at)) ELSE NULL END,
      updated_at = claim_at
    WHERE id = grant_fact.grant_id;
    any_changed := true;
  END LOOP;

  identity_changed := locked_identity.claimed_by_user_id IS NULL;
  IF identity_changed THEN
    UPDATE "public"."guest_identities"
    SET claimed_by_user_id = locked_user.id, claimed_at = claim_at, updated_at = claim_at
    WHERE id = locked_identity.id;
    any_changed := true;
  END IF;

  FOR current_title_id IN SELECT pg_catalog.unnest(title_ids) ORDER BY 1 LOOP
    SELECT * INTO locked_entitlement
    FROM "public"."entitlements" entitlement
    WHERE entitlement.user_id = locked_user.id
      AND entitlement.title_id = current_title_id
    FOR UPDATE;
    has_entitlement := FOUND;
    SELECT EXISTS (
      SELECT 1 FROM "public"."entitlement_grants" grant_row
      WHERE grant_row.user_id = locked_user.id
        AND grant_row.title_id = current_title_id
        AND grant_row.state = 'active'
    ) INTO has_active_grant;
    IF has_active_grant AND NOT has_entitlement THEN
      INSERT INTO "public"."entitlements" (
        user_id, title_id, granted_at, revoked_at, created_at, updated_at
      ) VALUES (
        locked_user.id, current_title_id, claim_at, NULL, claim_at, claim_at
      );
      any_changed := true;
    ELSIF has_active_grant AND locked_entitlement.revoked_at IS NOT NULL THEN
      UPDATE "public"."entitlements"
      SET revoked_at = NULL, updated_at = claim_at
      WHERE id = locked_entitlement.id;
      any_changed := true;
    ELSIF NOT has_active_grant AND has_entitlement AND
      locked_entitlement.revoked_at IS NULL THEN
      UPDATE "public"."entitlements"
      SET revoked_at = greatest(claim_at, locked_entitlement.granted_at),
        updated_at = claim_at
      WHERE id = locked_entitlement.id;
      any_changed := true;
    END IF;
  END LOOP;

  IF any_changed THEN
    INSERT INTO "public"."audit_events" (
      actor_type, actor_id, action, outcome, resource_type, resource_id,
      correlation_id, after
    ) VALUES (
      'user', locked_user.id::text, 'commerce.guest_claimed', 'succeeded',
      'guest_identity', locked_identity.id::text, p_correlation_id,
      pg_catalog.jsonb_build_object(
        'claimedOrderCount', order_count,
        'claimedTitleCount', title_count
      )
    );
  END IF;

  UPDATE "public"."commerce_claim_issuances"
  SET state = 'consumed', auth_token_sha256 = NULL, normalized_email = NULL,
    anchor_order_id = NULL, authorized_user_id = NULL, consumed_at = claim_at,
    result_disposition = 'claimed', result_changed = any_changed,
    result_order_count = order_count, result_title_count = title_count
  WHERE claim_proof_sha256 = claim_digest;
  RETURN QUERY SELECT true, any_changed, order_count, title_count, false, NULL::text;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "public"."register_commerce_claim_issuance"(
  p_claim_proof_sha256 text,
  p_auth_token_sha256 text,
  p_normalized_email text,
  p_anchor_order_id uuid,
  p_kind text,
  p_expires_at timestamp with time zone
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $$
DECLARE
  anchor_candidate record;
  locked_identity "public"."guest_identities"%ROWTYPE;
  locked_order "public"."orders"%ROWTYPE;
  existing_issuance "public"."commerce_claim_issuances"%ROWTYPE;
  registered_at timestamp with time zone := pg_catalog.clock_timestamp();
BEGIN
  IF p_claim_proof_sha256 IS NULL OR p_claim_proof_sha256 !~ '^[a-f0-9]{64}$' OR
    p_auth_token_sha256 IS NULL OR p_auth_token_sha256 !~ '^[a-f0-9]{64}$' OR
    p_normalized_email IS NULL OR
    p_normalized_email <> pg_catalog.lower(pg_catalog.btrim(p_normalized_email)) OR
    p_anchor_order_id IS NULL OR p_kind IS NULL OR
    p_kind NOT IN ('password-reset', 'commerce-magic') OR
    p_expires_at IS NULL OR p_expires_at <= registered_at OR
    p_expires_at > registered_at + INTERVAL '24 hours' THEN
    RETURN false;
  END IF;

  SELECT purchase_order.guest_identity_id
  INTO anchor_candidate
  FROM "public"."orders" purchase_order
  WHERE purchase_order.id = p_anchor_order_id;
  IF NOT FOUND OR anchor_candidate.guest_identity_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT * INTO locked_identity
  FROM "public"."guest_identities" identity
  WHERE identity.id = anchor_candidate.guest_identity_id
  FOR UPDATE;
  IF NOT FOUND OR locked_identity.email <> p_normalized_email OR
    locked_identity.claimed_by_user_id IS NOT NULL THEN
    RETURN false;
  END IF;

  SELECT * INTO locked_order
  FROM "public"."orders" purchase_order
  WHERE purchase_order.id = p_anchor_order_id
  FOR UPDATE;
  IF NOT FOUND OR locked_order.guest_identity_id <> locked_identity.id OR
    locked_order.status <> 'paid' OR locked_order.initiating_user_id IS NOT NULL OR
    locked_order.purchase_email IS DISTINCT FROM p_normalized_email THEN
    RETURN false;
  END IF;

  PERFORM 1
  FROM "public"."payments" payment
  WHERE payment.order_id = locked_order.id
  ORDER BY payment.id
  FOR UPDATE;
  IF (SELECT pg_catalog.count(*) FROM "public"."payments" payment
      WHERE payment.order_id = locked_order.id AND payment.status = 'succeeded') <> 1 THEN
    RETURN false;
  END IF;

  PERFORM 1
  FROM "public"."order_items" item
  WHERE item.order_id = locked_order.id
  ORDER BY item.id
  FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM "public"."order_items" item WHERE item.order_id = locked_order.id
  ) THEN
    RETURN false;
  END IF;
  PERFORM 1
  FROM "public"."entitlement_grants" grant_row
  JOIN "public"."order_items" item ON item.id = grant_row.order_item_id
  WHERE item.order_id = locked_order.id
  ORDER BY grant_row.id
  FOR UPDATE OF grant_row;
  IF EXISTS (
    SELECT 1
    FROM "public"."order_items" item
    LEFT JOIN "public"."entitlement_grants" grant_row
      ON grant_row.order_item_id = item.id AND grant_row.source = 'purchase'
    WHERE item.order_id = locked_order.id
      AND (grant_row.id IS NULL OR grant_row.user_id IS NOT NULL)
  ) THEN
    RETURN false;
  END IF;

  PERFORM 1
  FROM "public"."commerce_claim_issuances" issuance
  WHERE issuance.normalized_email = p_normalized_email
    AND issuance.state IN ('issued', 'authorized')
  ORDER BY issuance.claim_proof_sha256
  FOR UPDATE;
  SELECT * INTO existing_issuance
  FROM "public"."commerce_claim_issuances" issuance
  WHERE issuance.claim_proof_sha256 = p_claim_proof_sha256
  FOR UPDATE;
  IF FOUND THEN
    RETURN existing_issuance.state = 'issued' AND
      existing_issuance.auth_token_sha256 = p_auth_token_sha256 AND
      existing_issuance.normalized_email = p_normalized_email AND
      existing_issuance.anchor_order_id = p_anchor_order_id AND
      existing_issuance.kind = p_kind AND
      existing_issuance.expires_at = p_expires_at AND
      existing_issuance.expires_at > registered_at;
  END IF;

  DELETE FROM "public"."commerce_claim_issuances"
  WHERE normalized_email = p_normalized_email
    AND state IN ('issued', 'authorized');
  INSERT INTO "public"."commerce_claim_issuances" (
    claim_proof_sha256, auth_token_sha256, normalized_email,
    anchor_order_id, kind, state, issued_at, expires_at
  ) VALUES (
    p_claim_proof_sha256, p_auth_token_sha256, p_normalized_email,
    p_anchor_order_id, p_kind, 'issued', registered_at, p_expires_at
  );
  RETURN true;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "public"."authorize_commerce_claim_issuance"(
  p_raw_claim_proof text,
  p_raw_auth_token text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $$
DECLARE
  claim_digest text;
  auth_digest text;
  candidate "public"."commerce_claim_issuances"%ROWTYPE;
  locked_issuance "public"."commerce_claim_issuances"%ROWTYPE;
  locked_identity "public"."guest_identities"%ROWTYPE;
  locked_order "public"."orders"%ROWTYPE;
  locked_user "public"."user"%ROWTYPE;
  locked_authority "public"."credential_authority"%ROWTYPE;
  user_candidate_id uuid;
  identity_candidate_id uuid;
  has_authority boolean := false;
  credential_count integer;
  credential_password text;
  promotion_at timestamp with time zone := pg_catalog.clock_timestamp();
BEGIN
  IF p_raw_claim_proof IS NULL OR p_raw_claim_proof !~ '^[A-Za-z0-9_-]{43}$' OR
    p_raw_auth_token IS NULL OR pg_catalog.char_length(p_raw_auth_token) NOT BETWEEN 1 AND 256 THEN
    RETURN false;
  END IF;
  claim_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_raw_claim_proof, 'UTF8')), 'hex'
  );
  auth_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_raw_auth_token, 'UTF8')), 'hex'
  );

  SELECT * INTO candidate
  FROM "public"."commerce_claim_issuances" issuance
  WHERE issuance.claim_proof_sha256 = claim_digest;
  IF NOT FOUND OR candidate.state NOT IN ('issued', 'authorized') OR
    candidate.normalized_email IS NULL OR candidate.anchor_order_id IS NULL OR
    candidate.auth_token_sha256 IS DISTINCT FROM auth_digest THEN
    RETURN false;
  END IF;

  SELECT identity.id INTO identity_candidate_id
  FROM "public"."guest_identities" identity
  WHERE identity.email = candidate.normalized_email;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO locked_identity
  FROM "public"."guest_identities" identity
  WHERE identity.id = identity_candidate_id
  FOR UPDATE;
  IF NOT FOUND OR locked_identity.email <> candidate.normalized_email THEN
    RETURN false;
  END IF;

  SELECT * INTO locked_order
  FROM "public"."orders" purchase_order
  WHERE purchase_order.id = candidate.anchor_order_id
  FOR UPDATE;
  IF NOT FOUND OR locked_order.guest_identity_id <> locked_identity.id OR
    locked_order.status <> 'paid' OR locked_order.initiating_user_id IS NOT NULL OR
    locked_order.purchase_email IS DISTINCT FROM candidate.normalized_email THEN
    RETURN false;
  END IF;

  SELECT claimant.id INTO user_candidate_id
  FROM "public"."user" claimant
  WHERE claimant.email = candidate.normalized_email;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO locked_user
  FROM "public"."user" claimant
  WHERE claimant.id = user_candidate_id
  FOR UPDATE;
  IF NOT FOUND OR NOT locked_user.email_verified OR
    locked_user.email <> candidate.normalized_email OR
    locked_user.email <> pg_catalog.lower(pg_catalog.btrim(locked_user.email)) THEN
    RETURN false;
  END IF;

  SELECT * INTO locked_authority
  FROM "public"."credential_authority" authority
  WHERE authority.user_id = locked_user.id
  FOR UPDATE;
  has_authority := FOUND;
  PERFORM 1
  FROM "public"."account" account_row
  WHERE account_row.user_id = locked_user.id
  ORDER BY account_row.id
  FOR UPDATE;
  SELECT pg_catalog.count(*)::integer, pg_catalog.max(account_row.password)
  INTO credential_count, credential_password
  FROM "public"."account" account_row
  WHERE account_row.user_id = locked_user.id AND account_row.provider_id = 'credential';

  SELECT * INTO locked_issuance
  FROM "public"."commerce_claim_issuances" issuance
  WHERE issuance.claim_proof_sha256 = claim_digest
  FOR UPDATE;
  IF NOT FOUND OR locked_issuance.state NOT IN ('issued', 'authorized') OR
    locked_issuance.normalized_email <> locked_user.email OR
    locked_issuance.anchor_order_id <> locked_order.id OR
    locked_issuance.auth_token_sha256 IS DISTINCT FROM auth_digest OR
    locked_issuance.expires_at <= promotion_at OR
    (locked_issuance.state = 'authorized' AND
      locked_issuance.authorized_user_id IS DISTINCT FROM locked_user.id) THEN
    RETURN false;
  END IF;

  IF locked_issuance.kind = 'commerce-magic' THEN
    IF credential_count <> 0 OR has_authority THEN RETURN false; END IF;
  ELSIF locked_issuance.kind = 'password-reset' THEN
    IF credential_count <> 1 OR credential_password IS NULL OR NOT has_authority OR
      locked_authority.authorized_password_hash IS DISTINCT FROM credential_password OR
      locked_authority.reset_epoch_sha256 IS NOT NULL THEN
      RETURN false;
    END IF;
  ELSE
    RETURN false;
  END IF;

  IF locked_issuance.state = 'issued' THEN
    UPDATE "public"."commerce_claim_issuances"
    SET state = 'authorized', authorized_user_id = locked_user.id,
      authorized_at = promotion_at
    WHERE claim_proof_sha256 = claim_digest;
  END IF;
  RETURN true;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."plan6b_guard_audit_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'pg_catalog'
AS $$
DECLARE
  claim_owner name;
BEGIN
  IF NOT (
    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.action = 'commerce.guest_claimed' THEN
    SELECT pg_catalog.pg_get_userbyid(routine.proowner)
    INTO claim_owner
    FROM pg_catalog.pg_proc routine
    WHERE routine.oid = pg_catalog.to_regprocedure(
      'public.claim_guest_purchases_after_authorization(text,text)'
    );
    IF current_user = claim_owner
      AND NEW.actor_type = 'user'
      AND NEW.actor_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND NEW.outcome = 'succeeded'
      AND NEW.resource_type = 'guest_identity'
      AND NEW.resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND NEW.correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      AND NEW.request_metadata IS NULL
      AND NEW.before IS NULL
      AND pg_catalog.jsonb_typeof(NEW.after) = 'object'
      AND NEW.after - 'claimedOrderCount' - 'claimedTitleCount' = '{}'::jsonb
      AND pg_catalog.jsonb_typeof(NEW.after -> 'claimedOrderCount') = 'number'
      AND pg_catalog.jsonb_typeof(NEW.after -> 'claimedTitleCount') = 'number'
      AND NEW.after ->> 'claimedOrderCount' ~ '^[1-9][0-9]{0,8}$'
      AND NEW.after ->> 'claimedTitleCount' ~ '^[1-9][0-9]{0,8}$'
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'commerce guest claim audit provenance is reserved';
  END IF;

  IF NEW.action LIKE 'financial.%' OR NEW.action IN (
    'commerce.fulfillment_paid',
    'commerce.fulfillment_exception',
    'commerce.refund_reconciled',
    'commerce.dispute_reconciled',
    'catalog.revision.ingest.succeeded',
    'catalog.revision.ingest.failed'
  ) OR NEW.actor_id IN (
    'commerce-worker',
    'financial-worker',
    'publication-ingestion-worker'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'worker audit provenance is reserved';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan6b_guard_audit_insert"() FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION "public"."plan6b_guard_guest_identity_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'pg_catalog'
AS $$
DECLARE
  claim_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(routine.proowner)
  INTO claim_owner
  FROM pg_catalog.pg_proc routine
  WHERE routine.oid = pg_catalog.to_regprocedure(
    'public.claim_guest_purchases_after_authorization(text,text)'
  );
  IF current_user = claim_owner THEN
    RETURN NEW;
  END IF;
  IF pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'guest identity mutation is reserved';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan6b_guard_guest_identity_update"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "guest_identities_plan6b_update_guard"
BEFORE UPDATE ON "public"."guest_identities"
FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_guard_guest_identity_update"();--> statement-breakpoint
CREATE TRIGGER "payout_import_run_entries_immutable"
BEFORE UPDATE OR DELETE ON "public"."payout_import_run_entries"
FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_reject_history_mutation"();--> statement-breakpoint
REVOKE ALL ON TABLE "public"."commerce_claim_issuances" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."commerce_claim_issuances" FROM "pale_orbit_runtime", "pale_orbit_financial_worker";--> statement-breakpoint
REVOKE SELECT (
  "claim_proof_sha256", "auth_token_sha256", "normalized_email",
  "anchor_order_id", "kind", "state", "authorized_user_id", "issued_at",
  "expires_at", "authorized_at", "consumed_at", "result_disposition",
  "result_changed", "result_order_count", "result_title_count"
) ON TABLE "public"."commerce_claim_issuances"
FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."register_commerce_claim_issuance"(text,text,text,uuid,text,timestamp with time zone) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."authorize_commerce_claim_issuance"(text,text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."claim_guest_purchases_after_authorization"(text,text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."purge_commerce_claim_issuances"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."outbox_message_exists_by_deduplication_key"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."outbox_message_deduplication_metadata"(text,text,jsonb) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."register_commerce_claim_issuance"(text,text,text,uuid,text,timestamp with time zone) FROM "pale_orbit_runtime";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."purge_commerce_claim_issuances"() FROM "pale_orbit_runtime";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."register_commerce_claim_issuance"(text,text,text,uuid,text,timestamp with time zone) TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."purge_commerce_claim_issuances"() TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."authorize_commerce_claim_issuance"(text,text) TO "pale_orbit_runtime";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."claim_guest_purchases_after_authorization"(text,text) TO "pale_orbit_runtime";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."outbox_message_exists_by_deduplication_key"(text) TO "pale_orbit_runtime";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."outbox_message_deduplication_metadata"(text,text,jsonb) TO "pale_orbit_runtime";--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."guest_identities"
FROM "pale_orbit_runtime", "pale_orbit_financial_worker";--> statement-breakpoint
GRANT INSERT ("email") ON TABLE "public"."guest_identities"
TO "pale_orbit_runtime";--> statement-breakpoint
GRANT UPDATE ("updated_at") ON TABLE "public"."guest_identities"
TO "pale_orbit_runtime";--> statement-breakpoint
GRANT UPDATE ("id") ON TABLE "public"."refund_allocation_drafts"
TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT UPDATE ("id") ON TABLE "public"."refund_allocation_draft_items"
TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT UPDATE ("id") ON TABLE "public"."refund_allocations"
TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT UPDATE ("id") ON TABLE "public"."refund_allocation_components"
TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT UPDATE ("id") ON TABLE "public"."refund_reporting_correction_sets"
TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT UPDATE ("id") ON TABLE "public"."refund_reporting_correction_items"
TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT UPDATE ("id") ON TABLE "public"."dispute_item_allocations"
TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT UPDATE ("id") ON TABLE "public"."stripe_payout_balance_transactions"
TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT UPDATE ("id") ON TABLE "public"."stripe_balance_transaction_fee_details"
TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT UPDATE ("id") ON TABLE "public"."financial_classification_versions"
TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT UPDATE ("id") ON TABLE "public"."financial_allocation_sets"
TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT UPDATE ("id") ON TABLE "public"."financial_item_allocations"
TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT UPDATE ("id") ON TABLE "public"."payout_import_run_entries"
TO "pale_orbit_financial_worker";--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE
  "public"."entitlement_grants", "public"."entitlements"
FROM "pale_orbit_runtime";--> statement-breakpoint
GRANT INSERT, UPDATE ON TABLE "public"."entitlement_grants", "public"."entitlements"
TO "pale_orbit_financial_worker";--> statement-breakpoint
REVOKE SELECT ON TABLE "public"."outbox_messages" FROM "pale_orbit_runtime";--> statement-breakpoint
REVOKE SELECT ("payload") ON TABLE "public"."outbox_messages"
FROM PUBLIC, "pale_orbit_runtime";--> statement-breakpoint
GRANT SELECT (
  "id", "topic", "deduplication_key", "dispatch_job_id", "status", "last_error",
  "delivered_at", "created_at", "updated_at"
) ON TABLE "public"."outbox_messages" TO "pale_orbit_runtime";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."outbox_messages" TO "pale_orbit_financial_worker";--> statement-breakpoint
