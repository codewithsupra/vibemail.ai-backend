/**
 * Provider abstraction contract.
 *
 * Every email backend (Gmail today, under src/providers/gmail/; IMAP/Outlook
 * later, under src/providers/imap/ and similar) must implement `EmailProvider`
 * exactly as defined here.
 *
 * HARD RULE: nothing in this file may import from `googleapis` or reference
 * any Gmail wire-format type (e.g. `Schema$Message`, `OAuth2Client`,
 * `gmail_v1.*`). All shapes below are provider-neutral; each provider
 * implementation is responsible for mapping its own native shapes onto
 * these types and back.
 */

// ---------------------------------------------------------------------------
// Auth / tokens
// ---------------------------------------------------------------------------

export interface ProviderTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO 8601. Providers must convert their native expiry representation
   * (e.g. Gmail's `expiry_date` epoch-ms number) to ISO before returning it
   * here, to match the settled domain model's timestamp convention. */
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface ProviderMessage {
  id: string;
  threadId: string;
  subject: string | null;
  fromAddress: string;
  toAddress: string;
  snippet: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  /** Generic tag/folder/flag identifiers. Gmail implementations populate
   * this directly from the API's labelIds; other providers map their own
   * folder/flag model onto equivalent string tags (e.g. IMAP `\Seen`,
   * mailbox names). Named to match the already-settled
   * `StoredMessage.labelIds` field and CONTRACT.md's `label` query param —
   * this is an established domain concept, not a Gmail-specific leak. */
  labelIds: string[];
  isRead: boolean;
  /** ISO 8601. */
  internalDate: string;
  sizeEstimate: number;
}

export interface ListMessagesOptions {
  cursor?: string;
  limit?: number;
  label?: string;
  isRead?: boolean;
}

export interface ListMessagesResult {
  messages: ProviderMessage[];
  nextCursor: string | null;
}

export interface SendMessageInput {
  to: string;
  subject: string;
  /** At least one of bodyText/bodyHtml is required. Enforced at the route
   * layer as a `validation_error` (see CONTRACT.md Section 6), not at the
   * type level — the provider implementation still has to branch on which
   * is present to build the outgoing message, so a discriminated union here
   * would not remove that runtime check. */
  bodyText?: string;
  bodyHtml?: string;
}

// ---------------------------------------------------------------------------
// Real-time sync (generalizes Gmail's watch() / history.list)
// ---------------------------------------------------------------------------

export interface ChangeSubscription {
  /** Opaque resume point for listChanges. Generalizes Gmail's historyId. */
  resumeToken: string;
  /** ISO 8601. Generalizes Gmail watch()'s `expiration`. */
  expiresAt: string;
}

export interface ReadStatusChange {
  messageId: string;
  isRead: boolean;
}

export interface ChangesResult {
  messagesAdded: ProviderMessage[];
  /**
   * Read/unread transitions observed since the given resume token, deduped
   * by messageId (last state wins) across every page the implementation
   * walked internally. Per CONTRACT.md Section 5, only UNREAD-equivalent
   * transitions are surfaced here — this is not a generic mirror of every
   * label/flag change a provider might report.
   */
  readStatusChanges: ReadStatusChange[];
  /** Resume token to persist for the next listChanges call. */
  nextResumeToken: string;
}

// ---------------------------------------------------------------------------
// Errors
//
// Route/sync-layer code catches these generically (instanceof checks) to
// implement CONTRACT.md's typed error responses (reauth_required,
// rate_limited, gmail_api_error, gmail_send_failed, etc.) without needing to
// know which provider is active.
// ---------------------------------------------------------------------------

export class ProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Auth/token failure not resolvable by refreshing (e.g. revoked grant). */
export class ProviderAuthError extends ProviderError {}

/** Provider-side rate limiting (e.g. Gmail 429). */
export class ProviderRateLimitedError extends ProviderError {}

/** Any other non-2xx provider API failure. */
export class ProviderApiError extends ProviderError {}

/** Thrown by listChanges when resumeToken is no longer valid (Gmail: 404
 * from history.list). Callers must fall back to a full re-sync rather than
 * surfacing this as a hard error to the end user. */
export class ProviderSyncCursorExpiredError extends ProviderError {}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface EmailProvider {
  // OAuth
  getAuthorizationUrl(state: string): string;
  exchangeCodeForTokens(code: string): Promise<ProviderTokens>;
  refreshAccessToken(refreshToken: string): Promise<ProviderTokens>;

  // Messages
  listMessages(
    tokens: ProviderTokens,
    options?: ListMessagesOptions
  ): Promise<ListMessagesResult>;
  sendMessage(
    tokens: ProviderTokens,
    input: SendMessageInput
  ): Promise<ProviderMessage>;
  setMessageReadStatus(
    tokens: ProviderTokens,
    messageId: string,
    isRead: boolean
  ): Promise<ProviderMessage>;

  // Real-time sync
  subscribeToChanges(tokens: ProviderTokens): Promise<ChangeSubscription>;
  listChanges(
    tokens: ProviderTokens,
    resumeToken: string
  ): Promise<ChangesResult>;
}
