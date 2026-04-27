export const EDITOR_TOKEN_SESSION_KEY = "la-schedule-editor-token";

export function sanitizeEditorToken(raw: string | null | undefined): string | null {
  const token = raw?.trim() ?? "";
  return token.length > 0 ? token : null;
}
