CREATE TYPE "public"."screen_reason" AS ENUM('no_product', 'address_rule', 'machine', 'service_flag', 'forged', 'own_address', 'no_sender');--> statement-breakpoint
CREATE TYPE "public"."screened_state" AS ENUM('waiting', 'promoted', 'dismissed');--> statement-breakpoint
CREATE TABLE "product_address" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"product_id" uuid NOT NULL,
	"value" text NOT NULL,
	"screens" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_address_workspaceId_value_unique" UNIQUE("workspace_id","value")
);
--> statement-breakpoint
ALTER TABLE "product_address" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "screened_mail" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"provider_id" text NOT NULL,
	"email_message_id" text,
	"email_in_reply_to" text,
	"email_references" text[] DEFAULT '{}'::text[] NOT NULL,
	"from_address" text NOT NULL,
	"from_name" text,
	"addressed_to" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"sender_suspect" boolean DEFAULT false NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" "screen_reason" NOT NULL,
	"product_id" uuid,
	"state" "screened_state" DEFAULT 'waiting' NOT NULL,
	"ticket_id" uuid,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "screened_mail" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "screens_support_address" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_address" ADD CONSTRAINT "product_address_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_address" ADD CONSTRAINT "product_address_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screened_mail" ADD CONSTRAINT "screened_mail_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screened_mail" ADD CONSTRAINT "screened_mail_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screened_mail" ADD CONSTRAINT "screened_mail_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screened_mail" ADD CONSTRAINT "screened_mail_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_address_product_id_index" ON "product_address" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "screened_mail_workspace_id_provider_id_index" ON "screened_mail" USING btree ("workspace_id","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "screened_mail_workspace_id_email_message_id_index" ON "screened_mail" USING btree ("workspace_id","email_message_id") WHERE email_message_id is not null;--> statement-breakpoint
CREATE INDEX "screened_mail_workspace_id_state_received_at_index" ON "screened_mail" USING btree ("workspace_id","state","received_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "product_address" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "screened_mail" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
-- The app role reads and writes both, behind row-level security, like every other table of a workspace.
GRANT SELECT, INSERT, UPDATE, DELETE ON "product_address", "screened_mail" TO tenant_app;
