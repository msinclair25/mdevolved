import { materializedSearchQuerySchema } from "@mdevolved/contracts";
import { ApiProblem } from "./api-problem";

export function buildMaterializedFtsQuery(raw: string): string {
  const parsed = materializedSearchQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiProblem(
      400,
      "search_query_invalid",
      "Enter a search using letters or numbers.",
    );
  }
  const tokens = parsed.data.normalize("NFC").match(/[\p{L}\p{N}_-]+/gu);
  if (tokens === null || tokens.length === 0) {
    throw new ApiProblem(
      400,
      "search_query_invalid",
      "Enter a search using letters or numbers.",
    );
  }
  return tokens
    .slice(0, 12)
    .map((token) => `"${token}"`)
    .join(" AND ");
}
