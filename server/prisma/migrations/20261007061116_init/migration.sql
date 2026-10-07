-- CreateTable
CREATE TABLE "erd_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erd_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erd_sessions" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erd_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erd_diagrams" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "erd_diagrams_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "erd_users_email_key" ON "erd_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "erd_sessions_token_hash_key" ON "erd_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "erd_sessions_user_id_idx" ON "erd_sessions"("user_id");

-- CreateIndex
CREATE INDEX "erd_sessions_expires_at_idx" ON "erd_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "erd_diagrams_user_id_key" ON "erd_diagrams"("user_id");

-- AddForeignKey
ALTER TABLE "erd_sessions" ADD CONSTRAINT "erd_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "erd_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erd_diagrams" ADD CONSTRAINT "erd_diagrams_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "erd_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
