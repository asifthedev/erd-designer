-- CreateTable
CREATE TABLE "erd_rate_limits" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "reset_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "erd_rate_limits_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "erd_rate_limits_reset_at_idx" ON "erd_rate_limits"("reset_at");
