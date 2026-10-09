-- CreateTable
CREATE TABLE "erd_ai_usage" (
    "user_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "erd_ai_usage_pkey" PRIMARY KEY ("user_id","day")
);

-- CreateIndex
CREATE INDEX "erd_ai_usage_day_idx" ON "erd_ai_usage"("day");

-- AddForeignKey
ALTER TABLE "erd_ai_usage" ADD CONSTRAINT "erd_ai_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "erd_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
