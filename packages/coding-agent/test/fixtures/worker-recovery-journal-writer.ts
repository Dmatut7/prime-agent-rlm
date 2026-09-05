// Writes a scripted set of worker recovery checkpoints, leaves a torn trailing
// line, and then hangs so the test can SIGKILL this process. Recovery must still
// see every record: appends are no longer fsync-ed per record, but they are in
// the page cache, which outlives the process that wrote them.
import { appendFileSync, writeFileSync } from "node:fs";
import { WorkerRecoveryJournal } from "../../src/modes/daemon/worker-recovery-journal.js";

const [journalPath, readyPath, sessionCount, recordsPerSession] = process.argv.slice(2);
if (!journalPath || !readyPath || !sessionCount || !recordsPerSession) {
	throw new Error("usage: worker-recovery-journal-writer.ts <journalPath> <readyPath> <sessions> <records>");
}

const journal = new WorkerRecoveryJournal(journalPath);
const sessions = Number.parseInt(sessionCount, 10);
const records = Number.parseInt(recordsPerSession, 10);
for (let session = 0; session < sessions; session++) {
	for (let index = 0; index < records; index++) {
		journal.record({
			activeSessionId: `active-${session}`,
			sessionId: `session-${session}`,
			sessionFile: `/tmp/sessions/session-${session}.jsonl`,
			// Stay busy so no compaction rewrites the file: the kill must interrupt
			// the plain append path.
			busy: true,
			operation: `op-${session}-${index}`,
		});
	}
}
appendFileSync(journalPath, '{"version":1,"activeSessionId":"active-torn","torn');
writeFileSync(readyPath, `${process.pid}\n`);
setInterval(() => {}, 1000);
