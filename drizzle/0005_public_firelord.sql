CREATE TYPE "public"."commerce_dispute_status" AS ENUM('open', 'won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."entitlement_grant_source" AS ENUM('purchase', 'preserved');--> statement-breakpoint
CREATE TYPE "public"."entitlement_grant_status" AS ENUM('unclaimed', 'active', 'suspended', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."financial_reconciliation_status" AS ENUM('pending', 'reconciled', 'exception');--> statement-breakpoint
CREATE TYPE "public"."commerce_order_status" AS ENUM('checkout_pending', 'checkout_open', 'payment_pending', 'paid', 'expired', 'failed', 'exception');--> statement-breakpoint
CREATE TYPE "public"."commerce_payment_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."refund_allocation_source" AS ENUM('automatic', 'administrative');--> statement-breakpoint
CREATE TYPE "public"."commerce_refund_status" AS ENUM('pending', 'succeeded', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."stripe_event_status" AS ENUM('pending', 'processed', 'exception');--> statement-breakpoint
CREATE TABLE "application_rate_limits" (
	"namespace" varchar(100) NOT NULL,
	"scope_sha256" varchar(64) NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_rate_limits_pk" PRIMARY KEY("namespace","scope_sha256","window_start"),
	CONSTRAINT "application_rate_limits_scope_digest_sha256" CHECK ("application_rate_limits"."scope_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "application_rate_limits_count_positive" CHECK ("application_rate_limits"."count" > 0),
	CONSTRAINT "application_rate_limits_expiry_after_window" CHECK ("application_rate_limits"."expires_at" > "application_rate_limits"."window_start"),
	CONSTRAINT "application_rate_limits_namespace_safe" CHECK ("application_rate_limits"."namespace" ~ '^[a-z0-9][a-z0-9._-]{0,99}$')
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"stripe_dispute_id" varchar(255) NOT NULL,
	"status" "commerce_dispute_status" DEFAULT 'open' NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"reason" varchar(100),
	"provider_created_at" timestamp with time zone NOT NULL,
	"provider_updated_at" timestamp with time zone NOT NULL,
	"reconciliation_status" "financial_reconciliation_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disputes_amount_nonnegative" CHECK ("disputes"."amount_minor" >= 0),
	CONSTRAINT "disputes_currency_iso" CHECK ("disputes"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "disputes_reason_safe" CHECK ("disputes"."reason" is null or char_length("disputes"."reason") > 0),
	CONSTRAINT "disputes_provider_timestamp_order" CHECK ("disputes"."provider_updated_at" >= "disputes"."provider_created_at")
);
--> statement-breakpoint
CREATE TABLE "entitlement_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title_id" uuid NOT NULL,
	"user_id" uuid,
	"source" "entitlement_grant_source" NOT NULL,
	"order_item_id" uuid,
	"state" "entitlement_grant_status" NOT NULL,
	"state_reason" varchar(100) NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suspended_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grants_unclaimed_has_no_user" CHECK ("entitlement_grants"."state" <> 'unclaimed' or "entitlement_grants"."user_id" is null),
	CONSTRAINT "grants_active_has_user" CHECK ("entitlement_grants"."state" <> 'active' or "entitlement_grants"."user_id" is not null),
	CONSTRAINT "grants_source_consistent" CHECK (("entitlement_grants"."source" = 'purchase') = ("entitlement_grants"."order_item_id" is not null) and ("entitlement_grants"."source" <> 'preserved' or "entitlement_grants"."user_id" is not null)),
	CONSTRAINT "grants_state_reason_safe" CHECK (char_length("entitlement_grants"."state_reason") between 1 and 100),
	CONSTRAINT "grants_state_timestamps_consistent" CHECK ((
        "entitlement_grants"."state" in ('unclaimed', 'active') and
        "entitlement_grants"."suspended_at" is null and "entitlement_grants"."revoked_at" is null
      ) or (
        "entitlement_grants"."state" = 'suspended' and
        "entitlement_grants"."suspended_at" is not null and "entitlement_grants"."revoked_at" is null
      ) or (
        "entitlement_grants"."state" = 'revoked' and "entitlement_grants"."revoked_at" is not null
      )),
	CONSTRAINT "grants_state_timestamps_after_grant" CHECK (("entitlement_grants"."suspended_at" is null or "entitlement_grants"."suspended_at" >= "entitlement_grants"."granted_at") and ("entitlement_grants"."revoked_at" is null or "entitlement_grants"."revoked_at" >= "entitlement_grants"."granted_at"))
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"title_id" uuid NOT NULL,
	"title_snapshot" text NOT NULL,
	"creator_name_snapshot" text NOT NULL,
	"format" "title_format" NOT NULL,
	"currency" varchar(3) NOT NULL,
	"unit_subtotal_minor" integer NOT NULL,
	"tax_minor" integer,
	"total_minor" integer,
	"stripe_line_item_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_money_nonnegative" CHECK ("order_items"."unit_subtotal_minor" >= 0 and ("order_items"."tax_minor" is null or "order_items"."tax_minor" >= 0) and ("order_items"."total_minor" is null or "order_items"."total_minor" >= 0)),
	CONSTRAINT "order_items_currency_iso" CHECK ("order_items"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "order_items_total_consistent" CHECK ((
        "order_items"."tax_minor" is null and "order_items"."total_minor" is null
      ) or (
        "order_items"."tax_minor" is not null and "order_items"."total_minor" = "order_items"."unit_subtotal_minor" + "order_items"."tax_minor"
      ))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "commerce_order_status" DEFAULT 'checkout_pending' NOT NULL,
	"initiating_user_id" uuid,
	"guest_identity_id" uuid,
	"purchase_email" varchar(320),
	"currency" varchar(3) NOT NULL,
	"subtotal_minor" integer NOT NULL,
	"tax_minor" integer,
	"total_minor" integer,
	"client_checkout_attempt_id" uuid NOT NULL,
	"quote_fingerprint_sha256" varchar(64) NOT NULL,
	"stripe_checkout_session_id" varchar(255),
	"status_token_sha256" varchar(64) NOT NULL,
	"checkout_expires_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_money_nonnegative" CHECK ("orders"."subtotal_minor" >= 0 and ("orders"."tax_minor" is null or "orders"."tax_minor" >= 0) and ("orders"."total_minor" is null or "orders"."total_minor" >= 0)),
	CONSTRAINT "orders_currency_iso" CHECK ("orders"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "orders_status_digest_sha256" CHECK ("orders"."status_token_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "orders_quote_digest_sha256" CHECK ("orders"."quote_fingerprint_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "orders_purchase_email_normalized" CHECK ("orders"."purchase_email" is null or ("orders"."purchase_email" = lower(btrim("orders"."purchase_email")) and char_length("orders"."purchase_email") > 0)),
	CONSTRAINT "orders_single_owner" CHECK ("orders"."initiating_user_id" is null or "orders"."guest_identity_id" is null),
	CONSTRAINT "orders_checkout_session_complete" CHECK (("orders"."stripe_checkout_session_id" is null) = ("orders"."checkout_expires_at" is null)),
	CONSTRAINT "orders_total_consistent" CHECK ((
        "orders"."tax_minor" is null and "orders"."total_minor" is null
      ) or (
        "orders"."tax_minor" is not null and "orders"."total_minor" = "orders"."subtotal_minor" + "orders"."tax_minor"
      )),
	CONSTRAINT "orders_paid_identity_consistent" CHECK ("orders"."status" <> 'paid' or (
        "orders"."purchase_email" is not null and
        "orders"."paid_at" is not null and
        "orders"."tax_minor" is not null and
        "orders"."total_minor" is not null and
        (("orders"."initiating_user_id" is not null)::integer + ("orders"."guest_identity_id" is not null)::integer) = 1
      ))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"stripe_payment_intent_id" varchar(255) NOT NULL,
	"stripe_latest_charge_id" varchar(255),
	"status" "commerce_payment_status" DEFAULT 'pending' NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"payment_method_category" varchar(50),
	"paid_at" timestamp with time zone,
	"reconciliation_status" "financial_reconciliation_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_nonnegative" CHECK ("payments"."amount_minor" >= 0),
	CONSTRAINT "payments_currency_iso" CHECK ("payments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payments_method_category_safe" CHECK ("payments"."payment_method_category" is null or "payments"."payment_method_category" ~ '^[a-z0-9_]{1,50}$'),
	CONSTRAINT "payments_paid_timestamp_consistent" CHECK (("payments"."status" = 'succeeded') = ("payments"."paid_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "refund_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"source" "refund_allocation_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_allocations_amount_nonnegative" CHECK ("refund_allocations"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"stripe_refund_id" varchar(255) NOT NULL,
	"status" "commerce_refund_status" DEFAULT 'pending' NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"reason" varchar(100),
	"provider_created_at" timestamp with time zone NOT NULL,
	"reconciliation_status" "financial_reconciliation_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_amount_nonnegative" CHECK ("refunds"."amount_minor" >= 0),
	CONSTRAINT "refunds_currency_iso" CHECK ("refunds"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "refunds_reason_safe" CHECK ("refunds"."reason" is null or char_length("refunds"."reason") > 0)
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" varchar(255) NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"object_id" varchar(255) NOT NULL,
	"live_mode" boolean NOT NULL,
	"api_version" varchar(100),
	"provider_created_at" timestamp with time zone NOT NULL,
	"raw_body_sha256" varchar(64) NOT NULL,
	"status" "stripe_event_status" DEFAULT 'pending' NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_events_payload_digest_sha256" CHECK ("stripe_events"."raw_body_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "stripe_events_identifier_safe" CHECK (char_length("stripe_events"."provider_event_id") > 0 and char_length("stripe_events"."event_type") > 0 and char_length("stripe_events"."object_id") > 0),
	CONSTRAINT "stripe_events_processed_timestamp_consistent" CHECK (("stripe_events"."status" = 'pending') = ("stripe_events"."processed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD COLUMN "deduplication_key" text;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_initiating_user_id_user_id_fk" FOREIGN KEY ("initiating_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_guest_identity_id_guest_identities_id_fk" FOREIGN KEY ("guest_identity_id") REFERENCES "public"."guest_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocations" ADD CONSTRAINT "refund_allocations_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocations" ADD CONSTRAINT "refund_allocations_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_rate_limits_expiry_idx" ON "application_rate_limits" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "application_rate_limits_claim_idx" ON "application_rate_limits" USING btree ("namespace","scope_sha256","window_start","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_stripe_dispute_unique" ON "disputes" USING btree ("stripe_dispute_id");--> statement-breakpoint
CREATE INDEX "disputes_payment_created_idx" ON "disputes" USING btree ("payment_id","provider_created_at");--> statement-breakpoint
CREATE INDEX "disputes_status_updated_idx" ON "disputes" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_grants_purchase_item_unique" ON "entitlement_grants" USING btree ("order_item_id") WHERE "entitlement_grants"."source" = 'purchase';--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_grants_preserved_user_title_unique" ON "entitlement_grants" USING btree ("user_id","title_id") WHERE "entitlement_grants"."source" = 'preserved';--> statement-breakpoint
CREATE INDEX "entitlement_grants_user_title_idx" ON "entitlement_grants" USING btree ("user_id","title_id","state");--> statement-breakpoint
CREATE INDEX "entitlement_grants_title_state_idx" ON "entitlement_grants" USING btree ("title_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_order_title_unique" ON "order_items" USING btree ("order_id","title_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_stripe_line_item_unique" ON "order_items" USING btree ("stripe_line_item_id") WHERE "order_items"."stripe_line_item_id" is not null;--> statement-breakpoint
CREATE INDEX "order_items_title_idx" ON "order_items" USING btree ("title_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_checkout_attempt_unique" ON "orders" USING btree ("client_checkout_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_stripe_checkout_session_unique" ON "orders" USING btree ("stripe_checkout_session_id") WHERE "orders"."stripe_checkout_session_id" is not null;--> statement-breakpoint
CREATE INDEX "orders_user_created_idx" ON "orders" USING btree ("initiating_user_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_guest_created_idx" ON "orders" USING btree ("guest_identity_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_updated_idx" ON "orders" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_order_unique" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_stripe_payment_intent_unique" ON "payments" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_stripe_latest_charge_unique" ON "payments" USING btree ("stripe_latest_charge_id") WHERE "payments"."stripe_latest_charge_id" is not null;--> statement-breakpoint
CREATE INDEX "payments_status_updated_idx" ON "payments" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_allocations_refund_item_unique" ON "refund_allocations" USING btree ("refund_id","order_item_id");--> statement-breakpoint
CREATE INDEX "refund_allocations_item_idx" ON "refund_allocations" USING btree ("order_item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_stripe_refund_unique" ON "refunds" USING btree ("stripe_refund_id");--> statement-breakpoint
CREATE INDEX "refunds_payment_created_idx" ON "refunds" USING btree ("payment_id","provider_created_at");--> statement-breakpoint
CREATE INDEX "refunds_status_updated_idx" ON "refunds" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_events_provider_event_unique" ON "stripe_events" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "stripe_events_status_created_idx" ON "stripe_events" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "stripe_events_object_idx" ON "stripe_events" USING btree ("object_id","provider_created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_messages_deduplication_key_unique" ON "outbox_messages" USING btree ("deduplication_key") WHERE "outbox_messages"."deduplication_key" is not null;--> statement-breakpoint
INSERT INTO "entitlement_grants" (
	"title_id",
	"user_id",
	"source",
	"state",
	"state_reason",
	"granted_at",
	"created_at",
	"updated_at"
)
SELECT
	e."title_id",
	e."user_id",
	'preserved',
	'active',
	'pre_commerce_entitlement',
	e."granted_at",
	e."created_at",
	e."updated_at"
FROM "entitlements" e
WHERE e."revoked_at" IS NULL
ON CONFLICT DO NOTHING;
