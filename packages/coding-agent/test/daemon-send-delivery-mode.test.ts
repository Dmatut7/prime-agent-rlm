import { describe, expect, it } from "vitest";
import {
	DAEMON_COMMAND_COMPATIBILITY,
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	DAEMON_PROTOCOL_VERSION,
	DAEMON_SCHEMA_REVISION,
	type DaemonCommand,
	type DaemonDeclaredCapability,
	getDaemonCommandCompatibilities,
	meetsDaemonCommandCompatibility,
	missingDeclaredCommandCapability,
} from "../src/modes/daemon/daemon-protocol.js";

/**
 * send_message.deliveryMode (rev 41): the field sat on the wire as accepted-and-ignored
 * legacy input, so honoring it is gated behind the send_message_delivery_mode capability
 * with the revision as its floor - a rev-40 daemon would silently steer a message the
 * sender asked to queue as a follow-up.
 */

function sendMessage(deliveryMode?: "auto" | "steer" | "follow_up"): DaemonCommand {
	return {
		type: "send_message",
		targetActiveSessionId: "target",
		message: "hello",
		...(deliveryMode ? { deliveryMode } : {}),
	};
}

describe("send_message deliveryMode compatibility gate", () => {
	it("keeps the bare send_message command on the legacy path", () => {
		const compatibilities = getDaemonCommandCompatibilities(sendMessage());

		expect(compatibilities).toEqual([DAEMON_COMMAND_COMPATIBILITY.send_message]);
		expect(compatibilities.every((compatibility) => compatibility.capability === undefined)).toBe(true);
	});

	it("does not gate the explicit auto mode, which older daemons already implement", () => {
		const compatibilities = getDaemonCommandCompatibilities(sendMessage("auto"));

		expect(compatibilities).toEqual([DAEMON_COMMAND_COMPATIBILITY.send_message]);
	});

	it.each(["steer", "follow_up"] as const)("gates an explicit %s delivery on the rev-41 capability", (mode) => {
		const compatibilities = getDaemonCommandCompatibilities(sendMessage(mode));

		expect(compatibilities.length).toBe(2);
		expect(compatibilities[0]).toEqual({
			minProtocol: DAEMON_PROTOCOL_VERSION,
			minSchemaRevision: DAEMON_SCHEMA_REVISION,
			capability: "send_message_delivery_mode",
		});
	});

	it("refuses an explicit delivery mode against a rev-40 daemon without the capability", () => {
		const requirement = getDaemonCommandCompatibilities(sendMessage("follow_up"))[0]!;
		const oldDaemonHello = {
			protocol: DAEMON_PROTOCOL_INFO,
			schemaRevision: DAEMON_SCHEMA_REVISION - 1,
			serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES.filter(
				(capability) => capability !== "send_message_delivery_mode",
			),
		};

		expect(meetsDaemonCommandCompatibility(oldDaemonHello, requirement)).toBe(false);
	});

	it("admits an explicit delivery mode against a rev-41 daemon advertising the capability", () => {
		const requirement = getDaemonCommandCompatibilities(sendMessage("follow_up"))[0]!;
		const newDaemonHello = {
			protocol: DAEMON_PROTOCOL_INFO,
			schemaRevision: DAEMON_SCHEMA_REVISION,
			serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES,
		};

		expect(meetsDaemonCommandCompatibility(newDaemonHello, requirement)).toBe(true);
	});

	it("advertises the capability in the default server set", () => {
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("send_message_delivery_mode");
	});

	it("server-side gate refuses declared connections that lack the capability", () => {
		const declared: ReadonlySet<DaemonDeclaredCapability> = new Set(
			DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES.filter((capability) => capability !== "send_message_delivery_mode"),
		);

		expect(missingDeclaredCommandCapability(true, declared, sendMessage("steer"))).toBe("send_message_delivery_mode");
		expect(missingDeclaredCommandCapability(true, declared, sendMessage())).toBeUndefined();
	});

	it("first-party control clients declare the capability", () => {
		const declared: ReadonlySet<DaemonDeclaredCapability> = new Set(DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES);

		expect(missingDeclaredCommandCapability(true, declared, sendMessage("follow_up"))).toBeUndefined();
	});
});
