import log from './logger';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';

export interface UserAuth {
  authenticated: boolean;
  access_token?: string;
  x_user_id?: string;
  x_username?: string;
  x_name?: string;
  // Seeded data for personalized greetings
  following?: Array<{ id: string; username: string; name: string }>;
  liked_tweets?: Array<{
    id: string;
    text: string;
    author_username: string;
    author_name: string;
  }>;
  seeded_at?: string;
}

/**
 * Get user's X access token by phone number from the Django backend.
 * Returns authentication status and tokens if the user has connected their X account.
 */
export async function getUserAuth(phoneNumber: string): Promise<UserAuth> {
  try {
    log.app.info(`[UserAuth] Looking up user by phone: ${phoneNumber}`);

    const response = await fetch(
      `${BACKEND_URL}/api/users/token?phone=${encodeURIComponent(phoneNumber)}`
    );

    if (!response.ok) {
      if (response.status === 404) {
        log.app.info(`[UserAuth] User not found (not authenticated)`);
        return { authenticated: false };
      }
      log.app.warn(`[UserAuth] Backend returned status ${response.status}`);
      return { authenticated: false };
    }

    const data = await response.json() as UserAuth;

    if (data.authenticated) {
      log.app.info(`[UserAuth] User authenticated as @${data.x_username}`);
    }

    return data;
  } catch (error) {
    log.app.error(`[UserAuth] Failed to get user auth: ${error}`);
    return { authenticated: false };
  }
}

// Export a user context that can be shared across the call
export interface UserContext {
  phoneNumber: string;
  auth: UserAuth;
}

// Store for active call contexts (keyed by callId)
const activeCallContexts = new Map<string, UserContext>();

/**
 * Initialize user context for a call
 */
export async function initUserContext(callId: string, phoneNumber: string): Promise<UserContext> {
  const auth = await getUserAuth(phoneNumber);
  const context: UserContext = {
    phoneNumber,
    auth,
  };
  activeCallContexts.set(callId, context);
  return context;
}

/**
 * Get user context for an active call
 */
export function getCallContext(callId: string): UserContext | undefined {
  return activeCallContexts.get(callId);
}

/**
 * Clean up user context when call ends
 */
export function cleanupCallContext(callId: string): void {
  activeCallContexts.delete(callId);
}
