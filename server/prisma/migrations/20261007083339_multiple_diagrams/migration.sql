-- DropIndex
DROP INDEX "erd_diagrams_user_id_key";

-- AlterTable
ALTER TABLE "erd_diagrams" ADD COLUMN     "title" TEXT NOT NULL DEFAULT 'Untitled diagram';

-- CreateIndex
CREATE INDEX "erd_diagrams_user_id_created_at_idx" ON "erd_diagrams"("user_id", "created_at");
