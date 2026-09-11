/**
 * Subprocess entry for the supervisor crash-handler tests: installs the production
 * handler pair and then triggers the failure mode named on the command line, so the
 * assertion is on a real process's exit code and stdout, not on a mocked handler.
 */
import { installSupervisorCrashHandlers } from "../../src/modes/daemon/daemon-supervisor.js";

const mode = process.argv[2] ?? "rejection";
const rejections = Number.parseInt(process.argv[3] ?? "1", 10);

if (mode === "threshold") {
	installSupervisorCrashHandlers({ rejectionExitThreshold: 2 });
} else {
	installSupervisorCrashHandlers();
}

if (mode === "uncaught") {
	setTimeout(() => {
		throw new Error("fixture uncaught exception");
	}, 20);
} else {
	for (let index = 0; index < rejections; index++) {
		Promise.reject(new Error(`fixture unhandled rejection ${index + 1}`));
	}
	setTimeout(() => {
		console.log("SURVIVED");
	}, 400);
}
