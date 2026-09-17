import { describe, expect, it } from "vitest";
import { SessionAlreadyActiveError } from "../src/core/session-lease.js";
import {
	DaemonSessionCreateError,
	deserializeDaemonCreateError,
	deserializeDaemonError,
} from "../src/modes/daemon/daemon-errors.js";
import type { DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";

describe("deserializeDaemonCreateError", () => {
	it("wraps generic create failures so the CLI boundary prints one line instead of rethrowing", () => {
		const error = deserializeDaemonCreateError({
			type: "response",
			command: "create",
			success: false,
			error: "Failed to spawn session worker: spawn node EMFILE",
		});
		expect(error).toBeInstanceOf(DaemonSessionCreateError);
		expect(error.message).toContain("EMFILE");
	});

	it("preserves typed daemon errors for their dedicated boundaries", () => {
		const error = deserializeDaemonCreateError({
			type: "response",
			command: "create",
			success: false,
			error: "session already active",
			errorInfo: { code: "session_already_active", sessionPath: "/tmp/session.jsonl" },
		});
		expect(error).toBeInstanceOf(SessionAlreadyActiveError);
	});
});

describe("unknown errorInfo downgrade (rev38 contract)", () => {
	it("keeps a well-formed unknown code losing its payload rather than mis-typing it", () => {
		// The wire can carry an errorInfo code this build does not know. The downgrade
		// contract is the switch's fallthrough - the daemon's own message lands as a plain
		// Error, so an older client prints diagnostics instead of crashing on an unknown
		// variant. This half is the real guard: it fails if someone starts pattern-matching
		// on errorInfo's bare presence instead of the code.
		const futureCode = {
			type: "response",
			command: "attach",
			success: false,
			error: "daemon said no",
			errorInfo: { code: "some_future_code", activeSessionId: "active-1", extra: 1 },
		} as unknown as Extract<DaemonResponse, { success: false }>;
		const error = deserializeDaemonError(futureCode);
		expect(error.constructor).toBe(Error);
		expect(error.message).toBe("daemon said no");
	});

	it("keeps a code this wire does carry typed instead of routing it through the fallthrough", () => {
		// Positive control for the assertion above: without this half the fallthrough test
		// would stay green even if the typed branches were deleted, i.e. it could not tell
		// "unknown code degraded" from "every code degraded".
		//
		// The control deliberately uses session_already_active rather than upstream #2028's
		// session_recovering: on the P3-merged landing tree the recovering failure *info* is
		// class-only (DaemonSessionRecoveringError is thrown and retried in-process by
		// daemon-supervisor, and DaemonErrorInfo has no session_recovering row), so no wire
		// response can produce it here and a test asserting otherwise would pin a face this
		// tree does not have.
		const taken = {
			type: "response",
			command: "attach",
			success: false,
			error: "session already active",
			errorInfo: { code: "session_already_active", sessionPath: "/tmp/session.jsonl", activeSessionId: "active-1" },
		} as unknown as Extract<DaemonResponse, { success: false }>;
		const error = deserializeDaemonError(taken);
		expect(error).toBeInstanceOf(SessionAlreadyActiveError);
		expect((error as SessionAlreadyActiveError).activeSessionId).toBe("active-1");
	});

	it("keeps the create-error wrapper for untyped failures only, and the message for both", () => {
		// The wrapper is chosen by errorInfo's *presence*, not by the code:
		// deserializeDaemonCreateError wraps only when the daemon sent no structured info at
		// all (`if (response.errorInfo) return error;`), because a code - known or unknown -
		// means the deserializer already produced the error the CLI should print. Pinning the
		// presence rule here is what stops a later change from wrapping typed errors (double
		// class, message still fine) or from dropping the wrapper on untyped ones (raw stack
		// at the CLI boundary). The P5-prep draft asserted the wrapper for an unknown code;
		// that premise is inverted - the run red out against the real branch.
		const untyped = {
			type: "response",
			command: "create",
			success: false,
			error: "create said no",
		} as unknown as Extract<DaemonResponse, { success: false }>;
		const wrapped = deserializeDaemonCreateError(untyped);
		expect(wrapped).toBeInstanceOf(DaemonSessionCreateError);
		expect(wrapped.message).toBe("create said no");

		const unknownTyped = {
			type: "response",
			command: "create",
			success: false,
			error: "create said no",
			errorInfo: { code: "some_future_code" },
		} as unknown as Extract<DaemonResponse, { success: false }>;
		const plain = deserializeDaemonCreateError(unknownTyped);
		expect(plain).not.toBeInstanceOf(DaemonSessionCreateError);
		expect(plain.message).toBe("create said no");
	});
});
