import { defineConfig } from "vitest/config";

// This package's tests run on node:test (`npm test` = `node --test --import tsx`),
// not vitest; every file under test/ imports from "node:test". Keep vitest a no-op
// here so a stray `vitest` invocation cannot pick those files up under the wrong
// runner (the default include glob would match all of them).
export default defineConfig({
	test: {
		include: [],
		passWithNoTests: true,
	},
});
