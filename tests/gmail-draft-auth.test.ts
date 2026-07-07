/**
 * Tests for the Gmail OAuth2 auth helper in lib/gmail-draft.ts.
 *
 * Verifies:
 *   - buildGmailOAuthClient() throws GmailConfigError listing missing env vars
 *   - buildGmailOAuthClient() throws GmailAuthError on invalid_grant from getAccessToken()
 *   - non-auth errors from getAccessToken() propagate unchanged
 *   - createGmailDraft() surfaces GmailAuthError when drafts.create() itself
 *     returns an auth failure (token revoked mid-request)
 *   - createGmailDraft() never uses Calendar's service account auth
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccessTokenMock = vi.fn();
const draftsCreateMock = vi.fn();

vi.mock("googleapis", () => {
  class OAuth2Mock {
    clientId: string;
    clientSecret: string;
    credentials: unknown;
    constructor(clientId: string, clientSecret: string) {
      this.clientId = clientId;
      this.clientSecret = clientSecret;
    }
    setCredentials(creds: unknown) {
      this.credentials = creds;
    }
    getAccessToken() {
      return getAccessTokenMock();
    }
  }

  return {
    google: {
      auth: { OAuth2: OAuth2Mock },
      gmail: vi.fn(() => ({
        users: { drafts: { create: draftsCreateMock } },
      })),
    },
  };
});

import { buildGmailOAuthClient, createGmailDraft, GmailAuthError, GmailConfigError } from "@/lib/gmail-draft";

beforeEach(() => {
  getAccessTokenMock.mockReset();
  draftsCreateMock.mockReset();
  getAccessTokenMock.mockResolvedValue({ token: "fake-access-token" });
  draftsCreateMock.mockResolvedValue({
    data: { id: "draft-1", message: { id: "msg-1", threadId: "thread-1" } },
  });
});

describe("buildGmailOAuthClient — missing env vars", () => {
  it("throws GmailConfigError naming all missing vars", async () => {
    await expect(
      buildGmailOAuthClient({ clientId: undefined, clientSecret: undefined, gmailRefreshToken: undefined }),
    ).rejects.toThrow(GmailConfigError);

    try {
      await buildGmailOAuthClient({ clientId: undefined, clientSecret: undefined, gmailRefreshToken: undefined });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(GmailConfigError);
      expect((err as Error).message).toContain("GOOGLE_CLIENT_ID");
      expect((err as Error).message).toContain("GOOGLE_CLIENT_SECRET");
      expect((err as Error).message).toContain("GOOGLE_GMAIL_REFRESH_TOKEN");
    }
    expect(getAccessTokenMock).not.toHaveBeenCalled();
  });

  it("throws GmailConfigError naming only the missing refresh token", async () => {
    try {
      await buildGmailOAuthClient({ clientId: "id", clientSecret: "secret", gmailRefreshToken: undefined });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(GmailConfigError);
      expect((err as Error).message).toContain("GOOGLE_GMAIL_REFRESH_TOKEN");
      expect((err as Error).message).not.toContain("GOOGLE_CLIENT_ID");
    }
  });

  it("treats an empty-string refresh token as missing", async () => {
    await expect(
      buildGmailOAuthClient({ clientId: "id", clientSecret: "secret", gmailRefreshToken: "" }),
    ).rejects.toThrow(GmailConfigError);
  });
});

describe("buildGmailOAuthClient — token refresh", () => {
  it("throws GmailAuthError when getAccessToken() rejects with invalid_grant", async () => {
    getAccessTokenMock.mockRejectedValue(new Error("invalid_grant"));

    await expect(
      buildGmailOAuthClient({ clientId: "id", clientSecret: "secret", gmailRefreshToken: "revoked-token" }),
    ).rejects.toThrow(GmailAuthError);
  });

  it("GmailAuthError carries the friendly reconnect message and typed code", async () => {
    getAccessTokenMock.mockRejectedValue(new Error("invalid_grant: Token has been expired or revoked."));

    try {
      await buildGmailOAuthClient({ clientId: "id", clientSecret: "secret", gmailRefreshToken: "revoked-token" });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(GmailAuthError);
      expect((err as GmailAuthError).code).toBe("GMAIL_AUTH_INVALID_GRANT");
      expect((err as Error).message).not.toContain("invalid_grant");
      expect((err as Error).message.toLowerCase()).toContain("reconnect");
    }
  });

  it("propagates non-auth errors from getAccessToken() unchanged", async () => {
    getAccessTokenMock.mockRejectedValue(new Error("ECONNRESET"));

    await expect(
      buildGmailOAuthClient({ clientId: "id", clientSecret: "secret", gmailRefreshToken: "token" }),
    ).rejects.toThrow("ECONNRESET");
  });

  it("returns a warmed OAuth2 client on success", async () => {
    const auth = await buildGmailOAuthClient({ clientId: "id", clientSecret: "secret", gmailRefreshToken: "token" });
    expect(getAccessTokenMock).toHaveBeenCalledOnce();
    expect(auth).toBeDefined();
  });
});

describe("createGmailDraft — auth wiring", () => {
  const baseOpts = {
    clientId: "id",
    clientSecret: "secret",
    gmailRefreshToken: "token",
    from: "Jeff Ulsh <jeffulsh@gmail.com>",
    to: ["client@example.com"],
    subject: "Test",
    textBody: "hi",
    htmlBody: "<p>hi</p>",
    attachments: [],
  };

  it("throws GmailAuthError when the refresh token is invalid before ever calling drafts.create", async () => {
    getAccessTokenMock.mockRejectedValue(new Error("invalid_grant"));

    await expect(createGmailDraft(baseOpts)).rejects.toThrow(GmailAuthError);
    expect(draftsCreateMock).not.toHaveBeenCalled();
  });

  it("throws GmailAuthError when drafts.create() itself returns an auth failure", async () => {
    draftsCreateMock.mockRejectedValue(Object.assign(new Error("invalid_grant"), { status: 401 }));

    await expect(createGmailDraft(baseOpts)).rejects.toThrow(GmailAuthError);
  });

  it("succeeds and returns draft/message/thread ids using only OAuth2 (never Calendar SA)", async () => {
    const result = await createGmailDraft(baseOpts);
    expect(result.draftId).toBe("draft-1");
    expect(result.messageId).toBe("msg-1");
    expect(result.threadId).toBe("thread-1");
    expect(getAccessTokenMock).toHaveBeenCalledOnce();
  });
});
