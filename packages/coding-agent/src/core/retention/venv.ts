// Kernel venv generations: the one reclaimer this repo already had (P2-2).
//
// `bootstrap.ts` calls `pruneKernelVenvGenerations` only on the boot paths, so a
// machine that never rebuilds keeps its retired generations forever. This class
// hangs the same judgement (shared, not re-derived: `planKernelVenvGenerationReclaim`)
// onto the sweep, spending the sweep's budget before removing anything.
import { getKernelVenvDir } from "../kernel/bootstrap.js";
import {
	listKernelVenvGenerations,
	planKernelVenvGenerationReclaim,
	readKernelVenvInUseState,
} from "../kernel/venv-in-use.js";
import { reclaimWithinBudget } from "./delete.js";
import {
	type RetentionClassContext,
	type RetentionClassModule,
	type RetentionClassResult,
	type RetentionSkip,
	SKIP,
} from "./types.js";

export const kernelVenvGenerationsModule: RetentionClassModule = {
	id: "kernel-venv-generations",
	async scanAndReclaim(context: RetentionClassContext): Promise<RetentionClassResult> {
		const base = context.roots.kernelVenvBase ?? getKernelVenvDir();
		const generations = await listKernelVenvGenerations(base);
		const skipped: RetentionSkip[] = [];
		if (generations.length === 0) {
			return {
				class: "kernel-venv-generations",
				scanned: 0,
				reclaimed: 0,
				bytes: 0,
				skipped,
				capped: false,
				disabled: false,
			};
		}
		// Retained / referenced generations are reported with the same reasons the
		// boot path would use, so a sweep report explains why a build survived.
		for (const dir of generations) {
			const state = await readKernelVenvInUseState(dir);
			if (state.unknown || state.references.length > 0 || state.bootClaims.length > 0) {
				skipped.push({
					path: dir,
					reason: state.unknown ? SKIP.unverifiable("venv-reference-state") : SKIP.reference("venv-in-use"),
				});
			}
		}
		const plan = await planKernelVenvGenerationReclaim(base, { retention: context.settings.venvRetention });
		const requests = plan.remove.map((entry) => ({
			path: entry.dir,
			kind: "dir" as const,
			bytes: entry.bytes,
			// One entry per generation directory: the byte cap already bounds how much
			// one sweep can free, and re-walking a venv only to count files is waste.
			entries: 1,
		}));
		for (const kept of plan.kept) {
			skipped.push({
				path: kept.dir,
				reason: kept.protectedByReference
					? SKIP.reference("venv-in-use")
					: (kept.pendingBoots ?? 0) > 0
						? SKIP.inUse("pid")
						: SKIP.reference("retained-generation"),
			});
		}
		const outcome = await reclaimWithinBudget(context, requests);
		return {
			class: "kernel-venv-generations",
			scanned: generations.length,
			reclaimed: outcome.reclaimed,
			bytes: outcome.bytes,
			skipped: [...skipped, ...outcome.skipped],
			capped: outcome.capped,
			disabled: false,
		};
	},
};
