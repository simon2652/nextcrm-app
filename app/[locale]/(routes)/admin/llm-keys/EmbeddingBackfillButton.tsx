"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { requestEmbeddingBackfill } from "../actions/embeddings";

export function EmbeddingBackfillButton() {
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      const result = await requestEmbeddingBackfill();
      if (result.error) toast.error(result.error);
      else toast.success("Embedding recompute started in the background");
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={isPending}>
      {isPending ? "Starting…" : "Recompute embeddings"}
    </Button>
  );
}
