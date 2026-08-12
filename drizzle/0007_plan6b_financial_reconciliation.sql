CREATE TYPE "public"."financial_evidence_status" AS ENUM('pending', 'fee_reconciled', 'exception');--> statement-breakpoint
CREATE TYPE "public"."refund_allocation_status" AS ENUM('not_applicable', 'needs_review', 'draft', 'finalized', 'exception');--> statement-breakpoint
CREATE TYPE "public"."financial_allocation_basis" AS ENUM('gross_amount', 'fee');--> statement-breakpoint
CREATE TYPE "public"."financial_allocation_scope" AS ENUM('title', 'account', 'unresolved');--> statement-breakpoint
CREATE TYPE "public"."dispute_allocation_effect" AS ENUM('withdrawal', 'reinstatement');--> statement-breakpoint
CREATE TYPE "public"."financial_allocation_source_kind" AS ENUM('payment', 'refund', 'dispute', 'payout', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."financial_component" AS ENUM('sale_subtotal', 'sale_tax', 'processing_fee', 'refund_subtotal', 'refund_tax', 'refund_fee', 'refund_failure_reversal', 'dispute_subtotal', 'dispute_tax', 'dispute_fee', 'dispute_reinstatement', 'provider_fee_tax', 'fee_credit', 'other');--> statement-breakpoint
CREATE TYPE "public"."financial_finalization_transition" AS ENUM('unchanged', 'revoked_by_finalization');--> statement-breakpoint
CREATE TYPE "public"."financial_issue_impact" AS ENUM('pending', 'exception', 'informational');--> statement-breakpoint
CREATE TYPE "public"."financial_issue_state" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."refund_allocation_draft_state" AS ENUM('active', 'finalized', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."refund_correction_domain" AS ENUM('presentment', 'settlement');--> statement-breakpoint
CREATE TYPE "public"."refund_correction_kind" AS ENUM('allocation_attribution_correction', 'classifier_rebase');--> statement-breakpoint
CREATE TYPE "public"."stripe_balance_transaction_source_family" AS ENUM('charge', 'refund', 'dispute', 'payout', 'adjustment', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."stripe_balance_transaction_status" AS ENUM('pending', 'available');--> statement-breakpoint
CREATE TYPE "public"."financial_classification" AS ENUM('charge', 'refund', 'refund_failure', 'dispute_withdrawal', 'dispute_reinstatement', 'payout', 'processing_fee', 'refund_fee', 'dispute_fee', 'provider_fee_tax', 'fee_credit', 'other', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."financial_classification_subject_type" AS ENUM('balance_transaction', 'fee_detail');--> statement-breakpoint
CREATE TYPE "public"."financial_scan_state" AS ENUM('running', 'completed', 'exception');--> statement-breakpoint
CREATE TYPE "public"."payout_import_state" AS ENUM('collecting', 'publishable', 'published', 'abandoned', 'exception');--> statement-breakpoint
CREATE TYPE "public"."stripe_payout_method" AS ENUM('standard', 'instant', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."stripe_payout_reconciliation_status" AS ENUM('completed', 'in_progress', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."stripe_payout_status" AS ENUM('pending', 'in_transit', 'paid', 'failed', 'canceled');--> statement-breakpoint
ALTER TABLE "public"."entitlement_grants" DROP CONSTRAINT "grants_source_consistent";--> statement-breakpoint
DROP INDEX "public"."entitlement_grants_purchase_item_unique";--> statement-breakpoint
DROP INDEX "public"."entitlement_grants_preserved_user_title_unique";--> statement-breakpoint
ALTER TYPE "public"."entitlement_grant_source" RENAME TO "entitlement_grant_source_legacy";--> statement-breakpoint
CREATE TYPE "public"."entitlement_grant_source" AS ENUM('purchase', 'preserved', 'administrative');--> statement-breakpoint
ALTER TABLE "public"."entitlement_grants"
	ALTER COLUMN "source" TYPE "public"."entitlement_grant_source"
	USING "source"::text::"public"."entitlement_grant_source";--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_grants_purchase_item_unique" ON "entitlement_grants" USING btree ("order_item_id") WHERE "entitlement_grants"."source" = 'purchase';--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_grants_preserved_user_title_unique" ON "entitlement_grants" USING btree ("user_id","title_id") WHERE "entitlement_grants"."source" = 'preserved';--> statement-breakpoint
CREATE TABLE "dispute_item_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"allocation_identity" varchar(255) NOT NULL,
	"dispute_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"effect" "dispute_allocation_effect" NOT NULL,
	"reverses_allocation_id" uuid,
	"subtotal_effect_minor" integer NOT NULL,
	"tax_effect_minor" integer NOT NULL,
	"total_effect_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dispute_item_allocations_money_bounded" CHECK ("dispute_item_allocations"."subtotal_effect_minor" between -99999999 and 99999999 and "dispute_item_allocations"."tax_effect_minor" between -99999999 and 99999999 and "dispute_item_allocations"."total_effect_minor" between -99999999 and 99999999),
	CONSTRAINT "dispute_item_allocations_total_consistent" CHECK ("dispute_item_allocations"."total_effect_minor" = "dispute_item_allocations"."subtotal_effect_minor" + "dispute_item_allocations"."tax_effect_minor"),
	CONSTRAINT "dispute_item_allocations_currency_iso" CHECK ("dispute_item_allocations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "dispute_item_allocations_reversal_consistent" CHECK (("dispute_item_allocations"."effect" = 'reinstatement') = ("dispute_item_allocations"."reverses_allocation_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "financial_allocation_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"allocation_identity" varchar(255) NOT NULL,
	"balance_transaction_id" uuid NOT NULL,
	"source_kind" "financial_allocation_source_kind" NOT NULL,
	"source_internal_id" uuid NOT NULL,
	"basis" "financial_allocation_basis" NOT NULL,
	"scope" "financial_allocation_scope" NOT NULL,
	"expected_effect_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"algorithm_version" integer NOT NULL,
	"classifier_version" integer NOT NULL,
	"source_fingerprint_sha256" varchar(64) NOT NULL,
	"supersedes_set_id" uuid,
	"reversal_of_set_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_allocation_sets_supersession_identity_unique" UNIQUE("id","balance_transaction_id","source_kind","source_internal_id","basis","currency","expected_effect_minor","source_fingerprint_sha256"),
	CONSTRAINT "financial_allocation_sets_reversal_identity_unique" UNIQUE("id","source_kind","source_internal_id","basis","currency"),
	CONSTRAINT "financial_allocation_sets_effect_bounded" CHECK ("financial_allocation_sets"."expected_effect_minor" between -99999999 and 99999999),
	CONSTRAINT "financial_allocation_sets_currency_iso" CHECK ("financial_allocation_sets"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "financial_allocation_sets_versions_positive" CHECK ("financial_allocation_sets"."algorithm_version" > 0 and "financial_allocation_sets"."classifier_version" > 0),
	CONSTRAINT "financial_allocation_sets_fingerprint_sha256" CHECK ("financial_allocation_sets"."source_fingerprint_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "financial_allocation_sets_identity_safe" CHECK (char_length("financial_allocation_sets"."allocation_identity") > 0),
	CONSTRAINT "financial_allocation_sets_chain_consistent" CHECK (("financial_allocation_sets"."supersedes_set_id" is null or "financial_allocation_sets"."supersedes_set_id" <> "financial_allocation_sets"."id") and ("financial_allocation_sets"."reversal_of_set_id" is null or "financial_allocation_sets"."reversal_of_set_id" <> "financial_allocation_sets"."id") and ("financial_allocation_sets"."supersedes_set_id" is null or "financial_allocation_sets"."reversal_of_set_id" is null or "financial_allocation_sets"."supersedes_set_id" <> "financial_allocation_sets"."reversal_of_set_id"))
);
--> statement-breakpoint
CREATE TABLE "financial_item_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"allocation_set_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"component" "financial_component" NOT NULL,
	"effect_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"tie_break_key" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_item_allocations_effect_bounded" CHECK ("financial_item_allocations"."effect_minor" between -99999999 and 99999999),
	CONSTRAINT "financial_item_allocations_currency_iso" CHECK ("financial_item_allocations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "financial_item_allocations_tie_key_safe" CHECK (char_length("financial_item_allocations"."tie_break_key") between 1 and 255)
);
--> statement-breakpoint
CREATE TABLE "financial_reconciliation_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_type" varchar(50) NOT NULL,
	"resource_id" uuid NOT NULL,
	"safe_code" varchar(100) NOT NULL,
	"state" "financial_issue_state" DEFAULT 'open' NOT NULL,
	"impact" "financial_issue_impact" NOT NULL,
	"first_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"correlation_id" varchar(100) NOT NULL,
	"resolved_by_admin_id" uuid,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "financial_reconciliation_issues_occurrence_positive" CHECK ("financial_reconciliation_issues"."occurrence_count" > 0),
	CONSTRAINT "financial_reconciliation_issues_resolution_consistent" CHECK (("financial_reconciliation_issues"."state" = 'resolved') = ("financial_reconciliation_issues"."resolved_at" is not null) and ("financial_reconciliation_issues"."resolved_by_admin_id" is null or "financial_reconciliation_issues"."state" = 'resolved')),
	CONSTRAINT "financial_reconciliation_issues_safe_vocabulary" CHECK ("financial_reconciliation_issues"."resource_type" ~ '^[a-z0-9_]{1,50}$' and "financial_reconciliation_issues"."safe_code" ~ '^[a-z0-9_]{1,100}$' and char_length("financial_reconciliation_issues"."correlation_id") between 1 and 100),
	CONSTRAINT "financial_reconciliation_issues_observation_order" CHECK ("financial_reconciliation_issues"."last_observed_at" >= "financial_reconciliation_issues"."first_observed_at")
);
--> statement-breakpoint
CREATE TABLE "refund_allocation_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_allocation_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"subtotal_minor" integer NOT NULL,
	"tax_minor" integer NOT NULL,
	"total_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_allocation_components_money_nonnegative" CHECK ("refund_allocation_components"."subtotal_minor" between 0 and 99999999 and "refund_allocation_components"."tax_minor" between 0 and 99999999 and "refund_allocation_components"."total_minor" between 0 and 99999999),
	CONSTRAINT "refund_allocation_components_total_consistent" CHECK ("refund_allocation_components"."total_minor" = "refund_allocation_components"."subtotal_minor" + "refund_allocation_components"."tax_minor"),
	CONSTRAINT "refund_allocation_components_currency_iso" CHECK ("refund_allocation_components"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "refund_allocation_draft_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"proposed_total_presentment_minor" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_allocation_draft_items_draft_item_unique" UNIQUE("draft_id","order_item_id"),
	CONSTRAINT "refund_allocation_draft_items_amount_bounded" CHECK ("refund_allocation_draft_items"."proposed_total_presentment_minor" between 0 and 99999999)
);
--> statement-breakpoint
CREATE TABLE "refund_allocation_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_id" uuid NOT NULL,
	"state" "refund_allocation_draft_state" DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_admin_id" uuid NOT NULL,
	"updated_by_admin_id" uuid NOT NULL,
	"created_correlation_id" varchar(100) NOT NULL,
	"updated_correlation_id" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	"discarded_at" timestamp with time zone,
	CONSTRAINT "refund_allocation_drafts_refund_version_unique" UNIQUE("id","refund_id","version"),
	CONSTRAINT "refund_allocation_drafts_version_positive" CHECK ("refund_allocation_drafts"."version" > 0),
	CONSTRAINT "refund_allocation_drafts_correlation_safe" CHECK (char_length("refund_allocation_drafts"."created_correlation_id") between 1 and 100 and char_length("refund_allocation_drafts"."updated_correlation_id") between 1 and 100),
	CONSTRAINT "refund_allocation_drafts_lifecycle_consistent" CHECK ((
        "refund_allocation_drafts"."state" = 'active' and "refund_allocation_drafts"."finalized_at" is null and "refund_allocation_drafts"."discarded_at" is null
      ) or (
        "refund_allocation_drafts"."state" = 'finalized' and "refund_allocation_drafts"."finalized_at" is not null and "refund_allocation_drafts"."discarded_at" is null
      ) or (
        "refund_allocation_drafts"."state" = 'discarded' and "refund_allocation_drafts"."finalized_at" is null and "refund_allocation_drafts"."discarded_at" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "refund_allocation_finalization_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_id" uuid NOT NULL,
	"refund_allocation_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"draft_version" integer NOT NULL,
	"order_item_id" uuid NOT NULL,
	"purchase_grant_id" uuid NOT NULL,
	"before_purchase_grant_state" "entitlement_grant_status" NOT NULL,
	"after_purchase_grant_state" "entitlement_grant_status" NOT NULL,
	"before_effective_access" boolean NOT NULL,
	"after_effective_access" boolean NOT NULL,
	"transition" "financial_finalization_transition" NOT NULL,
	"correlation_id" varchar(100) NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_allocation_finalization_effects_draft_version_positive" CHECK ("refund_allocation_finalization_effects"."draft_version" > 0),
	CONSTRAINT "refund_allocation_finalization_effects_transition_consistent" CHECK ((
        "refund_allocation_finalization_effects"."transition" = 'unchanged' and
        "refund_allocation_finalization_effects"."before_purchase_grant_state" = "refund_allocation_finalization_effects"."after_purchase_grant_state" and
        "refund_allocation_finalization_effects"."before_effective_access" = "refund_allocation_finalization_effects"."after_effective_access"
      ) or (
        "refund_allocation_finalization_effects"."transition" = 'revoked_by_finalization' and "refund_allocation_finalization_effects"."before_purchase_grant_state" <> 'revoked' and "refund_allocation_finalization_effects"."after_purchase_grant_state" = 'revoked'
      )),
	CONSTRAINT "refund_allocation_finalization_effects_correlation_safe" CHECK (char_length("refund_allocation_finalization_effects"."correlation_id") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "refund_reporting_correction_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correction_set_id" uuid NOT NULL,
	"domain" "refund_correction_domain" NOT NULL,
	"source_allocation_set_id" uuid,
	"order_item_id" uuid NOT NULL,
	"component" "financial_component" NOT NULL,
	"currency" varchar(3) NOT NULL,
	"approved_absolute_minor" integer NOT NULL,
	"delta_minor" integer NOT NULL,
	"stable_tie_break_key" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_reporting_correction_items_domain_source_consistent" CHECK (("refund_reporting_correction_items"."domain" = 'presentment') = ("refund_reporting_correction_items"."source_allocation_set_id" is null)),
	CONSTRAINT "refund_reporting_correction_items_component_consistent" CHECK ((
        "refund_reporting_correction_items"."domain" = 'presentment' and
        "refund_reporting_correction_items"."component" in ('refund_subtotal', 'refund_tax')
      ) or (
        "refund_reporting_correction_items"."domain" = 'settlement' and
        "refund_reporting_correction_items"."component" in ('refund_subtotal', 'refund_tax', 'refund_fee')
      )),
	CONSTRAINT "refund_reporting_correction_items_money_bounded" CHECK ("refund_reporting_correction_items"."approved_absolute_minor" between -99999999 and 99999999 and "refund_reporting_correction_items"."delta_minor" between -99999999 and 99999999),
	CONSTRAINT "refund_reporting_correction_items_currency_iso" CHECK ("refund_reporting_correction_items"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "refund_reporting_correction_items_tie_key_safe" CHECK (char_length("refund_reporting_correction_items"."stable_tie_break_key") between 1 and 255)
);
--> statement-breakpoint
CREATE TABLE "refund_reporting_correction_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_id" uuid NOT NULL,
	"correction_version" integer NOT NULL,
	"kind" "refund_correction_kind" NOT NULL,
	"base_allocation_set_id" uuid NOT NULL,
	"predecessor_correction_set_id" uuid,
	"source_fingerprint_sha256" varchar(64) NOT NULL,
	"approved_by_admin_id" uuid NOT NULL,
	"created_by_admin_id" uuid,
	"correlation_id" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_reporting_correction_sets_graph_identity_unique" UNIQUE("id","refund_id"),
	CONSTRAINT "refund_reporting_correction_sets_version_positive" CHECK ("refund_reporting_correction_sets"."correction_version" > 0),
	CONSTRAINT "refund_reporting_correction_sets_fingerprint_sha256" CHECK ("refund_reporting_correction_sets"."source_fingerprint_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "refund_reporting_correction_sets_creator_consistent" CHECK (("refund_reporting_correction_sets"."kind" = 'allocation_attribution_correction' and "refund_reporting_correction_sets"."created_by_admin_id" is not null) or ("refund_reporting_correction_sets"."kind" = 'classifier_rebase' and "refund_reporting_correction_sets"."created_by_admin_id" is null)),
	CONSTRAINT "refund_reporting_correction_sets_correlation_safe" CHECK (char_length("refund_reporting_correction_sets"."correlation_id") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "financial_classification_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" "financial_classification_subject_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"classifier_version" integer NOT NULL,
	"classification" "financial_classification" NOT NULL,
	"source_fingerprint_sha256" varchar(64) NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_classification_versions_version_positive" CHECK ("financial_classification_versions"."classifier_version" > 0),
	CONSTRAINT "financial_classification_versions_fingerprint_sha256" CHECK ("financial_classification_versions"."source_fingerprint_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "financial_scan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"root_key" varchar(512) NOT NULL,
	"kind" varchar(50) NOT NULL,
	"phase" varchar(50) NOT NULL,
	"state" "financial_scan_state" DEFAULT 'running' NOT NULL,
	"classifier_version" integer,
	"allocation_algorithm_version" integer,
	"replay_id" varchar(50),
	"checkpoint" varchar(255),
	"cursor_digest_sha256" varchar(64),
	"processed_count" integer DEFAULT 0 NOT NULL,
	"enqueued_count" integer DEFAULT 0 NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	"safe_outcome" varchar(100),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "financial_scan_runs_counts_nonnegative" CHECK ("financial_scan_runs"."processed_count" >= 0 and "financial_scan_runs"."enqueued_count" >= 0 and "financial_scan_runs"."page_count" >= 0),
	CONSTRAINT "financial_scan_runs_checkpoint_bounded" CHECK ("financial_scan_runs"."checkpoint" is null or char_length("financial_scan_runs"."checkpoint") between 1 and 255),
	CONSTRAINT "financial_scan_runs_cursor_digest_sha256" CHECK ("financial_scan_runs"."cursor_digest_sha256" is null or "financial_scan_runs"."cursor_digest_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "financial_scan_runs_vocabulary_safe" CHECK ("financial_scan_runs"."kind" ~ '^[a-z0-9_-]{1,50}$' and "financial_scan_runs"."phase" ~ '^[a-z0-9_-]{1,50}$' and ("financial_scan_runs"."safe_outcome" is null or "financial_scan_runs"."safe_outcome" ~ '^[a-z0-9_]{1,100}$')),
	CONSTRAINT "financial_scan_runs_replay_consistent" CHECK ((
        "financial_scan_runs"."classifier_version" is null and "financial_scan_runs"."allocation_algorithm_version" is null and "financial_scan_runs"."replay_id" is null
      ) or (
        "financial_scan_runs"."classifier_version" is not null and
        "financial_scan_runs"."allocation_algorithm_version" is not null and
        "financial_scan_runs"."replay_id" is not null and
        "financial_scan_runs"."classifier_version" > 0 and "financial_scan_runs"."allocation_algorithm_version" > 0 and
        "financial_scan_runs"."replay_id" = 'c' || "financial_scan_runs"."classifier_version"::text || '-a' || "financial_scan_runs"."allocation_algorithm_version"::text
      )),
	CONSTRAINT "financial_scan_runs_lifecycle_consistent" CHECK (("financial_scan_runs"."state" in ('completed', 'exception')) = ("financial_scan_runs"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "payout_import_run_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"balance_transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout_import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"state" "payout_import_state" DEFAULT 'collecting' NOT NULL,
	"next_starting_after" varchar(255),
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	"safe_outcome" varchar(100),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "payout_import_runs_graph_identity_unique" UNIQUE("id","payout_id"),
	CONSTRAINT "payout_import_runs_generation_bounded" CHECK ("payout_import_runs"."generation" between 0 and 2147483647),
	CONSTRAINT "payout_import_runs_counts_nonnegative" CHECK ("payout_import_runs"."candidate_count" >= 0 and "payout_import_runs"."page_count" >= 0),
	CONSTRAINT "payout_import_runs_cursor_bounded" CHECK ("payout_import_runs"."next_starting_after" is null or char_length("payout_import_runs"."next_starting_after") between 1 and 255),
	CONSTRAINT "payout_import_runs_outcome_safe" CHECK ("payout_import_runs"."safe_outcome" is null or "payout_import_runs"."safe_outcome" ~ '^[a-z0-9_]{1,100}$'),
	CONSTRAINT "payout_import_runs_lifecycle_consistent" CHECK (("payout_import_runs"."state" in ('published', 'abandoned', 'exception')) = ("payout_import_runs"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "stripe_balance_transaction_fee_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"balance_transaction_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"raw_type" varchar(100) NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"fingerprint_sha256" varchar(64) NOT NULL,
	CONSTRAINT "stripe_balance_transaction_fee_details_ordinal_nonnegative" CHECK ("stripe_balance_transaction_fee_details"."ordinal" >= 0),
	CONSTRAINT "stripe_balance_transaction_fee_details_amount_bounded" CHECK ("stripe_balance_transaction_fee_details"."amount_minor" between 0 and 99999999),
	CONSTRAINT "stripe_balance_transaction_fee_details_currency_iso" CHECK ("stripe_balance_transaction_fee_details"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "stripe_balance_transaction_fee_details_type_safe" CHECK (char_length("stripe_balance_transaction_fee_details"."raw_type") > 0),
	CONSTRAINT "stripe_balance_transaction_fee_details_fingerprint_sha256" CHECK ("stripe_balance_transaction_fee_details"."fingerprint_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "stripe_balance_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" varchar(255) NOT NULL,
	"live_mode" boolean NOT NULL,
	"source_family" "stripe_balance_transaction_source_family",
	"source_id" varchar(255),
	"raw_type" varchar(100) NOT NULL,
	"reporting_category" varchar(100) NOT NULL,
	"balance_type" varchar(100) NOT NULL,
	"amount_minor" integer NOT NULL,
	"fee_minor" integer NOT NULL,
	"net_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" "stripe_balance_transaction_status" NOT NULL,
	"provider_created_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"exchange_rate" numeric(38, 18),
	"exchange_source_currency" varchar(3),
	"exchange_target_currency" varchar(3),
	"fingerprint_sha256" varchar(64) NOT NULL,
	"first_imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_balance_transactions_money_bounded" CHECK ("stripe_balance_transactions"."amount_minor" between -99999999 and 99999999 and "stripe_balance_transactions"."fee_minor" between 0 and 99999999 and "stripe_balance_transactions"."net_minor" between -99999999 and 99999999),
	CONSTRAINT "stripe_balance_transactions_fee_nonnegative" CHECK ("stripe_balance_transactions"."fee_minor" >= 0),
	CONSTRAINT "stripe_balance_transactions_net_consistent" CHECK ("stripe_balance_transactions"."net_minor" = "stripe_balance_transactions"."amount_minor" - "stripe_balance_transactions"."fee_minor"),
	CONSTRAINT "stripe_balance_transactions_currency_iso" CHECK ("stripe_balance_transactions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "stripe_balance_transactions_source_consistent" CHECK ("stripe_balance_transactions"."source_id" is null or ("stripe_balance_transactions"."source_family" is not null and char_length("stripe_balance_transactions"."source_id") between 1 and 255)),
	CONSTRAINT "stripe_balance_transactions_provider_fields_safe" CHECK (char_length("stripe_balance_transactions"."provider_id") > 0 and char_length("stripe_balance_transactions"."raw_type") > 0 and char_length("stripe_balance_transactions"."reporting_category") > 0 and char_length("stripe_balance_transactions"."balance_type") > 0),
	CONSTRAINT "stripe_balance_transactions_exchange_evidence_consistent" CHECK ((
        "stripe_balance_transactions"."exchange_rate" is null and "stripe_balance_transactions"."exchange_source_currency" is null and "stripe_balance_transactions"."exchange_target_currency" is null
      ) or (
        "stripe_balance_transactions"."exchange_rate" is not null and
        "stripe_balance_transactions"."exchange_source_currency" is not null and
        "stripe_balance_transactions"."exchange_target_currency" is not null and
        "stripe_balance_transactions"."exchange_rate" > 0 and
        "stripe_balance_transactions"."exchange_source_currency" ~ '^[A-Z]{3}$' and
        "stripe_balance_transactions"."exchange_target_currency" ~ '^[A-Z]{3}$' and
        "stripe_balance_transactions"."exchange_target_currency" = "stripe_balance_transactions"."currency" and
        "stripe_balance_transactions"."exchange_source_currency" <> "stripe_balance_transactions"."exchange_target_currency"
      )),
	CONSTRAINT "stripe_balance_transactions_fingerprint_sha256" CHECK ("stripe_balance_transactions"."fingerprint_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "stripe_balance_transactions_import_timestamp_order" CHECK ("stripe_balance_transactions"."last_imported_at" >= "stripe_balance_transactions"."first_imported_at")
);
--> statement-breakpoint
CREATE TABLE "stripe_payout_balance_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"balance_transaction_id" uuid NOT NULL,
	"published_from_run_id" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" varchar(255) NOT NULL,
	"live_mode" boolean NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"automatic" boolean NOT NULL,
	"method" "stripe_payout_method" NOT NULL,
	"status" "stripe_payout_status" NOT NULL,
	"reconciliation_status" "stripe_payout_reconciliation_status" NOT NULL,
	"provider_created_at" timestamp with time zone NOT NULL,
	"arrival_at" timestamp with time zone NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"balance_transaction_id" uuid,
	"failure_balance_transaction_id" uuid,
	"original_provider_payout_id" varchar(255),
	"reversed_by_provider_payout_id" varchar(255),
	"safe_failure_code" varchar(100),
	"financial_generation" integer DEFAULT 0 NOT NULL,
	"fingerprint_sha256" varchar(64) NOT NULL,
	CONSTRAINT "stripe_payouts_amount_bounded" CHECK ("stripe_payouts"."amount_minor" between -99999999 and 99999999),
	CONSTRAINT "stripe_payouts_currency_iso" CHECK ("stripe_payouts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "stripe_payouts_generation_bounded" CHECK ("stripe_payouts"."financial_generation" between 0 and 2147483647),
	CONSTRAINT "stripe_payouts_failure_code_safe" CHECK ("stripe_payouts"."safe_failure_code" is null or "stripe_payouts"."safe_failure_code" ~ '^[a-z0-9_]{1,100}$'),
	CONSTRAINT "stripe_payouts_fingerprint_sha256" CHECK ("stripe_payouts"."fingerprint_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "stripe_payouts_linked_transactions_distinct" CHECK ("stripe_payouts"."balance_transaction_id" is null or "stripe_payouts"."failure_balance_transaction_id" is null or "stripe_payouts"."balance_transaction_id" <> "stripe_payouts"."failure_balance_transaction_id"),
	CONSTRAINT "stripe_payouts_related_ids_safe" CHECK (("stripe_payouts"."original_provider_payout_id" is null or (char_length("stripe_payouts"."original_provider_payout_id") > 0 and "stripe_payouts"."original_provider_payout_id" <> "stripe_payouts"."provider_id")) and ("stripe_payouts"."reversed_by_provider_payout_id" is null or (char_length("stripe_payouts"."reversed_by_provider_payout_id") > 0 and "stripe_payouts"."reversed_by_provider_payout_id" <> "stripe_payouts"."provider_id"))),
	CONSTRAINT "stripe_payouts_reconciliation_supported" CHECK ("stripe_payouts"."reconciliation_status" = 'not_applicable' or ("stripe_payouts"."automatic" and "stripe_payouts"."method" = 'standard'))
);
--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "financial_evidence_status" "financial_evidence_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD COLUMN "recovery_refund_allocation_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "financial_evidence_status" "financial_evidence_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "allocation_status" "refund_allocation_status" DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "financial_evidence_status" "financial_evidence_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
LOCK TABLE "payments", "refunds", "refund_allocations", "disputes", "orders", "order_items" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "refund_allocations" allocation
    JOIN "refunds" refund ON refund.id = allocation.refund_id
    WHERE refund.status IN ('pending', 'failed', 'canceled')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Plan 6B non-succeeded refund status cannot retain legacy refund allocations';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "refund_allocations" allocation
    JOIN "refunds" refund ON refund.id = allocation.refund_id
    JOIN "payments" payment ON payment.id = refund.payment_id
    JOIN "order_items" item ON item.id = allocation.order_item_id
    WHERE item.order_id <> payment.order_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Plan 6B partial/incomplete allocation facts: refund allocation is outside the payment order';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "refund_allocations" allocation
    JOIN "refunds" refund ON refund.id = allocation.refund_id
    JOIN "order_items" item ON item.id = allocation.order_item_id
    WHERE refund.currency <> item.currency
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Plan 6B currency/cross-currency refund allocation cannot be migrated';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "refund_allocations" allocation
    JOIN "order_items" item ON item.id = allocation.order_item_id
    WHERE item.tax_minor IS NULL
       OR item.total_minor IS NULL
       OR item.total_minor <> item.unit_subtotal_minor + item.tax_minor
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Plan 6B partial/incomplete allocation facts: finalized order-item totals are required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "refund_allocations" allocation
    JOIN "refunds" refund ON refund.id = allocation.refund_id
    WHERE refund.status = 'succeeded'
    GROUP BY refund.id, refund.amount_minor
    HAVING sum(allocation.amount_minor)::bigint > refund.amount_minor::bigint
  ) OR EXISTS (
    SELECT 1
    FROM "refund_allocations" allocation
    JOIN "order_items" item ON item.id = allocation.order_item_id
    JOIN "refunds" refund ON refund.id = allocation.refund_id
    WHERE refund.status = 'succeeded'
    GROUP BY item.id, item.total_minor
    HAVING sum(allocation.amount_minor)::bigint > item.total_minor::bigint
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Plan 6B over-allocation/capacity violation in legacy refund graph';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "refunds" refund
    WHERE refund.status = 'succeeded'
      AND EXISTS (SELECT 1 FROM "refund_allocations" allocation WHERE allocation.refund_id = refund.id)
      AND coalesce((SELECT sum(allocation.amount_minor)::bigint FROM "refund_allocations" allocation WHERE allocation.refund_id = refund.id), 0::bigint) <> refund.amount_minor::bigint
  ) OR EXISTS (
    SELECT 1
    FROM "refunds" refund
    WHERE refund.status = 'succeeded'
      AND NOT EXISTS (SELECT 1 FROM "refund_allocations" allocation WHERE allocation.refund_id = refund.id)
      AND (SELECT count(*) FROM "order_items" item JOIN "payments" payment ON payment.order_id = item.order_id WHERE payment.id = refund.payment_id) <= 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Plan 6B partial/incomplete allocation facts cannot be migrated';
  END IF;
END;
$$;--> statement-breakpoint
UPDATE "payments" payment
SET "financial_evidence_status" = CASE
  WHEN payment.reconciliation_status IN ('pending', 'reconciled') THEN 'pending'::financial_evidence_status
  WHEN payment.reconciliation_status = 'exception'
    AND EXISTS (
      SELECT 1 FROM "orders" purchase_order
      WHERE purchase_order.id = payment.order_id
        AND purchase_order.status = 'paid'
        AND purchase_order.total_minor IS NOT NULL
        AND (purchase_order.currency <> payment.currency OR purchase_order.total_minor <> payment.amount_minor)
    ) THEN 'exception'::financial_evidence_status
  ELSE 'pending'::financial_evidence_status
END;--> statement-breakpoint
UPDATE "disputes" dispute
SET "financial_evidence_status" = CASE
  WHEN dispute.reconciliation_status IN ('pending', 'reconciled') THEN 'pending'::financial_evidence_status
  WHEN dispute.reconciliation_status = 'exception'
    AND EXISTS (
      SELECT 1 FROM "payments" payment
      WHERE payment.id = dispute.payment_id
        AND (payment.currency <> dispute.currency OR dispute.amount_minor > payment.amount_minor)
    ) THEN 'exception'::financial_evidence_status
  ELSE 'pending'::financial_evidence_status
END;--> statement-breakpoint
UPDATE "refunds" refund
SET
  "allocation_status" = CASE
    WHEN refund.status <> 'succeeded' THEN 'not_applicable'::refund_allocation_status
    WHEN coalesce((SELECT sum(allocation.amount_minor)::bigint FROM "refund_allocations" allocation WHERE allocation.refund_id = refund.id), 0::bigint) = refund.amount_minor::bigint
      THEN 'finalized'::refund_allocation_status
    WHEN NOT EXISTS (SELECT 1 FROM "refund_allocations" allocation WHERE allocation.refund_id = refund.id)
      AND (SELECT count(*) FROM "order_items" item JOIN "payments" payment ON payment.order_id = item.order_id WHERE payment.id = refund.payment_id) > 1
      THEN 'needs_review'::refund_allocation_status
    ELSE 'exception'::refund_allocation_status
  END,
  "financial_evidence_status" = CASE
    WHEN refund.reconciliation_status IN ('pending', 'reconciled') THEN 'pending'::financial_evidence_status
    WHEN refund.status = 'succeeded'
      AND NOT EXISTS (SELECT 1 FROM "refund_allocations" allocation WHERE allocation.refund_id = refund.id)
      AND (SELECT count(*) FROM "order_items" item JOIN "payments" payment ON payment.order_id = item.order_id WHERE payment.id = refund.payment_id) > 1
      THEN 'pending'::financial_evidence_status
    WHEN refund.reconciliation_status = 'exception'
      AND EXISTS (
        SELECT 1 FROM "payments" payment
        WHERE payment.id = refund.payment_id
          AND (payment.currency <> refund.currency OR refund.amount_minor > payment.amount_minor)
      ) THEN 'exception'::financial_evidence_status
    ELSE 'pending'::financial_evidence_status
  END;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_purchase_provenance_unique" UNIQUE("id","order_item_id");--> statement-breakpoint
ALTER TABLE "refund_allocations" ADD CONSTRAINT "refund_allocations_provenance_unique" UNIQUE("id","refund_id","order_item_id");--> statement-breakpoint
ALTER TABLE "dispute_item_allocations" ADD CONSTRAINT "dispute_item_allocations_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_item_allocations" ADD CONSTRAINT "dispute_item_allocations_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_item_allocations" ADD CONSTRAINT "dispute_item_allocations_reverses_allocation_id_dispute_item_allocations_id_fk" FOREIGN KEY ("reverses_allocation_id") REFERENCES "public"."dispute_item_allocations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_allocation_sets" ADD CONSTRAINT "financial_allocation_sets_balance_transaction_id_stripe_balance_transactions_id_fk" FOREIGN KEY ("balance_transaction_id") REFERENCES "public"."stripe_balance_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_allocation_sets" ADD CONSTRAINT "financial_allocation_sets_supersedes_set_id_financial_allocation_sets_id_fk" FOREIGN KEY ("supersedes_set_id") REFERENCES "public"."financial_allocation_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_allocation_sets" ADD CONSTRAINT "financial_allocation_sets_reversal_of_set_id_financial_allocation_sets_id_fk" FOREIGN KEY ("reversal_of_set_id") REFERENCES "public"."financial_allocation_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_allocation_sets" ADD CONSTRAINT "financial_allocation_sets_supersedes_graph_fk" FOREIGN KEY ("supersedes_set_id","balance_transaction_id","source_kind","source_internal_id","basis","currency","expected_effect_minor","source_fingerprint_sha256") REFERENCES "public"."financial_allocation_sets"("id","balance_transaction_id","source_kind","source_internal_id","basis","currency","expected_effect_minor","source_fingerprint_sha256") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_allocation_sets" ADD CONSTRAINT "financial_allocation_sets_reversal_graph_fk" FOREIGN KEY ("reversal_of_set_id","source_kind","source_internal_id","basis","currency") REFERENCES "public"."financial_allocation_sets"("id","source_kind","source_internal_id","basis","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_item_allocations" ADD CONSTRAINT "financial_item_allocations_allocation_set_id_financial_allocation_sets_id_fk" FOREIGN KEY ("allocation_set_id") REFERENCES "public"."financial_allocation_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_item_allocations" ADD CONSTRAINT "financial_item_allocations_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_reconciliation_issues" ADD CONSTRAINT "financial_reconciliation_issues_resolved_by_admin_id_user_id_fk" FOREIGN KEY ("resolved_by_admin_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocation_components" ADD CONSTRAINT "refund_allocation_components_graph_fk" FOREIGN KEY ("refund_allocation_id","refund_id","order_item_id") REFERENCES "public"."refund_allocations"("id","refund_id","order_item_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocation_draft_items" ADD CONSTRAINT "refund_allocation_draft_items_draft_id_refund_allocation_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."refund_allocation_drafts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocation_draft_items" ADD CONSTRAINT "refund_allocation_draft_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocation_drafts" ADD CONSTRAINT "refund_allocation_drafts_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocation_drafts" ADD CONSTRAINT "refund_allocation_drafts_created_by_admin_id_user_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocation_drafts" ADD CONSTRAINT "refund_allocation_drafts_updated_by_admin_id_user_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocation_finalization_effects" ADD CONSTRAINT "refund_allocation_finalization_effects_allocation_graph_fk" FOREIGN KEY ("refund_allocation_id","refund_id","order_item_id") REFERENCES "public"."refund_allocations"("id","refund_id","order_item_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocation_finalization_effects" ADD CONSTRAINT "refund_allocation_finalization_effects_draft_version_fk" FOREIGN KEY ("draft_id","refund_id","draft_version") REFERENCES "public"."refund_allocation_drafts"("id","refund_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocation_finalization_effects" ADD CONSTRAINT "refund_allocation_finalization_effects_draft_item_fk" FOREIGN KEY ("draft_id","order_item_id") REFERENCES "public"."refund_allocation_draft_items"("draft_id","order_item_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocation_finalization_effects" ADD CONSTRAINT "refund_allocation_finalization_effects_purchase_grant_fk" FOREIGN KEY ("purchase_grant_id","order_item_id") REFERENCES "public"."entitlement_grants"("id","order_item_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_reporting_correction_items" ADD CONSTRAINT "refund_reporting_correction_items_correction_set_id_refund_reporting_correction_sets_id_fk" FOREIGN KEY ("correction_set_id") REFERENCES "public"."refund_reporting_correction_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_reporting_correction_items" ADD CONSTRAINT "refund_reporting_correction_items_source_allocation_set_id_financial_allocation_sets_id_fk" FOREIGN KEY ("source_allocation_set_id") REFERENCES "public"."financial_allocation_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_reporting_correction_items" ADD CONSTRAINT "refund_reporting_correction_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_reporting_correction_sets" ADD CONSTRAINT "refund_reporting_correction_sets_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_reporting_correction_sets" ADD CONSTRAINT "refund_reporting_correction_sets_base_allocation_set_id_financial_allocation_sets_id_fk" FOREIGN KEY ("base_allocation_set_id") REFERENCES "public"."financial_allocation_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_reporting_correction_sets" ADD CONSTRAINT "refund_reporting_correction_sets_approved_by_admin_id_user_id_fk" FOREIGN KEY ("approved_by_admin_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_reporting_correction_sets" ADD CONSTRAINT "refund_reporting_correction_sets_created_by_admin_id_user_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_reporting_correction_sets" ADD CONSTRAINT "refund_reporting_correction_sets_predecessor_graph_fk" FOREIGN KEY ("predecessor_correction_set_id","refund_id") REFERENCES "public"."refund_reporting_correction_sets"("id","refund_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_import_run_entries" ADD CONSTRAINT "payout_import_run_entries_run_id_payout_import_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payout_import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_import_run_entries" ADD CONSTRAINT "payout_import_run_entries_balance_transaction_id_stripe_balance_transactions_id_fk" FOREIGN KEY ("balance_transaction_id") REFERENCES "public"."stripe_balance_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_import_runs" ADD CONSTRAINT "payout_import_runs_payout_id_stripe_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."stripe_payouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_balance_transaction_fee_details" ADD CONSTRAINT "stripe_balance_transaction_fee_details_balance_transaction_id_stripe_balance_transactions_id_fk" FOREIGN KEY ("balance_transaction_id") REFERENCES "public"."stripe_balance_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_payout_balance_transactions" ADD CONSTRAINT "stripe_payout_balance_transactions_payout_id_stripe_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."stripe_payouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_payout_balance_transactions" ADD CONSTRAINT "stripe_payout_balance_transactions_balance_transaction_id_stripe_balance_transactions_id_fk" FOREIGN KEY ("balance_transaction_id") REFERENCES "public"."stripe_balance_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_payout_balance_transactions" ADD CONSTRAINT "stripe_payout_balance_transactions_run_payout_fk" FOREIGN KEY ("published_from_run_id","payout_id") REFERENCES "public"."payout_import_runs"("id","payout_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_payouts" ADD CONSTRAINT "stripe_payouts_balance_transaction_id_stripe_balance_transactions_id_fk" FOREIGN KEY ("balance_transaction_id") REFERENCES "public"."stripe_balance_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_payouts" ADD CONSTRAINT "stripe_payouts_failure_balance_transaction_id_stripe_balance_transactions_id_fk" FOREIGN KEY ("failure_balance_transaction_id") REFERENCES "public"."stripe_balance_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_item_allocations_identity_unique" ON "dispute_item_allocations" USING btree ("allocation_identity");--> statement-breakpoint
CREATE INDEX "dispute_item_allocations_dispute_item_idx" ON "dispute_item_allocations" USING btree ("dispute_id","order_item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_allocation_sets_identity_unique" ON "financial_allocation_sets" USING btree ("allocation_identity");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_allocation_sets_root_unique" ON "financial_allocation_sets" USING btree ("balance_transaction_id","basis","source_fingerprint_sha256") WHERE "financial_allocation_sets"."supersedes_set_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_allocation_sets_successor_unique" ON "financial_allocation_sets" USING btree ("supersedes_set_id") WHERE "financial_allocation_sets"."supersedes_set_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_allocation_sets_reversal_root_unique" ON "financial_allocation_sets" USING btree ("reversal_of_set_id") WHERE "financial_allocation_sets"."reversal_of_set_id" is not null and "financial_allocation_sets"."supersedes_set_id" is null;--> statement-breakpoint
CREATE INDEX "financial_allocation_sets_transaction_basis_idx" ON "financial_allocation_sets" USING btree ("balance_transaction_id","basis","created_at","id");--> statement-breakpoint
CREATE INDEX "financial_allocation_sets_source_idx" ON "financial_allocation_sets" USING btree ("source_kind","source_internal_id","id");--> statement-breakpoint
CREATE INDEX "financial_allocation_sets_reversal_idx" ON "financial_allocation_sets" USING btree ("reversal_of_set_id");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_item_allocations_set_item_component_unique" ON "financial_item_allocations" USING btree ("allocation_set_id","order_item_id","component");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_item_allocations_set_tie_key_unique" ON "financial_item_allocations" USING btree ("allocation_set_id","tie_break_key");--> statement-breakpoint
CREATE INDEX "financial_item_allocations_item_idx" ON "financial_item_allocations" USING btree ("order_item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_reconciliation_issues_open_unique" ON "financial_reconciliation_issues" USING btree ("resource_type","resource_id","safe_code") WHERE "financial_reconciliation_issues"."state" = 'open';--> statement-breakpoint
CREATE INDEX "financial_reconciliation_issues_state_observed_idx" ON "financial_reconciliation_issues" USING btree ("state","last_observed_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_allocation_components_allocation_unique" ON "refund_allocation_components" USING btree ("refund_allocation_id");--> statement-breakpoint
CREATE INDEX "refund_allocation_components_refund_item_idx" ON "refund_allocation_components" USING btree ("refund_id","order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_allocation_drafts_active_unique" ON "refund_allocation_drafts" USING btree ("refund_id") WHERE "refund_allocation_drafts"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "refund_allocation_finalization_effects_causal_unique" ON "refund_allocation_finalization_effects" USING btree ("refund_allocation_id","purchase_grant_id");--> statement-breakpoint
CREATE INDEX "refund_allocation_finalization_effects_refund_item_idx" ON "refund_allocation_finalization_effects" USING btree ("refund_id","order_item_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_reporting_correction_items_set_item_component_unique" ON "refund_reporting_correction_items" USING btree ("correction_set_id","domain",coalesce("source_allocation_set_id", '00000000-0000-0000-0000-000000000000'::uuid),"currency","order_item_id","component");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_reporting_correction_items_set_tie_key_unique" ON "refund_reporting_correction_items" USING btree ("correction_set_id","stable_tie_break_key");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_reporting_correction_sets_identity_unique" ON "refund_reporting_correction_sets" USING btree ("refund_id","correction_version");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_reporting_correction_sets_successor_unique" ON "refund_reporting_correction_sets" USING btree ("predecessor_correction_set_id") WHERE "refund_reporting_correction_sets"."predecessor_correction_set_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_reporting_correction_sets_root_unique" ON "refund_reporting_correction_sets" USING btree ("refund_id") WHERE "refund_reporting_correction_sets"."predecessor_correction_set_id" is null;--> statement-breakpoint
CREATE INDEX "refund_reporting_correction_sets_base_idx" ON "refund_reporting_correction_sets" USING btree ("base_allocation_set_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_classification_versions_identity_unique" ON "financial_classification_versions" USING btree ("subject_type","subject_id","classifier_version","source_fingerprint_sha256");--> statement-breakpoint
CREATE INDEX "financial_classification_versions_current_idx" ON "financial_classification_versions" USING btree ("subject_type","subject_id","source_fingerprint_sha256","classifier_version");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_scan_runs_root_key_unique" ON "financial_scan_runs" USING btree ("root_key");--> statement-breakpoint
CREATE INDEX "financial_scan_runs_state_phase_updated_idx" ON "financial_scan_runs" USING btree ("state","phase","updated_at","id");--> statement-breakpoint
CREATE INDEX "financial_scan_runs_kind_completed_idx" ON "financial_scan_runs" USING btree ("kind","completed_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_import_run_entries_candidate_unique" ON "payout_import_run_entries" USING btree ("run_id","balance_transaction_id");--> statement-breakpoint
CREATE INDEX "payout_import_run_entries_transaction_idx" ON "payout_import_run_entries" USING btree ("balance_transaction_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_import_runs_generation_unique" ON "payout_import_runs" USING btree ("payout_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_import_runs_active_payout_unique" ON "payout_import_runs" USING btree ("payout_id") WHERE "payout_import_runs"."state" in ('collecting', 'publishable');--> statement-breakpoint
CREATE INDEX "payout_import_runs_recovery_idx" ON "payout_import_runs" USING btree ("state","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_balance_transaction_fee_details_parent_ordinal_unique" ON "stripe_balance_transaction_fee_details" USING btree ("balance_transaction_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_balance_transactions_provider_unique" ON "stripe_balance_transactions" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "stripe_balance_transactions_source_idx" ON "stripe_balance_transactions" USING btree ("source_family","source_id");--> statement-breakpoint
CREATE INDEX "stripe_balance_transactions_status_available_idx" ON "stripe_balance_transactions" USING btree ("status","available_at","id");--> statement-breakpoint
CREATE INDEX "stripe_balance_transactions_currency_created_idx" ON "stripe_balance_transactions" USING btree ("currency","provider_created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_payout_balance_transactions_pair_unique" ON "stripe_payout_balance_transactions" USING btree ("payout_id","balance_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_payout_balance_transactions_transaction_unique" ON "stripe_payout_balance_transactions" USING btree ("balance_transaction_id");--> statement-breakpoint
CREATE INDEX "stripe_payout_balance_transactions_payout_idx" ON "stripe_payout_balance_transactions" USING btree ("payout_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_payouts_provider_unique" ON "stripe_payouts" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "stripe_payouts_status_created_idx" ON "stripe_payouts" USING btree ("status","provider_created_at","id");--> statement-breakpoint
CREATE INDEX "stripe_payouts_reconciliation_created_idx" ON "stripe_payouts" USING btree ("reconciliation_status","provider_created_at","id");--> statement-breakpoint
CREATE INDEX "stripe_payouts_balance_transaction_idx" ON "stripe_payouts" USING btree ("balance_transaction_id");--> statement-breakpoint
CREATE INDEX "stripe_payouts_failure_balance_transaction_idx" ON "stripe_payouts" USING btree ("failure_balance_transaction_id");--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_recovery_refund_allocation_id_refund_allocations_id_fk" FOREIGN KEY ("recovery_refund_allocation_id") REFERENCES "public"."refund_allocations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_grants_administrative_recovery_unique" ON "entitlement_grants" USING btree ("recovery_refund_allocation_id") WHERE "entitlement_grants"."source" = 'administrative';--> statement-breakpoint
WITH ordered_allocations AS (
  SELECT
    allocation.id AS refund_allocation_id,
    allocation.refund_id,
    allocation.order_item_id,
    allocation.amount_minor,
    allocation.created_at,
    refund.currency,
    item.unit_subtotal_minor,
    item.tax_minor AS item_tax_minor,
    item.total_minor,
    item.id::text || ':subtotal' AS subtotal_tie_key,
    item.id::text || ':tax' AS tax_tie_key,
    sum(allocation.amount_minor) OVER (
      PARTITION BY allocation.order_item_id
      ORDER BY refund.provider_created_at, refund.id, allocation.id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS cumulative_allocated_minor,
    coalesce(sum(allocation.amount_minor) OVER (
      PARTITION BY allocation.order_item_id
      ORDER BY refund.provider_created_at, refund.id, allocation.id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ), 0::bigint) AS previously_allocated_minor
  FROM "refund_allocations" allocation
  JOIN "refunds" refund ON refund.id = allocation.refund_id
  JOIN "order_items" item ON item.id = allocation.order_item_id
  WHERE refund.status = 'succeeded'
    AND refund.allocation_status = 'finalized'
), apportioned_totals AS (
  SELECT
    ordered.*,
    CASE WHEN ordered.total_minor = 0 THEN 0::bigint ELSE
      ordered.cumulative_allocated_minor * ordered.unit_subtotal_minor::bigint / ordered.total_minor::bigint +
      CASE WHEN
        ordered.cumulative_allocated_minor -
          (ordered.cumulative_allocated_minor * ordered.unit_subtotal_minor::bigint / ordered.total_minor::bigint) -
          (ordered.cumulative_allocated_minor * ordered.item_tax_minor::bigint / ordered.total_minor::bigint) > 0
        AND (
          mod(ordered.cumulative_allocated_minor * ordered.unit_subtotal_minor::bigint, ordered.total_minor::bigint) >
            mod(ordered.cumulative_allocated_minor * ordered.item_tax_minor::bigint, ordered.total_minor::bigint)
          OR (
            mod(ordered.cumulative_allocated_minor * ordered.unit_subtotal_minor::bigint, ordered.total_minor::bigint) =
              mod(ordered.cumulative_allocated_minor * ordered.item_tax_minor::bigint, ordered.total_minor::bigint)
            AND ordered.subtotal_tie_key < ordered.tax_tie_key
          )
        ) THEN 1::bigint ELSE 0::bigint END
    END AS cumulative_subtotal_minor,
    CASE WHEN ordered.total_minor = 0 THEN 0::bigint ELSE
      ordered.previously_allocated_minor * ordered.unit_subtotal_minor::bigint / ordered.total_minor::bigint +
      CASE WHEN
        ordered.previously_allocated_minor -
          (ordered.previously_allocated_minor * ordered.unit_subtotal_minor::bigint / ordered.total_minor::bigint) -
          (ordered.previously_allocated_minor * ordered.item_tax_minor::bigint / ordered.total_minor::bigint) > 0
        AND (
          mod(ordered.previously_allocated_minor * ordered.unit_subtotal_minor::bigint, ordered.total_minor::bigint) >
            mod(ordered.previously_allocated_minor * ordered.item_tax_minor::bigint, ordered.total_minor::bigint)
          OR (
            mod(ordered.previously_allocated_minor * ordered.unit_subtotal_minor::bigint, ordered.total_minor::bigint) =
              mod(ordered.previously_allocated_minor * ordered.item_tax_minor::bigint, ordered.total_minor::bigint)
            AND ordered.subtotal_tie_key < ordered.tax_tie_key
          )
        ) THEN 1::bigint ELSE 0::bigint END
    END AS previous_subtotal_minor
  FROM ordered_allocations ordered
), split_components AS (
  SELECT
    apportioned.*,
    (apportioned.cumulative_subtotal_minor - apportioned.previous_subtotal_minor)::integer AS subtotal_minor,
    (
      apportioned.amount_minor::bigint -
      (apportioned.cumulative_subtotal_minor - apportioned.previous_subtotal_minor)
    )::integer AS tax_minor
  FROM apportioned_totals apportioned
)
INSERT INTO "refund_allocation_components" (
  "refund_allocation_id", "refund_id", "order_item_id", "subtotal_minor", "tax_minor", "total_minor", "currency", "created_at"
)
SELECT
  component.refund_allocation_id,
  component.refund_id,
  component.order_item_id,
  component.subtotal_minor,
  component.tax_minor,
  component.amount_minor,
  component.currency,
  component.created_at
FROM split_components component
WHERE component.subtotal_minor::bigint + component.tax_minor::bigint = component.amount_minor::bigint
  AND component.subtotal_minor >= 0
  AND component.tax_minor >= 0
ORDER BY component.refund_id, component.order_item_id;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "refund_allocations" allocation
    JOIN "refunds" refund ON refund.id = allocation.refund_id
    LEFT JOIN "refund_allocation_components" component ON component.refund_allocation_id = allocation.id
    WHERE refund.status = 'succeeded'
      AND refund.allocation_status = 'finalized'
      AND component.id IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Plan 6B over-allocation/capacity prevented deterministic subtotal/tax component backfill';
  END IF;
END;
$$;--> statement-breakpoint
INSERT INTO "financial_reconciliation_issues" (
  "resource_type", "resource_id", "safe_code", "impact", "correlation_id"
)
SELECT 'refund', refund.id, 'allocation_incomplete', 'pending', 'plan6b-migration-backfill'
FROM "refunds" refund
WHERE refund.status = 'succeeded'
  AND refund.allocation_status = 'needs_review'
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "disputes" DROP COLUMN "reconciliation_status";--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "reconciliation_status";--> statement-breakpoint
ALTER TABLE "refunds" DROP COLUMN "reconciliation_status";--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "grants_source_consistent" CHECK ((
        "entitlement_grants"."source" = 'purchase' and
        "entitlement_grants"."order_item_id" is not null and
        "entitlement_grants"."recovery_refund_allocation_id" is null and
        "entitlement_grants"."state_reason" <> 'refund_allocation_recovery'
      ) or (
        "entitlement_grants"."source" = 'preserved' and
        "entitlement_grants"."user_id" is not null and
        "entitlement_grants"."order_item_id" is null and
        "entitlement_grants"."recovery_refund_allocation_id" is null and
        "entitlement_grants"."state_reason" <> 'refund_allocation_recovery'
      ) or (
        "entitlement_grants"."source" = 'administrative' and
        "entitlement_grants"."user_id" is not null and
        "entitlement_grants"."order_item_id" is null and
        "entitlement_grants"."recovery_refund_allocation_id" is not null and
        "entitlement_grants"."state_reason" = 'refund_allocation_recovery' and
        "entitlement_grants"."state" in ('active', 'revoked')
      ));--> statement-breakpoint
CREATE VIEW "public"."current_financial_projection_heads" AS (
  with current_parent_classification_candidates as (
    select
      bt.id as balance_transaction_id,
      count(classification.id)::integer as decision_count,
      count(*) filter (where classification.classification = 'unknown')::integer as unknown_count
    from "stripe_balance_transactions" bt
    left join "financial_classification_versions" classification
      on classification.subject_type = 'balance_transaction'
      and classification.subject_id = bt.id
      and classification.source_fingerprint_sha256 = bt.fingerprint_sha256
      and classification.classifier_version = 1
    group by bt.id
  ), current_fee_detail_classification_candidates as (
    select
      detail.balance_transaction_id,
      detail.id as fee_detail_id,
      detail.amount_minor,
      detail.currency,
      count(classification.id)::integer as decision_count,
      count(*) filter (where classification.classification = 'unknown')::integer as unknown_count
    from "stripe_balance_transaction_fee_details" detail
    left join "financial_classification_versions" classification
      on classification.subject_type = 'fee_detail'
      and classification.subject_id = detail.id
      and classification.source_fingerprint_sha256 = detail.fingerprint_sha256
      and classification.classifier_version = 1
    group by detail.balance_transaction_id, detail.id, detail.amount_minor, detail.currency
  ), current_fee_classification_candidates as (
    select
      bt.id as balance_transaction_id,
      count(detail.fee_detail_id)::integer as detail_count,
      coalesce(sum(detail.amount_minor), 0::bigint) as detail_amount_sum,
      count(detail.fee_detail_id) filter (where detail.currency <> bt.currency)::integer as currency_mismatch_count,
      coalesce(sum(detail.decision_count), 0::bigint)::integer as decision_count,
      coalesce(sum(detail.unknown_count), 0::bigint)::integer as unknown_count
    from "stripe_balance_transactions" bt
    left join current_fee_detail_classification_candidates detail
      on detail.balance_transaction_id = bt.id
    group by bt.id
  ), current_classification_status as (
    select
      parent.balance_transaction_id,
      parent.decision_count as parent_decision_count,
      parent.unknown_count as parent_unknown_count,
      fee.detail_count as fee_detail_count,
      fee.detail_amount_sum as fee_detail_amount_sum,
      fee.currency_mismatch_count as fee_currency_mismatch_count,
      fee.decision_count as fee_decision_count,
      fee.unknown_count as fee_unknown_count
    from current_parent_classification_candidates parent
    join current_fee_classification_candidates fee
      on fee.balance_transaction_id = parent.balance_transaction_id
  ), eligible_allocation_sets as (
    select s.*
    from "financial_allocation_sets" s
    where s.classifier_version = 1
      and s.algorithm_version = 1
  ), eligible_base_tips_unranked as (
    select s.*
    from eligible_allocation_sets s
    where not exists (
      select 1 from eligible_allocation_sets successor
      where successor.supersedes_set_id = s.id
    )
  ), eligible_base_tips as (
    select
      tip.*,
      count(*) over (
        partition by tip.balance_transaction_id, tip.basis
      ) as tip_count
    from eligible_base_tips_unranked tip
  ), base_rollup as (
    select
      bt.id as balance_transaction_id,
      basis.value as basis,
      count(base.id)::integer as base_count,
      (array_agg(base.id order by base.id) filter (where base.id is not null))[1] as base_set_id,
      (array_agg(base.scope order by base.id) filter (where base.id is not null))[1] as scope,
      (array_agg(base.currency order by base.id) filter (where base.id is not null))[1] as currency,
      (array_agg(base.expected_effect_minor order by base.id) filter (where base.id is not null))[1] as expected_effect_minor,
      (array_agg(base.source_kind order by base.id) filter (where base.id is not null))[1] as source_kind,
      (array_agg(base.source_internal_id order by base.id) filter (where base.id is not null))[1] as source_internal_id,
      (array_agg(base.source_fingerprint_sha256 order by base.id) filter (where base.id is not null))[1] as source_fingerprint_sha256,
      bt.fingerprint_sha256 as provider_fingerprint,
      classification.parent_decision_count,
      classification.parent_unknown_count,
      classification.fee_detail_count,
      classification.fee_detail_amount_sum,
      classification.fee_currency_mismatch_count,
      classification.fee_decision_count,
      classification.fee_unknown_count,
      case when basis.value = 'gross_amount'::financial_allocation_basis then bt.amount_minor else -bt.fee_minor end as provider_expected_effect,
      bt.fee_minor as provider_fee_minor,
      bt.currency as provider_currency
    from "stripe_balance_transactions" bt
    cross join (values
      ('gross_amount'::financial_allocation_basis),
      ('fee'::financial_allocation_basis)
    ) basis(value)
    join current_classification_status classification
      on classification.balance_transaction_id = bt.id
    left join eligible_base_tips base
      on base.balance_transaction_id = bt.id and base.basis = basis.value
    group by bt.id, basis.value, bt.amount_minor, bt.fee_minor, bt.currency, bt.fingerprint_sha256,
      classification.parent_decision_count, classification.parent_unknown_count,
      classification.fee_detail_count, classification.fee_detail_amount_sum,
      classification.fee_currency_mismatch_count, classification.fee_decision_count,
      classification.fee_unknown_count
  ), base_item_rollup as (
    select
      s.id as base_set_id,
      count(item.id)::integer as item_count,
      coalesce(sum(item.effect_minor), 0::bigint) as item_effect_sum,
      count(item.id) filter (where item.currency <> s.currency)::integer as currency_mismatch_count
    from eligible_base_tips s
    left join "financial_item_allocations" item on item.allocation_set_id = s.id
    group by s.id
  ), refund_presentment_components as (
    select
      allocation.refund_id,
      allocation.order_item_id,
      allocation.currency,
      component.component,
      component.amount_minor
    from "refund_allocation_components" allocation
    cross join lateral (values
      ('refund_subtotal'::financial_component, allocation.subtotal_minor),
      ('refund_tax'::financial_component, allocation.tax_minor)
    ) component(component, amount_minor)
  ), correction_tip_candidates as (
    select correction.*
    from "refund_reporting_correction_sets" correction
    where not exists (
      select 1 from "refund_reporting_correction_sets" successor
      where successor.predecessor_correction_set_id = correction.id
    )
  ), correction_prevalidation as (
    select
      correction.*,
      correction_refund.payment_id as refund_payment_id,
      correction_refund.currency as refund_currency,
      correction_payment.order_id as refund_order_id,
      case when
        exists (
          select 1
          from "refund_reporting_correction_items" correction_item
          where correction_item.correction_set_id = correction.id
        ) and
        correction_refund.status = 'succeeded' and
        correction_refund.currency = correction_payment.currency and
        anchor.id is not null and
        anchor.tip_count = 1 and
        anchor.source_kind = 'refund'::financial_allocation_source_kind and
        anchor.source_internal_id = correction.refund_id and
        anchor.source_fingerprint_sha256 = correction.source_fingerprint_sha256
      then 0 else 1 end::bigint as invalid_refund_context_count,
      (
        select count(*)
        from "refund_reporting_correction_items" correction_item
        left join eligible_base_tips item_source
          on item_source.id = correction_item.source_allocation_set_id
        where correction_item.correction_set_id = correction.id
          and correction_item.domain = 'settlement'
          and (
            item_source.id is null or
            item_source.tip_count <> 1 or
            item_source.source_kind <> 'refund'::financial_allocation_source_kind or
            item_source.source_internal_id <> correction.refund_id or
            item_source.source_fingerprint_sha256 <> correction.source_fingerprint_sha256 or
            correction_item.currency <> item_source.currency
          )
      ) as invalid_settlement_source_count,
      (
        select count(*)
        from (
          select
            correction_item.domain,
            correction_item.source_allocation_set_id,
            correction_item.currency
          from "refund_reporting_correction_items" correction_item
          where correction_item.correction_set_id = correction.id
          group by correction_item.domain,
            correction_item.source_allocation_set_id,
            correction_item.currency
          having sum(correction_item.delta_minor::bigint) <> 0
        ) invalid_delta_group
      ) as invalid_delta_group_count,
      (
        select count(*)
        from "refund_reporting_correction_items" correction_item
        where correction_item.correction_set_id = correction.id
          and (
            not exists (
              select 1
              from "order_items" order_item
              where order_item.id = correction_item.order_item_id
                and order_item.order_id = correction_payment.order_id
                and (
                  correction_item.domain <> 'presentment' or
                  order_item.currency = correction_item.currency
                )
            ) or (
              correction_item.domain = 'presentment' and
              correction_item.currency <> correction_refund.currency
            )
          )
      ) as invalid_order_item_count,
      (
        select count(*)
        from "refund_reporting_correction_items" correction_item
        left join "financial_item_allocations" base_item
          on base_item.allocation_set_id = correction_item.source_allocation_set_id
          and base_item.order_item_id = correction_item.order_item_id
          and base_item.component = correction_item.component
        where correction_item.correction_set_id = correction.id
          and correction_item.domain = 'settlement'
          and (
            correction_item.approved_absolute_minor::bigint <>
              coalesce(base_item.effect_minor, 0)::bigint + correction_item.delta_minor::bigint or
            (base_item.id is not null and base_item.currency <> correction_item.currency)
          )
      ) as invalid_settlement_arithmetic_count,
      (
        select count(*)
        from "financial_item_allocations" base_item
        where base_item.effect_minor <> 0
          and exists (
            select 1
            from "refund_reporting_correction_items" source_item
            where source_item.correction_set_id = correction.id
              and source_item.domain = 'settlement'
              and source_item.source_allocation_set_id = base_item.allocation_set_id
          )
          and not exists (
            select 1
            from "refund_reporting_correction_items" correction_item
            where correction_item.correction_set_id = correction.id
              and correction_item.domain = 'settlement'
              and correction_item.source_allocation_set_id = base_item.allocation_set_id
              and correction_item.order_item_id = base_item.order_item_id
              and correction_item.component = base_item.component
              and correction_item.currency = base_item.currency
          )
      ) as missing_settlement_base_count,
      (
        select count(*)
        from "refund_reporting_correction_items" correction_item
        left join refund_presentment_components base_component
          on base_component.refund_id = correction.refund_id
          and base_component.order_item_id = correction_item.order_item_id
          and base_component.component = correction_item.component
        where correction_item.correction_set_id = correction.id
          and correction_item.domain = 'presentment'
          and (
            correction_item.approved_absolute_minor < 0 or
            correction_item.approved_absolute_minor::bigint <>
              coalesce(base_component.amount_minor, 0)::bigint + correction_item.delta_minor::bigint or
            (base_component.refund_id is not null and
              base_component.currency <> correction_item.currency)
          )
      ) as invalid_presentment_arithmetic_count,
      (
        select count(*)
        from refund_presentment_components base_component
        where base_component.refund_id = correction.refund_id
          and base_component.amount_minor <> 0
          and exists (
            select 1
            from "refund_reporting_correction_items" presentment_item
            where presentment_item.correction_set_id = correction.id
              and presentment_item.domain = 'presentment'
          )
          and not exists (
            select 1
            from "refund_reporting_correction_items" correction_item
            where correction_item.correction_set_id = correction.id
              and correction_item.domain = 'presentment'
              and correction_item.order_item_id = base_component.order_item_id
              and correction_item.component = base_component.component
              and correction_item.currency = base_component.currency
          )
      ) as missing_presentment_base_count
    from correction_tip_candidates correction
    join "refunds" correction_refund on correction_refund.id = correction.refund_id
    join "payments" correction_payment on correction_payment.id = correction_refund.payment_id
    left join eligible_base_tips anchor on anchor.id = correction.base_allocation_set_id
  ), prevalidated_correction_tips as (
    select
      correction.*,
      (
        correction.invalid_refund_context_count +
        correction.invalid_settlement_source_count +
        correction.invalid_delta_group_count +
        correction.invalid_order_item_count +
        correction.invalid_settlement_arithmetic_count +
        correction.missing_settlement_base_count +
        correction.invalid_presentment_arithmetic_count +
        correction.missing_presentment_base_count
      )::bigint as invalid_noncapacity_count
    from correction_prevalidation correction
  ), effective_presentment_components as (
    select
      effective_refund.payment_id,
      base_component.refund_id,
      base_component.order_item_id,
      base_component.component,
      base_component.currency,
      base_component.amount_minor::bigint as effect_minor
    from refund_presentment_components base_component
    join "refunds" effective_refund on effective_refund.id = base_component.refund_id
    where effective_refund.status = 'succeeded'
      and not exists (
        select 1
        from prevalidated_correction_tips correction
        where correction.refund_id = base_component.refund_id
          and correction.invalid_noncapacity_count = 0
          and exists (
            select 1
            from "refund_reporting_correction_items" correction_item
            where correction_item.correction_set_id = correction.id
              and correction_item.domain = 'presentment'
          )
      )
    union all
    select
      correction.refund_payment_id as payment_id,
      correction.refund_id,
      correction_item.order_item_id,
      correction_item.component,
      correction_item.currency,
      correction_item.approved_absolute_minor::bigint as effect_minor
    from prevalidated_correction_tips correction
    join "refund_reporting_correction_items" correction_item
      on correction_item.correction_set_id = correction.id
      and correction_item.domain = 'presentment'
    where correction.invalid_noncapacity_count = 0
  ), presentment_capacity_status as (
    select
      effect.payment_id,
      effect.order_item_id,
      effect.component,
      effect.currency,
      sum(effect.effect_minor)::bigint as cumulative_effect_minor,
      case effect.component
        when 'refund_subtotal'::financial_component then order_item.unit_subtotal_minor
        when 'refund_tax'::financial_component then coalesce(order_item.tax_minor, 0)
        else 0
      end::bigint as capacity_minor
    from effective_presentment_components effect
    join "order_items" order_item on order_item.id = effect.order_item_id
    group by effect.payment_id, effect.order_item_id, effect.component, effect.currency,
      order_item.unit_subtotal_minor, order_item.tax_minor
  ), current_correction_tips as (
    select
      correction.*,
      (
        correction.invalid_noncapacity_count + (
          select count(*)
          from "refund_reporting_correction_items" correction_item
          left join presentment_capacity_status capacity
            on capacity.payment_id = correction.refund_payment_id
            and capacity.order_item_id = correction_item.order_item_id
            and capacity.component = correction_item.component
            and capacity.currency = correction_item.currency
          where correction_item.correction_set_id = correction.id
            and correction_item.domain = 'presentment'
            and (
              capacity.order_item_id is null or
              capacity.cumulative_effect_minor < 0 or
              capacity.cumulative_effect_minor > capacity.capacity_minor
            )
        )
      )::bigint as invalid_correction_count
    from prevalidated_correction_tips correction
  ), correction_rollup as (
    select
      correction.refund_id,
      count(correction.id)::integer as correction_count,
      (array_agg(correction.id order by correction.id))[1] as correction_tip_id,
      (array_agg(correction.base_allocation_set_id order by correction.id))[1] as anchor_base_set_id,
      (array_agg(correction.source_fingerprint_sha256 order by correction.id))[1] as correction_fingerprint,
      coalesce(sum(correction.invalid_correction_count), 0::bigint) as invalid_correction_count
    from current_correction_tips correction
    group by correction.refund_id
  ), correction_status as (
    select
      correction.*,
      (
        correction.correction_count = 1 and
        correction.invalid_correction_count = 0 and
        anchor.id is not null and
        anchor.tip_count = 1 and
        anchor.source_kind = 'refund'::financial_allocation_source_kind and
        anchor.source_internal_id = correction.refund_id and
        anchor.source_fingerprint_sha256 = correction.correction_fingerprint
      )::boolean as is_compatible
    from correction_rollup correction
    left join eligible_base_tips anchor on anchor.id = correction.anchor_base_set_id
  ), correction_item_rollup as (
    select
      item.source_allocation_set_id as base_set_id,
      item.correction_set_id,
      count(*)::integer as item_count,
      coalesce(sum(item.approved_absolute_minor), 0::bigint) as item_effect_sum,
      count(*) filter (where item.currency <> source.currency)::integer as currency_mismatch_count
    from "refund_reporting_correction_items" item
    join "financial_allocation_sets" source on source.id = item.source_allocation_set_id
    where item.domain = 'settlement'
    group by item.source_allocation_set_id, item.correction_set_id
  ), resolved as (
    select
      base.*,
      coalesce(items.item_count, 0) as base_item_count,
      coalesce(items.item_effect_sum, 0::bigint) as base_item_effect_sum,
      coalesce(items.currency_mismatch_count, 0) as base_item_currency_mismatch_count,
      coalesce(correction.correction_count, 0) as correction_count,
      correction.correction_tip_id,
      correction.correction_fingerprint,
      coalesce(correction.is_compatible, false) as correction_is_compatible,
      coalesce(correction_items.item_count, 0) as correction_item_count,
      coalesce(correction_items.item_effect_sum, 0::bigint) as correction_item_effect_sum,
      coalesce(correction_items.currency_mismatch_count, 0) as correction_item_currency_mismatch_count
    from base_rollup base
    left join base_item_rollup items on items.base_set_id = base.base_set_id
    left join correction_status correction
      on base.source_kind = 'refund'::financial_allocation_source_kind
      and correction.refund_id = base.source_internal_id
    left join correction_item_rollup correction_items
      on correction_items.base_set_id = base.base_set_id
      and correction_items.correction_set_id = correction.correction_tip_id
  )
  select
    balance_transaction_id,
    basis,
    case when base_count = 1 then base_set_id else null::uuid end as base_set_id,
    case when base_count = 1 and correction_count = 1 and correction_is_compatible
      then correction_tip_id else null::uuid end as compatible_correction_tip_id,
    case when base_count = 1 then scope else null::financial_allocation_scope end as scope,
    case when base_count = 1 then currency else null::varchar(3) end as currency,
    case when base_count = 1 then expected_effect_minor else null::integer end as expected_effect_minor,
    (
      base_count = 1 and scope <> 'unresolved'::financial_allocation_scope and
      parent_decision_count = 1 and parent_unknown_count = 0 and
      (basis <> 'fee'::financial_allocation_basis or
        (fee_decision_count = fee_detail_count and fee_unknown_count = 0 and
          fee_detail_amount_sum = provider_fee_minor and fee_currency_mismatch_count = 0)) and
      source_fingerprint_sha256 = provider_fingerprint and
      currency = provider_currency and expected_effect_minor = provider_expected_effect and
      (
        (
          correction_count = 0 and
          ((scope = 'title' and (base_item_count > 0 or expected_effect_minor = 0) and base_item_currency_mismatch_count = 0 and base_item_effect_sum = expected_effect_minor) or (scope = 'account' and base_item_count = 0))
        ) or (
          correction_count = 1 and correction_is_compatible and
          (
            (correction_item_count > 0 and scope = 'title' and correction_item_currency_mismatch_count = 0 and correction_item_effect_sum = expected_effect_minor) or
            (correction_item_count = 0 and ((scope = 'title' and (base_item_count > 0 or expected_effect_minor = 0) and base_item_currency_mismatch_count = 0 and base_item_effect_sum = expected_effect_minor) or (scope = 'account' and base_item_count = 0)))
          )
        )
      )
    )::boolean as is_complete,
    case when
      base_count = 1 and scope <> 'unresolved'::financial_allocation_scope and
      parent_decision_count = 1 and parent_unknown_count = 0 and
      (basis <> 'fee'::financial_allocation_basis or
        (fee_decision_count = fee_detail_count and fee_unknown_count = 0 and
          fee_detail_amount_sum = provider_fee_minor and fee_currency_mismatch_count = 0)) and
      source_fingerprint_sha256 = provider_fingerprint and
      currency = provider_currency and expected_effect_minor = provider_expected_effect and
      (
        (
          correction_count = 0 and
          ((scope = 'title' and (base_item_count > 0 or expected_effect_minor = 0) and base_item_currency_mismatch_count = 0 and base_item_effect_sum = expected_effect_minor) or (scope = 'account' and base_item_count = 0))
        ) or (
          correction_count = 1 and correction_is_compatible and
          (
            (correction_item_count > 0 and scope = 'title' and correction_item_currency_mismatch_count = 0 and correction_item_effect_sum = expected_effect_minor) or
            (correction_item_count = 0 and ((scope = 'title' and (base_item_count > 0 or expected_effect_minor = 0) and base_item_currency_mismatch_count = 0 and base_item_effect_sum = expected_effect_minor) or (scope = 'account' and base_item_count = 0)))
          )
        )
      ) then 0 else 1 end::integer as missing_source_count,
    case
      when parent_decision_count = 0 then 'missing_source'::varchar(100)
      when parent_decision_count > 1 then 'classification_fork'::varchar(100)
      when parent_unknown_count > 0 then 'unsupported_category'::varchar(100)
      when basis = 'fee'::financial_allocation_basis and fee_currency_mismatch_count > 0 then 'currency_mismatch'::varchar(100)
      when basis = 'fee'::financial_allocation_basis and fee_detail_amount_sum <> provider_fee_minor then 'allocation_mismatch'::varchar(100)
      when basis = 'fee'::financial_allocation_basis and fee_decision_count > fee_detail_count then 'classification_fork'::varchar(100)
      when basis = 'fee'::financial_allocation_basis and fee_unknown_count > 0 then 'unsupported_category'::varchar(100)
      when basis = 'fee'::financial_allocation_basis and fee_decision_count < fee_detail_count then 'missing_source'::varchar(100)
      when base_count = 0 then 'missing_source'::varchar(100)
      when base_count > 1 then 'allocation_fork'::varchar(100)
      when source_fingerprint_sha256 <> provider_fingerprint then 'immutable_mismatch'::varchar(100)
      when currency <> provider_currency then 'currency_mismatch'::varchar(100)
      when expected_effect_minor <> provider_expected_effect then 'allocation_mismatch'::varchar(100)
      when scope = 'unresolved' then 'allocation_incomplete'::varchar(100)
      when correction_count > 1 then 'correction_rebase_required'::varchar(100)
      when correction_count = 1 and not correction_is_compatible then 'correction_rebase_required'::varchar(100)
      when correction_count = 1 and correction_item_count > 0 and correction_item_currency_mismatch_count > 0 then 'currency_mismatch'::varchar(100)
      when correction_count = 1 and correction_item_count > 0 and (scope <> 'title' or correction_item_effect_sum <> expected_effect_minor) then 'allocation_mismatch'::varchar(100)
      when (correction_count = 0 or correction_item_count = 0) and base_item_currency_mismatch_count > 0 then 'currency_mismatch'::varchar(100)
      when (correction_count = 0 or correction_item_count = 0) and ((scope = 'title' and ((base_item_count = 0 and expected_effect_minor <> 0) or base_item_effect_sum <> expected_effect_minor)) or (scope = 'account' and base_item_count <> 0)) then 'allocation_mismatch'::varchar(100)
      else null::varchar(100)
    end as proposed_issue_code
  from resolved

);--> statement-breakpoint
CREATE VIEW "public"."current_financial_projection_items" AS (
  select
    head.balance_transaction_id,
    head.basis,
    head.base_set_id,
    head.compatible_correction_tip_id,
    base.order_item_id,
    base.component,
    base.effect_minor,
    base.currency
  from "current_financial_projection_heads" head
  join "financial_item_allocations" base on base.allocation_set_id = head.base_set_id
  where head.is_complete
    and head.scope = 'title'
    and not exists (
      select 1
      from "refund_reporting_correction_items" correction
      where correction.correction_set_id = head.compatible_correction_tip_id
        and correction.source_allocation_set_id = head.base_set_id
        and correction.domain = 'settlement'
    )
  union all
  select
    head.balance_transaction_id,
    head.basis,
    head.base_set_id,
    head.compatible_correction_tip_id,
    correction.order_item_id,
    correction.component,
    correction.approved_absolute_minor as effect_minor,
    correction.currency
  from "current_financial_projection_heads" head
  join "refund_reporting_correction_items" correction
    on correction.correction_set_id = head.compatible_correction_tip_id
    and correction.source_allocation_set_id = head.base_set_id
    and correction.domain = 'settlement'
  where head.is_complete
    and head.scope = 'title'

);--> statement-breakpoint
CREATE FUNCTION "public"."plan6b_reject_history_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = format('%s is append-only', TG_TABLE_NAME);
END;
$$;--> statement-breakpoint
CREATE TRIGGER "stripe_balance_transaction_fee_details_immutable" BEFORE UPDATE OR DELETE ON "stripe_balance_transaction_fee_details" FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_reject_history_mutation"();--> statement-breakpoint
CREATE TRIGGER "financial_classification_versions_immutable" BEFORE UPDATE OR DELETE ON "financial_classification_versions" FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_reject_history_mutation"();--> statement-breakpoint
CREATE TRIGGER "stripe_payout_balance_transactions_immutable" BEFORE UPDATE OR DELETE ON "stripe_payout_balance_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_reject_history_mutation"();--> statement-breakpoint
CREATE TRIGGER "financial_allocation_sets_immutable" BEFORE UPDATE OR DELETE ON "financial_allocation_sets" FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_reject_history_mutation"();--> statement-breakpoint
CREATE TRIGGER "financial_item_allocations_immutable" BEFORE UPDATE OR DELETE ON "financial_item_allocations" FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_reject_history_mutation"();--> statement-breakpoint
CREATE TRIGGER "refund_allocation_components_immutable" BEFORE UPDATE OR DELETE ON "refund_allocation_components" FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_reject_history_mutation"();--> statement-breakpoint
CREATE TRIGGER "dispute_item_allocations_immutable" BEFORE UPDATE OR DELETE ON "dispute_item_allocations" FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_reject_history_mutation"();--> statement-breakpoint
CREATE TRIGGER "refund_reporting_correction_sets_immutable" BEFORE UPDATE OR DELETE ON "refund_reporting_correction_sets" FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_reject_history_mutation"();--> statement-breakpoint
CREATE TRIGGER "refund_reporting_correction_items_immutable" BEFORE UPDATE OR DELETE ON "refund_reporting_correction_items" FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_reject_history_mutation"();--> statement-breakpoint
CREATE TRIGGER "refund_allocation_finalization_effects_immutable" BEFORE UPDATE OR DELETE ON "refund_allocation_finalization_effects" FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_reject_history_mutation"();--> statement-breakpoint
CREATE TRIGGER "refund_allocations_immutable" BEFORE UPDATE OR DELETE ON "refund_allocations" FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_reject_history_mutation"();--> statement-breakpoint
CREATE FUNCTION "public"."plan6b_validate_balance_transaction_transition"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'balance transaction history cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR
     NEW.provider_id IS DISTINCT FROM OLD.provider_id OR
     NEW.live_mode IS DISTINCT FROM OLD.live_mode OR
     NEW.source_family IS DISTINCT FROM OLD.source_family OR
     NEW.source_id IS DISTINCT FROM OLD.source_id OR
     NEW.raw_type IS DISTINCT FROM OLD.raw_type OR
     NEW.reporting_category IS DISTINCT FROM OLD.reporting_category OR
     NEW.balance_type IS DISTINCT FROM OLD.balance_type OR
     NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR
     NEW.fee_minor IS DISTINCT FROM OLD.fee_minor OR
     NEW.net_minor IS DISTINCT FROM OLD.net_minor OR
     NEW.currency IS DISTINCT FROM OLD.currency OR
     NEW.provider_created_at IS DISTINCT FROM OLD.provider_created_at OR
     NEW.available_at IS DISTINCT FROM OLD.available_at OR
     NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate OR
     NEW.exchange_source_currency IS DISTINCT FROM OLD.exchange_source_currency OR
     NEW.exchange_target_currency IS DISTINCT FROM OLD.exchange_target_currency OR
     NEW.fingerprint_sha256 IS DISTINCT FROM OLD.fingerprint_sha256 OR
     NEW.first_imported_at IS DISTINCT FROM OLD.first_imported_at OR
     NOT (NEW.status = OLD.status OR (OLD.status = 'pending' AND NEW.status = 'available')) OR
     NEW.last_imported_at < OLD.last_imported_at THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid balance transaction history mutation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "stripe_balance_transactions_narrow_update" BEFORE UPDATE OR DELETE ON "stripe_balance_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_validate_balance_transaction_transition"();--> statement-breakpoint
CREATE FUNCTION "public"."plan6b_validate_payout_transition"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  reporting_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'payout history cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR
     NEW.provider_id IS DISTINCT FROM OLD.provider_id OR
     NEW.live_mode IS DISTINCT FROM OLD.live_mode OR
     NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR
     NEW.currency IS DISTINCT FROM OLD.currency OR
     NEW.automatic IS DISTINCT FROM OLD.automatic OR
     NEW.method IS DISTINCT FROM OLD.method OR
     NEW.provider_created_at IS DISTINCT FROM OLD.provider_created_at OR
     NEW.fingerprint_sha256 IS DISTINCT FROM OLD.fingerprint_sha256 OR
     NEW.retrieved_at < OLD.retrieved_at OR
     NEW.financial_generation < OLD.financial_generation OR
     NEW.financial_generation > OLD.financial_generation + 1 OR
     NOT (
       NEW.status = OLD.status OR
       (OLD.status = 'pending' AND NEW.status IN ('in_transit', 'paid', 'failed', 'canceled')) OR
       (OLD.status = 'in_transit' AND NEW.status IN ('paid', 'failed', 'canceled')) OR
       (OLD.status = 'paid' AND NEW.status IN ('failed', 'canceled'))
     ) OR
     NOT (
       NEW.reconciliation_status = OLD.reconciliation_status OR
       (OLD.reconciliation_status = 'in_progress' AND NEW.reconciliation_status IN ('completed', 'not_applicable'))
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid payout history mutation';
  END IF;

  reporting_changed := ROW(
    NEW.status, NEW.reconciliation_status, NEW.arrival_at,
    NEW.balance_transaction_id, NEW.failure_balance_transaction_id,
    NEW.original_provider_payout_id, NEW.reversed_by_provider_payout_id,
    NEW.safe_failure_code
  ) IS DISTINCT FROM ROW(
    OLD.status, OLD.reconciliation_status, OLD.arrival_at,
    OLD.balance_transaction_id, OLD.failure_balance_transaction_id,
    OLD.original_provider_payout_id, OLD.reversed_by_provider_payout_id,
    OLD.safe_failure_code
  );

  IF reporting_changed AND NEW.financial_generation = OLD.financial_generation THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'payout reporting transition requires a generation increment';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "stripe_payouts_narrow_update" BEFORE UPDATE OR DELETE ON "stripe_payouts" FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_validate_payout_transition"();--> statement-breakpoint
CREATE FUNCTION "public"."plan6b_validate_refund_draft_transition"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'refund allocation draft history cannot be deleted';
  END IF;
  IF OLD.state <> 'active' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.refund_id IS DISTINCT FROM OLD.refund_id OR
     NEW.created_by_admin_id IS DISTINCT FROM OLD.created_by_admin_id OR
     NEW.created_correlation_id IS DISTINCT FROM OLD.created_correlation_id OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR
     NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at OR
     NEW.state NOT IN ('active', 'finalized', 'discarded') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid refund allocation draft transition';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "refund_allocation_drafts_narrow_update" BEFORE UPDATE OR DELETE ON "refund_allocation_drafts" FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_validate_refund_draft_transition"();--> statement-breakpoint
CREATE FUNCTION "public"."plan6b_validate_refund_draft_item_transition"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "refund_allocation_drafts" draft WHERE draft.id = OLD.draft_id AND draft.state = 'active') THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'finalized refund allocation draft item is immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.draft_id IS DISTINCT FROM OLD.draft_id OR
     NEW.order_item_id IS DISTINCT FROM OLD.order_item_id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR
     NEW.updated_at < OLD.updated_at OR
     NOT EXISTS (SELECT 1 FROM "refund_allocation_drafts" draft WHERE draft.id = OLD.draft_id AND draft.state = 'active') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid refund allocation draft item transition';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "refund_allocation_draft_items_narrow_update" BEFORE UPDATE OR DELETE ON "refund_allocation_draft_items" FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_validate_refund_draft_item_transition"();--> statement-breakpoint
CREATE FUNCTION "public"."plan6b_validate_refund_draft_item_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "refund_allocation_drafts" draft
    WHERE draft.id = NEW.draft_id AND draft.state = 'active'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'refund allocation draft items require an active draft';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "refund_allocation_draft_items_validate_insert" BEFORE INSERT ON "refund_allocation_draft_items" FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_validate_refund_draft_item_insert"();--> statement-breakpoint
CREATE FUNCTION "public"."resolve_financial_reconciliation_issue"(
  p_issue_id uuid,
  p_resolved_by_admin_id uuid
) RETURNS SETOF "public"."financial_reconciliation_issues"
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('pale_orbit.financial_issue_resolution', p_issue_id::text, true);
  RETURN QUERY
  UPDATE "financial_reconciliation_issues"
  SET "state" = 'resolved', "resolved_at" = now(), "resolved_by_admin_id" = p_resolved_by_admin_id
  WHERE "id" = p_issue_id AND "state" = 'open'
  RETURNING *;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "public"."plan6b_validate_issue_transition"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'financial issue history cannot be deleted';
  END IF;
  IF OLD.state = 'resolved' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'resolved financial issue history is immutable';
  END IF;
  IF NEW.state = 'resolved' AND (
    current_setting('pale_orbit.financial_issue_resolution', true) IS DISTINCT FROM OLD.id::text OR
    NEW.resolved_at IS NULL OR NEW.occurrence_count <> OLD.occurrence_count OR
    NEW.last_observed_at IS DISTINCT FROM OLD.last_observed_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'financial issue resolution requires the guarded resolver';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.resource_type IS DISTINCT FROM OLD.resource_type OR
     NEW.resource_id IS DISTINCT FROM OLD.resource_id OR NEW.safe_code IS DISTINCT FROM OLD.safe_code OR
     NEW.impact IS DISTINCT FROM OLD.impact OR NEW.first_observed_at IS DISTINCT FROM OLD.first_observed_at OR
     NEW.correlation_id IS DISTINCT FROM OLD.correlation_id OR NEW.occurrence_count < OLD.occurrence_count OR
     NEW.last_observed_at < OLD.last_observed_at OR
     (OLD.state = 'open' AND NEW.state NOT IN ('open', 'resolved')) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid financial issue history mutation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "financial_reconciliation_issues_narrow_update" BEFORE UPDATE OR DELETE ON "financial_reconciliation_issues" FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_validate_issue_transition"();--> statement-breakpoint
CREATE FUNCTION "public"."plan6b_validate_finalization_effect_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "refund_allocations" allocation
    JOIN "refund_allocation_drafts" draft
      ON draft.id = NEW.draft_id
     AND draft.refund_id = NEW.refund_id
     AND draft.version = NEW.draft_version
     AND draft.state = 'finalized'
    JOIN "refund_allocation_draft_items" draft_item
      ON draft_item.draft_id = draft.id
     AND draft_item.order_item_id = NEW.order_item_id
    JOIN "entitlement_grants" purchase_grant
      ON purchase_grant.id = NEW.purchase_grant_id
     AND purchase_grant.order_item_id = NEW.order_item_id
     AND purchase_grant.source = 'purchase'
     AND purchase_grant.state = NEW.after_purchase_grant_state
    WHERE allocation.id = NEW.refund_allocation_id
      AND allocation.refund_id = NEW.refund_id
      AND allocation.order_item_id = NEW.order_item_id
      AND allocation.source = 'administrative'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid refund finalization provenance insert';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "refund_allocation_finalization_effects_validate_insert" AFTER INSERT ON "refund_allocation_finalization_effects" FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_validate_finalization_effect_insert"();--> statement-breakpoint
DROP TYPE "public"."entitlement_grant_source_legacy";--> statement-breakpoint
DROP TYPE "public"."financial_reconciliation_status";
