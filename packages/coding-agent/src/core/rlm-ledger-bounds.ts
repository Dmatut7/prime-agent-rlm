/**
 * Neutral home for the RLM spawn ledger's bounds.
 *
 * The writer (`modes/daemon/rlm-ledger.ts`) and the retention reader
 * (`core/retention/ledger-scan.ts`) must agree on the numbers: a ledger the
 * writer considers legal has to be scannable by the sweep, and a ledger the
 * reader refuses has to be treated as unknown (conservative keep) rather than
 * as "no children". `core/retention` must not import from `modes/daemon`, so
 * the constants live here and both sides import them.
 */

/** Bounded read: a ledger beyond these limits fails closed loudly. */
export const RLM_LEDGER_MAX_BYTES = 32 * 1024 * 1024;
export const RLM_LEDGER_MAX_RECORDS = 100_000;
