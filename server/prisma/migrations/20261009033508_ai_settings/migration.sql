-- CreateTable
CREATE TABLE "erd_ai_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "gateway_base_url" TEXT,
    "gateway_key_enc" TEXT,
    "anthropic_key_enc" TEXT,
    "models" JSONB,
    "offer_all_models" BOOLEAN NOT NULL DEFAULT false,
    "default_model" TEXT,
    "daily_limit_free" INTEGER,
    "daily_limit_paid" INTEGER,
    "max_daily_spend_usd" DOUBLE PRECISION,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "erd_ai_settings_pkey" PRIMARY KEY ("id")
);
