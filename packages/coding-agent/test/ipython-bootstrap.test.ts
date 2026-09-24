import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";
import { manifestPathIn, snapshotPathIn } from "../src/core/kernel/state-snapshot.js";
import {
	buildRlmBootstrapCode,
	PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER,
	parseUnavailablePythonSkills,
} from "../src/core/tools/ipython.js";
import { resolveKernelPython } from "./kernel-python.js";

describe("RLM bootstrap", () => {
	it("gives subagent registry operations the actionable missing-runtime fallback", () => {
		const code = buildRlmBootstrapCode();
		expect(code).toContain('async def find_models(self, query="", limit=8)');
		expect(code).toContain("async def list_subagents(self)");
		expect(code).toContain("async def delete_subagent(self, target)");
		expect(code).toContain("self._raise_missing()");
	});

	it("disables colored output for subprocesses launched by the kernel", () => {
		expect(buildRlmBootstrapCode()).toContain('_prime_agent_os.environ["NO_COLOR"] = "1"');
	});

	it("binds bash from the runtime with a missing-runtime stub fallback", () => {
		const code = buildRlmBootstrapCode();
		expect(code).toContain("bash = _prime_agent_rlm_module.bash");
		expect(code).toContain("def bash(command):");
		expect(code).toContain("rlm._raise_missing()");
	});

	it("does not install a kernel shutdown hook (the runtime closes MCP on shutdown itself)", () => {
		expect(buildRlmBootstrapCode()).not.toContain("install_shutdown_hook");
	});

	it("guards Python skill imports so a broken skill does not abort bootstrap", () => {
		const code = buildRlmBootstrapCode([
			{
				name: "broken-skill",
				importName: "broken_skill",
				packagePath: "/tmp/broken-skill",
				pyprojectPath: "/tmp/broken-skill/pyproject.toml",
			},
		]);

		expect(code).toContain("except Exception as _prime_agent_skill_error");
		expect(code).toContain("_PrimeAgentUnavailableSkill");
		expect(code).toContain("_PRIME_AGENT_SKILL_IMPORT_ERRORS");
		expect(code).toContain("globals()[_prime_agent_skill_name] = _PrimeAgentUnavailableSkill");
	});

	it.each([
		[
			`${PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER}{"websearch":"No module named 'websearch'"}\n`,
			{ websearch: "No module named 'websearch'" },
		],
		[`noise\n${PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER}{"edit":"boom"}`, { edit: "boom" }],
		["some unrelated kernel output", undefined],
		[`${PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER}not json`, undefined],
		[`${PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER}{}`, undefined],
	])("parses %j as %j", (stdout, expected) => {
		expect(parseUnavailablePythonSkills(stdout as string)).toEqual(expected);
	});
});

// Resolved the way the product resolves a kernel interpreter; see `test/kernel-python.ts`.
const python = await resolveKernelPython("import rlm.repl, rlm; assert callable(rlm.emit)");
const describeIfKernel = python ? describe : describe.skip;

// ---------------------------------------------------------------------------
// RT-5 (round-36): the callable-skill-module wrapper's contract has to hold for every
// access path a model can take, not just the kernel-global name.
// ---------------------------------------------------------------------------
describeIfKernel("RLM bootstrap skill wrapping (RT-5)", { tags: ["kernel-heavy"] }, () => {
	const skillsDir = mkdtempSync(join(tmpdir(), "prime-agent-rt5-skills-"));
	const kernelDir = mkdtempSync(join(tmpdir(), "prime-agent-rt5-kernel-"));

	afterAll(() => {
		rmSync(skillsDir, { recursive: true, force: true });
		rmSync(kernelDir, { recursive: true, force: true });
	});

	/** Writes a python skill package; returns its runtime info and src dir. */
	function writeSkill(
		dirName: string,
		importName: string,
		initPy: string,
	): {
		info: { name: string; importName: string; packagePath: string; pyprojectPath: string };
		srcDir: string;
	} {
		const packagePath = join(skillsDir, dirName);
		const srcDir = join(packagePath, "src", importName);
		mkdirSync(srcDir, { recursive: true });
		writeFileSync(join(srcDir, "__init__.py"), initPy);
		const pyprojectPath = join(packagePath, "pyproject.toml");
		writeFileSync(pyprojectPath, `[project]\nname = "${dirName}"\nversion = "0.1.0"\n`);
		return {
			info: { name: dirName, importName, packagePath, pyprojectPath },
			srcDir: join(packagePath, "src"),
		};
	}

	const alpha = writeSkill(
		"skill-alpha",
		"skill_alpha",
		'import skill_beta\nB = skill_beta\n\n\nasync def run():\n    return "alpha"\n',
	);
	const beta = writeSkill("skill-beta", "skill_beta", 'import skill_alpha\n\n\nasync def run():\n    return "beta"\n');
	const state = writeSkill(
		"skill-state",
		"skill_state",
		"MARK = None\n\n\nasync def run():\n    return 1\n\n\nasync def read_mark():\n    return MARK\n",
	);
	const gamma = writeSkill(
		"skill-gamma",
		"skill_gamma",
		"import definitely_missing_module_xyz\n\n\nasync def run():\n    return 'gamma'\n",
	);

	async function withSkillKernel(
		skills: readonly {
			info: { name: string; importName: string; packagePath: string; pyprojectPath: string };
			srcDir: string;
		}[],
		cells: string[],
	): Promise<string[]> {
		const manager = new ReplKernelManager({
			python: python as string,
			cwd: kernelDir,
			env: { PYTHONPATH: skills.map((skill) => skill.srcDir).join(":") },
		});
		try {
			await manager.start();
			const bootstrap = await manager.execute(buildRlmBootstrapCode(skills.map((skill) => skill.info)));
			expect(bootstrap.status).toBe("ok");
			const out: string[] = [];
			for (const cell of cells) {
				const result = await manager.execute(cell);
				expect(result.status).toBe("ok");
				out.push(result.stdout);
			}
			return out;
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	}

	it("keeps its own skills on a second bootstrap instead of reporting them unavailable", async () => {
		const out = await withSkillKernel(
			[state],
			[
				buildRlmBootstrapCode([state.info]),
				"print('wrapper:', type(skill_state).__name__ == '_PrimeAgentCallableSkillModule')\nprint('call:', await skill_state())",
			],
		);
		expect(out[0]).not.toContain(PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER);
		expect(out[1]).toContain("wrapper: True");
		expect(out[1]).toContain("call: 1");
	}, 60_000);

	it("keeps its own skills when a restored state bound them before the bootstrap", async () => {
		// Live shape: a saved namespace held a skill as its plain module (the wrapper
		// itself cannot be pickled, the module can), so every resumed kernel restored the
		// module first and the bootstrap then refused the skill as "already provided by
		// the kernel". Refused, the name kept the plain module, which was saved again, so
		// the state never healed. The restore runs before the bootstrap, as in production.
		const snapshotDir = mkdtempSync(join(kernelDir, "restore-"));
		const env = { PYTHONPATH: state.srcDir };
		const snapshot = { path: snapshotPathIn(snapshotDir), manifestPath: manifestPathIn(snapshotDir) };
		const first = new ReplKernelManager({ python: python as string, cwd: kernelDir, env, snapshot });
		try {
			await first.start();
			expect((await first.execute("import skill_state")).status).toBe("ok");
			expect((await first.snapshotState())?.saved).toContain("skill_state");
		} finally {
			await first.shutdown({ snapshot: false, drainHostRequests: true });
		}
		const second = new ReplKernelManager({ python: python as string, cwd: kernelDir, env, snapshot });
		try {
			await second.start();
			expect((await second.restoreState())?.restored).toContain("skill_state");
			const bootstrap = await second.execute(buildRlmBootstrapCode([state.info]));
			expect(bootstrap.status).toBe("ok");
			expect(bootstrap.stdout).not.toContain(PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER);
			const probe = await second.execute(
				"print('wrapper:', type(skill_state).__name__ == '_PrimeAgentCallableSkillModule')\nprint('call:', await skill_state())",
			);
			expect(probe.stdout).toContain("wrapper: True");
			expect(probe.stdout).toContain("call: 1");
		} finally {
			await second.shutdown({ snapshot: false, drainHostRequests: true });
		}
	}, 90_000);

	it("keeps a restored skill whose install points at another checkout with the same source", async () => {
		// The shared kernel venv installs skills by content, so the import can resolve to a
		// sibling worktree while this session declares its own copy of the same package.
		const sameCopy = writeSkill(
			"skill-state-sibling",
			"skill_state",
			"MARK = None\n\n\nasync def run():\n    return 1\n\n\nasync def read_mark():\n    return MARK\n",
		);
		const otherCode = writeSkill("skill-state-other", "skill_state", "async def run():\n    return 'other'\n");
		for (const [declared, expectWrapped] of [
			[sameCopy, true],
			[otherCode, false],
		] as const) {
			const manager = new ReplKernelManager({
				python: python as string,
				cwd: kernelDir,
				env: { PYTHONPATH: state.srcDir },
			});
			try {
				await manager.start();
				expect((await manager.execute("import skill_state")).status).toBe("ok");
				const bootstrap = await manager.execute(buildRlmBootstrapCode([declared.info]));
				expect(bootstrap.status).toBe("ok");
				const probe = await manager.execute(
					"print('wrapper:', type(skill_state).__name__ == '_PrimeAgentCallableSkillModule')",
				);
				expect(probe.stdout).toContain(`wrapper: ${expectWrapped ? "True" : "False"}`);
				if (expectWrapped) {
					expect(bootstrap.stdout).not.toContain(PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER);
				} else {
					// Different code under the same name is still a foreign module.
					expect(bootstrap.stdout).toContain(PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER);
				}
			} finally {
				await manager.shutdown({ snapshot: false, drainHostRequests: true });
			}
		}
	}, 90_000);

	it("gives cross-skill module references the callable wrapper too (F1)", async () => {
		const out = await withSkillKernel(
			[alpha, beta],
			[
				"import skill_alpha as sa\nprint('wrapper:', type(sa.B).__name__ == '_PrimeAgentCallableSkillModule')\nprint('callable:', callable(sa.B))\nprint('await:', await sa.B())",
			],
		);
		expect(out[0]).toContain("wrapper: True");
		expect(out[0]).toContain("callable: True");
		expect(out[0]).toContain("await: beta");
	}, 60_000);

	it("shares the wrapper namespace with the skill's own functions (F2)", async () => {
		const out = await withSkillKernel(
			[state],
			[
				"import skill_state as st\nprint('shared:', st.run.__globals__ is st.__dict__)\nst.MARK = 7\nprint('sees:', await st.read_mark())",
			],
		);
		expect(out[0]).toContain("shared: True");
		expect(out[0]).toContain("sees: 7");
	}, 60_000);

	it("keeps inspect.signature and importlib.reload honest after a reload (F3)", async () => {
		const sig = writeSkill("skill-sig", "skill_sig", "async def run(x=1):\n    return x\n");
		const out = await withSkillKernel(
			[sig, alpha, beta],
			[
				"import skill_sig as s, inspect\nprint('sig1:', str(inspect.signature(s)))",
				"import importlib, inspect\nimportlib.reload(s)\nprint('sig2:', str(inspect.signature(s)))",
				"import importlib, skill_alpha as sa\nimportlib.reload(sa.B)\nprint('cross_reload: ok')",
			],
		);
		expect(out[0]).toContain("sig1: (x=1)");
		// Rewrite run's signature on disk, then reload: the wrapper must not keep the
		// startup-time signature snapshot.
		writeFileSync(join(sig.srcDir, "skill_sig", "__init__.py"), "async def run(x=1, y=2):\n    return x + y\n");
		const manager = new ReplKernelManager({
			python: python as string,
			cwd: kernelDir,
			env: { PYTHONPATH: [sig.srcDir, alpha.srcDir, beta.srcDir].join(":") },
		});
		try {
			await manager.start();
			const bootstrap = await manager.execute(buildRlmBootstrapCode([sig.info, alpha.info, beta.info]));
			expect(bootstrap.status).toBe("ok");
			const result = await manager.execute(
				"import skill_sig as s, importlib, inspect\nimportlib.reload(s)\nprint('sig3:', str(inspect.signature(s)))",
			);
			expect(result.status).toBe("ok");
			expect(result.stdout).toContain("sig3: (x=1, y=2)");
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	}, 90_000);

	it("gives every access path to a failed skill the same named RuntimeError (F4)", async () => {
		const out = await withSkillKernel(
			[gamma],
			[
				"import skill_gamma\nprint('import_bound:', skill_gamma.__name__)",
				"try:\n    await skill_gamma.run()\nexcept RuntimeError as e:\n    print('run_error_named:', 'skill_gamma' in str(e))",
				"try:\n    skill_gamma.NOPE_ATTR\nexcept RuntimeError as e:\n    print('attr_error_named:', 'skill_gamma' in str(e))\nexcept AttributeError as e:\n    print('attr_error_leaked:', type(e).__name__)",
				"from skill_gamma import run as gamma_run\ntry:\n    await gamma_run()\nexcept RuntimeError as e:\n    print('fromimport_error_named:', 'skill_gamma' in str(e))",
			],
		);
		expect(out[0]).toContain("import_bound: skill_gamma");
		expect(out[1]).toContain("run_error_named: True");
		expect(out[2]).toContain("attr_error_named: True");
		expect(out[2]).not.toContain("attr_error_leaked");
		expect(out[3]).toContain("fromimport_error_named: True");
	}, 60_000);

	it("refuses to wrap skill import names that collide with kernel-provided modules (F5)", async () => {
		const fakeAsyncio = {
			info: {
				name: "asyncio-hijack",
				importName: "asyncio",
				packagePath: "/nonexistent",
				pyprojectPath: "/nonexistent/pyproject.toml",
			},
			srcDir: "/nonexistent",
		};
		const fakeRlm = {
			info: {
				name: "rlm-hijack",
				importName: "rlm",
				packagePath: "/nonexistent",
				pyprojectPath: "/nonexistent/pyproject.toml",
			},
			srcDir: "/nonexistent",
		};
		const out = await withSkillKernel(
			[fakeAsyncio, fakeRlm],
			[
				"import sys, asyncio\nprint('asyncio_type:', type(asyncio).__name__)\nprint('sys_asyncio_type:', type(sys.modules['asyncio']).__name__)",
				"import sys\nprint('rlm_replaced:', type(sys.modules['rlm']).__name__ == '_PrimeAgentCallableSkillModule')\nprint('rlm_still_callable:', callable(rlm))",
				"print('refused_asyncio:', 'asyncio' in _PRIME_AGENT_SKILL_IMPORT_ERRORS)\nprint('refused_rlm:', 'rlm' in _PRIME_AGENT_SKILL_IMPORT_ERRORS)",
			],
		);
		expect(out[0]).toContain("asyncio_type: module");
		expect(out[0]).toContain("sys_asyncio_type: module");
		// The runtime's own rlm module is a callable module by design; what must not
		// happen is the bootstrap replacing it with a skill wrapper snapshot.
		expect(out[1]).toContain("rlm_replaced: False");
		expect(out[1]).toContain("rlm_still_callable: True");
		expect(out[2]).toContain("refused_asyncio: True");
		expect(out[2]).toContain("refused_rlm: True");
	}, 60_000);
});

describeIfKernel("RLM bootstrap (real kernel)", () => {
	const dir = mkdtempSync(join(tmpdir(), "prime-agent-bootstrap-"));

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("binds asyncio in the user namespace", async () => {
		const manager = new ReplKernelManager({ python: python as string, cwd: dir });
		try {
			await manager.start();
			const bootstrap = await manager.execute(buildRlmBootstrapCode());
			expect(bootstrap.status).toBe("ok");

			const result = await manager.execute("_t = asyncio.create_task(asyncio.sleep(0))\nprint(type(_t).__name__)");
			expect(result.status).toBe("ok");
			expect(result.stdout).toContain("Task");

			const envResult = await manager.execute('import os\nprint(os.environ["NO_COLOR"])');
			expect(envResult.status).toBe("ok");
			expect(envResult.stdout.trim()).toBe("1");
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	}, 60_000);

	it("emits canonical paths for edits after the kernel changes directories", async () => {
		const firstDir = join(dir, "first");
		const secondDir = join(dir, "second");
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		writeFileSync(join(firstDir, "same.txt"), "old");
		writeFileSync(join(secondDir, "same.txt"), "old");
		const editSkillRoot = join(process.cwd(), "skills", "edit");
		const manager = new ReplKernelManager({
			python: python as string,
			cwd: dir,
			env: { PYTHONPATH: join(editSkillRoot, "src") },
		});
		try {
			await manager.start();
			const bootstrap = await manager.execute(
				buildRlmBootstrapCode([
					{
						name: "edit",
						importName: "edit",
						packagePath: editSkillRoot,
						pyprojectPath: join(editSkillRoot, "pyproject.toml"),
					},
				]),
			);
			expect(bootstrap.status).toBe("ok");

			const first = await manager.execute(
				'import os\nos.chdir("first")\nawait edit(path="same.txt", old_str="old", new_str="new")',
			);
			const second = await manager.execute(
				'os.chdir("../second")\nawait edit(path="same.txt", old_str="old", new_str="new")',
			);

			expect(first.diffs?.[0]?.path).toBe(realpathSync(join(firstDir, "same.txt")));
			expect(second.diffs?.[0]?.path).toBe(realpathSync(join(secondDir, "same.txt")));
			expect(first.diffs?.[0]?.path).not.toBe(second.diffs?.[0]?.path);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	}, 60_000);
	it("binds the standard modules the prompt teaches, without overwriting restored user variables", async () => {
		const manager = new ReplKernelManager({ python: python as string, cwd: dir });
		try {
			await manager.start();
			// A state restore runs before the bootstrap; these two stand in for restored values.
			expect((await manager.execute("json = {'k': 1}\nre = 'user value'")).status).toBe("ok");
			expect((await manager.execute(buildRlmBootstrapCode())).status).toBe("ok");
			const probe = await manager.execute(
				"import types\nprint('json:', json)\nprint('re:', re)\nfor _n in ('os', 'shlex', 'sys'):\n    print(_n, isinstance(globals()[_n], types.ModuleType))\nprint('Path:', Path.__name__)",
			);
			expect(probe.status).toBe("ok");
			expect(probe.stdout).toContain("json: {'k': 1}");
			expect(probe.stdout).toContain("re: user value");
			expect(probe.stdout).toContain("os True");
			expect(probe.stdout).toContain("shlex True");
			expect(probe.stdout).toContain("sys True");
			expect(probe.stdout).toContain("Path: Path");
		} finally {
			await manager.shutdown({ snapshot: false, drainHostRequests: true });
		}
	}, 60_000);
});
