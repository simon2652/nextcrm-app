"use server";
import { getSession } from "@/lib/auth-server";

import { prismadb } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { encrypt, decrypt } from "@/lib/email-crypto";
import { ApiKeyProvider } from "@prisma/client";
import { envApiKey } from "@/lib/api-keys";

export type UserProviderStatus = {
  provider: ApiKeyProvider;
  source: "ENV_ACTIVE" | "SYSTEM_SET" | "USER_SET" | "NOT_CONFIGURED";
  maskedKey?: string;
  higherTierActive: boolean;
};

export async function getUserApiKeys(): Promise<UserProviderStatus[]> {
  const session = await getSession();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const userId = session.user.id;
  const providers = Object.values(ApiKeyProvider) as ApiKeyProvider[];

  return Promise.all(
    providers.map(async (provider): Promise<UserProviderStatus> => {
      // 1. Check ENV
      const envValue = envApiKey(provider);
      if (envValue) {
        return {
          provider,
          source: "ENV_ACTIVE",
          maskedKey: "••••" + envValue.slice(-4),
          higherTierActive: true,
        };
      }

      // 2. Check SYSTEM row
      const systemRow = await prismadb.apiKeys.findFirst({
        where: { scope: "SYSTEM", provider },
        select: { encryptedKey: true },
      });

      if (systemRow) {
        const plaintext = decrypt(systemRow.encryptedKey);
        return {
          provider,
          source: "SYSTEM_SET",
          maskedKey: "••••" + plaintext.slice(-4),
          higherTierActive: true,
        };
      }

      // 3. Check USER row
      const userRow = await prismadb.apiKeys.findFirst({
        where: { scope: "USER", provider, userId },
        select: { encryptedKey: true },
      });

      if (userRow) {
        const plaintext = decrypt(userRow.encryptedKey);
        return {
          provider,
          source: "USER_SET",
          maskedKey: "••••" + plaintext.slice(-4),
          higherTierActive: false,
        };
      }

      // 4. Not configured
      return { provider, source: "NOT_CONFIGURED", higherTierActive: false };
    })
  );
}

export async function upsertUserApiKey(
  provider: ApiKeyProvider,
  key: string
): Promise<void> {
  const session = await getSession();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const userId = session.user.id;
  const encryptedKey = encrypt(key);

  await prismadb.$transaction([
    prismadb.apiKeys.deleteMany({
      where: { scope: "USER", provider, userId },
    }),
    prismadb.apiKeys.create({
      data: {
        scope: "USER",
        provider,
        userId,
        encryptedKey,
      },
    }),
  ]);

  revalidatePath("/(en)/profile");
}

export async function deleteUserApiKey(provider: ApiKeyProvider): Promise<void> {
  const session = await getSession();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const userId = session.user.id;

  await prismadb.apiKeys.deleteMany({
    where: { scope: "USER", provider, userId },
  });

  revalidatePath("/(en)/profile");
}
