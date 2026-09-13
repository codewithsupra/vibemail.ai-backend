/**
 * Gmail OAuth layer (BUILD_SEQUENCE unit 2).
 *
 * Pure Gmail-API-integration logic only: building the consent URL,
 * exchanging codes/refresh tokens, and registering push notifications.
 * Deliberately has NO persistence or encryption in it — per CLAUDE.md's
 * two-session architecture, real Supabase wiring is the schema session's
 * job, and per src/types/provider.ts's design, storage is a separate
 * concern from provider/API logic. Callers (the OAuth route handler, once
 * built) are responsible for encrypting tokens and writing them through the
 * data-access layer.
 */

import { Credentials, OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import {
  ChangeSubscription,
  ProviderApiError,
  ProviderAuthError,
  ProviderTokens,
} from "../../types/provider";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function createBaseOAuth2Client(): OAuth2Client {
  return new OAuth2Client({
    clientId: requireEnv("GOOGLE_CLIENT_ID"),
    clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
    redirectUri: requireEnv("GOOGLE_REDIRECT_URI"),
  });
}

/**
 * Maps a google-auth-library `Credentials` object to our provider-agnostic
 * `ProviderTokens` shape. `fallbackRefreshToken` covers the common case
 * where Google's response (e.g. an auto-refresh) omits `refresh_token`
 * because it hasn't changed.
 */
function credentialsToProviderTokens(
  credentials: Credentials,
  fallbackRefreshToken?: string
): ProviderTokens {
  const refreshToken = credentials.refresh_token ?? fallbackRefreshToken;
  if (!credentials.access_token || !refreshToken || !credentials.expiry_date) {
    throw new ProviderAuthError(
      "Google OAuth response is missing access_token, refresh_token, or expiry_date"
    );
  }
  return {
    accessToken: credentials.access_token,
    refreshToken,
    expiresAt: new Date(credentials.expiry_date).toISOString(),
  };
}

/**
 * Builds the Google consent-screen URL for the OAuth callback flow
 * (`EmailProvider.getAuthorizationUrl`). `state` must be generated and
 * persisted by the caller for CSRF verification at the callback
 * (CONTRACT.md Section 6a) — this function does not generate or store it.
 */
export function getAuthorizationUrl(state: string): string {
  const client = createBaseOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES,
    state,
  });
}

/**
 * Exchanges an OAuth authorization code for tokens
 * (`EmailProvider.exchangeCodeForTokens`). Throws `ProviderAuthError` if
 * Google rejects the code, or if the response is missing any of
 * access_token/refresh_token/expiry_date.
 */
export async function exchangeCodeForTokens(
  code: string
): Promise<ProviderTokens> {
  const client = createBaseOAuth2Client();
  let tokens: Credentials;
  try {
    ({ tokens } = await client.getToken(code));
  } catch (error) {
    throw new ProviderAuthError("Google rejected the authorization code", {
      cause: error,
    });
  }
  return credentialsToProviderTokens(tokens);
}

/**
 * Uses a stored refresh token to obtain a new access token
 * (`EmailProvider.refreshAccessToken`). Google does not generally rotate
 * the refresh token on an ordinary refresh, so the original is carried
 * through unless Google's response includes a new one.
 */
export async function refreshAccessToken(
  refreshToken: string
): Promise<ProviderTokens> {
  const client = createBaseOAuth2Client();
  client.setCredentials({ refresh_token: refreshToken });

  let credentials: Credentials;
  try {
    ({ credentials } = await client.refreshAccessToken());
  } catch (error) {
    throw new ProviderAuthError(
      "Failed to refresh access token — refresh token may be invalid or revoked",
      { cause: error }
    );
  }
  return credentialsToProviderTokens(credentials, refreshToken);
}

/**
 * Builds an authenticated OAuth2Client for a user's current tokens.
 *
 * This is the "token persistence listener" mechanism: googleapis clients
 * auto-refresh an expired access token transparently during API calls and
 * emit a `'tokens'` event with the new credentials. When `onTokensRefreshed`
 * is supplied, it is invoked with the refreshed `ProviderTokens` so the
 * caller can persist them (encrypting first) — this function itself does
 * not persist or encrypt anything, keeping storage concerns out of the
 * provider layer.
 */
export function createOAuth2Client(
  tokens: ProviderTokens,
  onTokensRefreshed?: (tokens: ProviderTokens) => void | Promise<void>
): OAuth2Client {
  const client = createBaseOAuth2Client();
  client.setCredentials({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expiry_date: Date.parse(tokens.expiresAt),
  });

  if (onTokensRefreshed) {
    client.on("tokens", (credentials) => {
      const refreshed = credentialsToProviderTokens(
        credentials,
        tokens.refreshToken
      );
      void onTokensRefreshed(refreshed);
    });
  }

  return client;
}

/**
 * Registers Gmail push notifications (`users.watch`) and returns the
 * resulting resume point (`EmailProvider.subscribeToChanges`).
 *
 * Note: Gmail's `watch()` response only ever contains `historyId` and
 * `expiration` (per `Schema$WatchResponse`) — it has no `resourceId` field.
 * That's a Google Calendar API concept, not Gmail's; there is nothing to
 * store here beyond the resume token and its expiry.
 */
export async function subscribeToChanges(
  tokens: ProviderTokens
): Promise<ChangeSubscription> {
  const client = createOAuth2Client(tokens);
  const gmail = google.gmail({ version: "v1", auth: client });

  let historyId: string | null | undefined;
  let expiration: string | null | undefined;
  try {
    const response = await gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName: requireEnv("GOOGLE_PUBSUB_TOPIC"),
        labelIds: ["INBOX"],
      },
    });
    historyId = response.data.historyId;
    expiration = response.data.expiration;
  } catch (error) {
    throw new ProviderApiError("Gmail users.watch call failed", {
      cause: error,
    });
  }

  if (!historyId || !expiration) {
    throw new ProviderApiError(
      "Gmail users.watch response is missing historyId or expiration"
    );
  }

  return {
    resumeToken: historyId,
    expiresAt: new Date(Number(expiration)).toISOString(),
  };
}
