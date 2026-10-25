import { AlertCircle } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/auth-server";
import Container from "../../components/ui/Container";
import { listKnowledgeDocuments } from "../actions/knowledge";
import { KnowledgeManager } from "./KnowledgeManager";

export default async function KnowledgePage() {
  const session = await getSession();
  const t = await getTranslations("AdminPage");

  if (session?.user?.role !== "admin") {
    return (
      <Container title="Product knowledge" description="Knowledge used by AI writing">
        <div className="flex w-full h-full items-center justify-center">{t("accessNotAllowed")}</div>
      </Container>
    );
  }

  const result = await listKnowledgeDocuments();
  const documents = "error" in result ? [] : result.documents;

  return (
    <Container title="Product knowledge" description="Markdown documents the AI uses to write personalised prospect messages">
      <div className="space-y-6 max-w-4xl">
        <div className="flex gap-3 rounded-md border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p>
              Import your product documents (.md / .txt: messaging, proof library, argumentaire, positioning…). They are
              stored in the CRM database and split into excerpts indexed with Gemini embeddings, so they are available
              wherever the app runs. For each message, the excerpts closest to the prospect&apos;s persona are given to the AI.
            </p>
            <p>
              A confidentiality list (.json with <code>termes_interdits</code> / <code>forbidden_terms</code>) blocks
              customer, prospect and competitor names in generated messages. Re-importing a file updates it in place.
            </p>
          </div>
        </div>
        <KnowledgeManager documents={documents} />
      </div>
    </Container>
  );
}
