-- AlterTable
ALTER TABLE "erd_users" ADD COLUMN     "preferences" JSONB,
ADD COLUMN     "preferences_updated_at" TIMESTAMP(3);
