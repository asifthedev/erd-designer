-- CreateTable
CREATE TABLE "erd_email_codes" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erd_email_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "erd_email_codes_email_purpose_created_at_idx" ON "erd_email_codes"("email", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "erd_email_codes_expires_at_idx" ON "erd_email_codes"("expires_at");
