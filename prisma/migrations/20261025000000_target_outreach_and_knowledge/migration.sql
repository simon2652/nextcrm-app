-- CreateEnum
CREATE TYPE "crm_Outreach_Channel" AS ENUM ('EMAIL', 'LINKEDIN', 'WHATSAPP');
CREATE TYPE "crm_Outreach_Status" AS ENUM ('PENDING', 'RESEARCHING', 'WRITING', 'READY', 'SENT', 'FAILED');
CREATE TYPE "crm_Knowledge_Status" AS ENUM ('PENDING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "crm_Targets"
  ADD COLUMN "outreach_profile"    JSONB,
  ADD COLUMN "outreach_profile_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "crm_Target_Outreach" (
    "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
    "target_id"         UUID NOT NULL,
    "channel"           "crm_Outreach_Channel" NOT NULL,
    "language"          TEXT NOT NULL DEFAULT 'fr',
    "instructions"      TEXT,
    "status"            "crm_Outreach_Status" NOT NULL DEFAULT 'PENDING',
    "subject"           TEXT,
    "body"              TEXT,
    "knowledge_sources" JSONB,
    "warnings"          TEXT[] DEFAULT ARRAY[]::TEXT[],
    "model_used"        TEXT,
    "error"             TEXT,
    "sent_at"           TIMESTAMP(3),
    "created_by"        UUID,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_Target_Outreach_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_Knowledge_Documents" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "source"          TEXT NOT NULL,
    "title"           TEXT NOT NULL,
    "content"         TEXT NOT NULL,
    "content_hash"    TEXT NOT NULL,
    "pinned"          BOOLEAN NOT NULL DEFAULT false,
    "forbidden_terms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status"          "crm_Knowledge_Status" NOT NULL DEFAULT 'PENDING',
    "error"           TEXT,
    "chunk_count"     INTEGER NOT NULL DEFAULT 0,
    "created_by"      UUID,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_Knowledge_Documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_Knowledge_Chunks" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "heading"     TEXT,
    "content"     TEXT NOT NULL,
    "embedding"   vector(1536),

    CONSTRAINT "crm_Knowledge_Chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crm_Target_Outreach_target_id_createdAt_idx" ON "crm_Target_Outreach"("target_id", "createdAt");
CREATE INDEX "crm_Target_Outreach_status_idx" ON "crm_Target_Outreach"("status");
CREATE INDEX "crm_Target_Outreach_created_by_idx" ON "crm_Target_Outreach"("created_by");
CREATE UNIQUE INDEX "crm_Knowledge_Documents_source_key" ON "crm_Knowledge_Documents"("source");
CREATE INDEX "crm_Knowledge_Chunks_document_id_idx" ON "crm_Knowledge_Chunks"("document_id");

-- AddForeignKey
ALTER TABLE "crm_Target_Outreach" ADD CONSTRAINT "crm_Target_Outreach_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "crm_Targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_Knowledge_Chunks" ADD CONSTRAINT "crm_Knowledge_Chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "crm_Knowledge_Documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
