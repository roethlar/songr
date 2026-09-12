import type { BrowseResult } from "./types";

export type BrowseActionOutcome =
  | { kind: "executed" }
  | { kind: "refused"; message: string }
  | { kind: "unknown" };

const PUBLIC_ACTIONS = new Set([
  "none", "list", "message", "replace_item", "remove_item",
]);

/** Classify a public Browse reply without treating callback success as acceptance. */
export function classifyBrowseActionOutcome(
  response: Pick<BrowseResult, "action" | "message" | "isError">
): BrowseActionOutcome {
  if (response.isError === true) {
    // Match the existing action-error contracts: nonempty, no control characters,
    // no surrounding whitespace, at most 1024 characters.
    const message = response.message?.replace(/\p{Cc}/gu, " ")
      .trim().slice(0, 1024).trim();
    return { kind: "refused", message: message || "Roon refused this action." };
  }
  return response.action !== undefined && PUBLIC_ACTIONS.has(response.action)
    ? { kind: "executed" }
    : { kind: "unknown" };
}
