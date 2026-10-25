import { getSystemApiKeys } from "../actions/api-keys";
import { ProviderKeyCard } from "./ProviderKeyCard";
import { EmbeddingBackfillButton } from "./EmbeddingBackfillButton";
import { getSession } from "@/lib/auth-server";
import Container from "../../components/ui/Container";
import { getTranslations } from "next-intl/server";
import { AlertCircle } from "lucide-react";

export default async function LlmKeysPage() {
  const session = await getSession();
  const t = await getTranslations("AdminPage");

  if (session?.user?.role !== "admin") {
    return (
      <Container title="AI Provider Keys" description="LLM API key management">
        <div className="flex w-full h-full items-center justify-center">
          {t("accessNotAllowed")}
        </div>
      </Container>
    );
  }

  const keys = await getSystemApiKeys();

  return (
    <Container
      title="AI Provider Keys"
      description="Priority: ENV → System-wide → User profile"
    >
      <div className="space-y-6 max-w-2xl">
        {/* Info banner */}
        <div className="flex gap-3 rounded-md border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <p>
            System-wide keys are used when no ENV variable is set. Users can configure
            their own keys in profile settings. All AI features (including target
            enrichment) go through the AI router: providers with a key are tried in the order
            OpenAI → Gemini → OpenRouter → Anthropic, with several models each, and the next one
            takes over when a model fails or a provider is rate-limited.
            Embeddings, semantic search and the product knowledge base require a Gemini key;
            web research for AI outreach (LinkedIn profiles) requires a Gemini or OpenRouter key.
          </p>
        </div>

        {/* Provider cards */}
        <div className="grid gap-4">
          {keys.map((status) => (
            <ProviderKeyCard key={status.provider} status={status} />
          ))}
        </div>

        <div className="flex items-center justify-between gap-4 rounded-md border px-4 py-3 text-sm">
          <p className="text-muted-foreground">
            Recompute the vectors used by semantic search and &quot;Find similar&quot;
            for every account, contact, lead, opportunity and linked email.
          </p>
          <EmbeddingBackfillButton />
        </div>
      </div>
    </Container>
  );
}
