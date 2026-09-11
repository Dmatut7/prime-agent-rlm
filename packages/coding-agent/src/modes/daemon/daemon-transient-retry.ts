/**
 * One merged bound for transient retries (B9/L4).
 *
 * Two sides can amplify a peer that is temporarily unable to answer: the
 * supervisor retries a lagging client's catch-up, and a daemon client retries a
 * command the daemon rejected with a `retryAfterMs` hint. Both sides use these
 * numbers, so a permanently recovering session is re-probed at most
 * `TRANSIENT_RETRY_MAX_ATTEMPTS` times inside `TRANSIENT_RETRY_WINDOW_MS` per
 * side instead of the two bounds multiplying. `test/daemon-client-transient-retry.test.ts`
 * pins the supervisor's catch-up policy to the same pair, so the bound cannot
 * drift apart silently.
 */
export const TRANSIENT_RETRY_MAX_ATTEMPTS = 40;
export const TRANSIENT_RETRY_WINDOW_MS = 5 * 60_000;
