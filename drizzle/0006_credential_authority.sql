CREATE TABLE "credential_authority" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"authorized_password_hash" text,
	"reset_epoch_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_authority_reset_epoch_sha256_valid" CHECK ("credential_authority"."reset_epoch_sha256" is null or "credential_authority"."reset_epoch_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "credential_authority_has_authorized_hash_or_active_reset" CHECK ("credential_authority"."authorized_password_hash" is not null or "credential_authority"."reset_epoch_sha256" is not null)
);
--> statement-breakpoint
ALTER TABLE "credential_authority" ADD CONSTRAINT "credential_authority_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "account"
		WHERE "provider_id" = 'credential'
		GROUP BY "user_id"
		HAVING count(*) <> 1
	) THEN
		RAISE EXCEPTION 'credential authority backfill requires exactly one credential account per user';
	END IF;
	IF EXISTS (
		SELECT 1
		FROM "account"
		WHERE "provider_id" = 'credential' AND "password" IS NULL
	) THEN
		RAISE EXCEPTION 'credential authority backfill requires every credential account to have a password hash';
	END IF;
END $$;
--> statement-breakpoint
INSERT INTO "credential_authority" (
	"user_id",
	"authorized_password_hash",
	"reset_epoch_sha256",
	"created_at",
	"updated_at"
)
SELECT
	"user_id",
	"password",
	NULL,
	now(),
	now()
FROM "account"
WHERE "provider_id" = 'credential';
