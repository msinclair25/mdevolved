import { z } from "zod";

export const oauthGrantPropsSchema = z
  .object({
    audience: z.string().url().max(2_048),
    clientId: z.string().min(1).max(2_048),
    grantId: z.string().uuid(),
    grantKind: z.enum(["vault", "collaboration"]),
    ownerId: z.literal(1),
  })
  .strict();

export const oauthAccessPropsSchema = oauthGrantPropsSchema.extend({
  tokenScopes: z.array(z.string().min(1).max(128)).max(32),
});
