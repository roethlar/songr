/**
 * Applies the controller API's browser request defaults.
 *
 * Empty POST/DELETE requests must not claim to carry JSON: Express's JSON
 * parser turns a zero-byte request with that content type into `{}`, which
 * strict bodyless routes correctly reject as a body.
 */
export function buildApiRequestInit(init?: RequestInit): RequestInit {
  return {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body !== undefined && init.body !== null
        ? { "Content-Type": "application/json" }
        : {}),
      ...init?.headers,
    },
  };
}
