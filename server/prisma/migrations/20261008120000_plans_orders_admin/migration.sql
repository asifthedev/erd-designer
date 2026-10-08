-- CreateTable
CREATE TABLE "erd_plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "price_cents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "max_diagrams" INTEGER NOT NULL,
    "max_tables_per_diagram" INTEGER NOT NULL,
    "features" JSONB NOT NULL DEFAULT '{}',
    "highlights" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "erd_plans_pkey" PRIMARY KEY ("id")
);

-- Seed: the three plans. Prices are placeholders; the admin panel changes them.
INSERT INTO "erd_plans" ("id","name","kind","description","price_cents","currency","max_diagrams","max_tables_per_diagram","features","highlights","active","sort_order","updated_at") VALUES
  ('free','Free','free','Try it and keep one diagram.',0,'USD',1,25,'{"export": false, "codeFormats": false, "themes": false, "localCopy": false, "setup": false}'::jsonb,'["1 diagram", "Up to 25 tables in the diagram", "Prisma schema code", "Midnight and Dracula themes", "Saved to your account"]'::jsonb,true,0,CURRENT_TIMESTAMP),
  ('monthly','Pro','monthly','For people who design databases regularly.',900,'USD',5,100,'{"export": true, "codeFormats": true, "themes": true, "localCopy": false, "setup": false}'::jsonb,'["Up to 5 diagrams", "Up to 100 tables in each diagram", "Prisma, Drizzle and SQL code", "Export as PNG, SVG and PDF", "All themes and table colours", "Every feature unlocked"]'::jsonb,true,1,CURRENT_TIMESTAMP),
  ('lifetime','Lifetime','lifetime','Your own copy of erd.designer, set up and run for you.',19900,'USD',50,500,'{"export": true, "codeFormats": true, "themes": true, "localCopy": true, "setup": true}'::jsonb,'["One payment, yours for life", "A copy of erd.designer for your own computer", "We set it up and run it for you", "Unlimited diagrams and tables in your copy", "Every feature unlocked"]'::jsonb,true,2,CURRENT_TIMESTAMP);

-- AlterTable
ALTER TABLE "erd_users" ADD COLUMN     "plan_expires_at" TIMESTAMP(3),
ADD COLUMN     "plan_id" TEXT NOT NULL DEFAULT 'free';

-- CreateTable
CREATE TABLE "erd_orders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "contact" TEXT NOT NULL DEFAULT '',
    "reference" TEXT NOT NULL DEFAULT '',
    "admin_note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "erd_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erd_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "erd_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "erd_admin_sessions" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erd_admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "erd_orders_user_id_created_at_idx" ON "erd_orders"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "erd_orders_status_created_at_idx" ON "erd_orders"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "erd_admin_sessions_token_hash_key" ON "erd_admin_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "erd_admin_sessions_expires_at_idx" ON "erd_admin_sessions"("expires_at");

-- AddForeignKey
ALTER TABLE "erd_users" ADD CONSTRAINT "erd_users_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "erd_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erd_orders" ADD CONSTRAINT "erd_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "erd_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erd_orders" ADD CONSTRAINT "erd_orders_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "erd_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
