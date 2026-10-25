"use server";
import { prismadb } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { encrypt, decrypt } from "@/lib/email-crypto";
import { ApiKeyProvider } from "@prisma/client";
import { envApiKey } from "@/lib/api-keys";
import {
  requireRole,
  AuthenticationError,
  AuthorizationError,
} from "@/lib/authz";

async function ensureAdmin(): Promise<void> {
  try {
    await requireRole(["admin"]);
  } catch (e) {
    if (e instanceof AuthenticationError) throw new Error("Unauthorized");
    if (e instanceof AuthorizationError) throw new Error("Forbidden");
    throw e;
  }
}

export type ProviderStatus = {
  provider: ApiKeyProvider;
  source: "ENV_ACTIVE" | "SYSTEM_SET" | "NOT_CONFIGURED";
  maskedKey?: string;
};

export async function getSystemApiKeys(): Promise<ProviderStatus[]> {
  await ensureAdmin();

  const providers = Object.values(ApiKeyProvider) as ApiKeyProvider[];

  return Promise.all(
    providers.map(async (provider): Promise<ProviderStatus> => {
      const envValue = envApiKey(provider);
      if (envValue) {
        return {
          provider,
          source: "ENV_ACTIVE",
          maskedKey: "••••" + envValue.slice(-4),
        };
      }

      const row = await prismadb.apiKeys.findFirst({
        where: { scope: "SYSTEM", provider },
        select: { encryptedKey: true },
      });

      if (row) {
        const plaintext = decrypt(row.encryptedKey);
        return {
          provider,
          source: "SYSTEM_SET",
          maskedKey: "••••" + plaintext.slice(-4),
        };
      }

      return { provider, source: "NOT_CONFIGURED" };
    })
  );
}

export async function upsertSystemApiKey(
  provider: ApiKeyProvider,
  key: string
): Promise<void> {
  await ensureAdmin();

  const encryptedKey = encrypt(key);

  await prismadb.$transaction([
    prismadb.apiKeys.deleteMany({
      where: { scope: "SYSTEM", provider },
    }),
    prismadb.apiKeys.create({
      data: {
        scope: "SYSTEM",
        provider,
        encryptedKey,
      },
    }),
  ]);

  revalidatePath("/(en)/admin/llm-keys");
}

export async function deleteSystemApiKey(provider: ApiKeyProvider): Promise<void> {
  await ensureAdmin();

  await prismadb.apiKeys.deleteMany({
    where: { scope: "SYSTEM", provider },
  });

  revalidatePath("/(en)/admin/llm-keys");
}
