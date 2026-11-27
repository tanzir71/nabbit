import type { TackErrorCode } from "./tackApi";
const messages: Record<TackErrorCode, string> = {
  invalidServer: "Enter an HTTPS Tack address without a username, password, query or fragment.",
  invalidResponse: "This address did not return a supported Tack API v4 response.",
  invalidInput: "Check the requested details and try again.",
  secureStorage: "The secure session or protected clipboard could not be accessed. Try again.",
  localStorage: "Notes could not be saved on this device. Your queued changes are preserved.",
  signedOut: "Sign in to Tack to continue. Check your username and password.",
  workspaceChanged: "The Tack account or workspace changed. Reopen the connection to review it.",
  storageFull: "This Tack workspace is full. Your queued changes are preserved.",
  recoveryPending: "Save and confirm your recovery code before syncing.",
  rateLimited: "Tack has limited attempts. Wait before trying again.",
  conflict: "A note needs a conflict decision. Your local version is preserved.",
  offline: "Tack could not be reached. Your notes and queued changes are preserved.",
};
export function tackError(reason: unknown): { message: string; retryAfterMs: number } {
  // Never render a request, server body or arbitrary IPC rejection.
  const code =
    typeof reason === "object" && reason !== null && "code" in reason ? String(reason.code) : "";
  const delay =
    typeof reason === "object" &&
    reason !== null &&
    "retryAfterMs" in reason &&
    typeof reason.retryAfterMs === "number"
      ? reason.retryAfterMs
      : 0;
  const retryAfterMs = Number.isFinite(delay) ? Math.max(0, Math.min(delay, 2_147_483_647)) : 0;
  return {
    message: Object.prototype.hasOwnProperty.call(messages, code)
      ? messages[code as TackErrorCode]
      : "The Tack action could not be completed. Try again.",
    retryAfterMs,
  };
}
export function validTackAddress(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (
      value.length <= 2048 &&
      url.protocol === "https:" &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
