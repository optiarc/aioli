import Aioli from "../../dist/aioli.mjs";

const status = document.getElementById("status");
const resultsNode = document.getElementById("results");
const summaryNode = document.getElementById("summary");
const runMetadataNode = document.getElementById("run-metadata");
const errors = document.getElementById("errors");

const DEV_INPUT_SET = "dev-small";
const results = [];
const encoder = new TextEncoder();
const runMetadata = {
	runLabel: "opfs-bench-dev",
	startedAt: new Date().toISOString(),
	userAgent: navigator.userAgent,
	platform: navigator.platform || "",
	language: navigator.language || "",
	hardwareConcurrency: navigator.hardwareConcurrency || null,
	deviceMemory: navigator.deviceMemory || null,
	origin: location.origin
};

runMetadataNode.textContent = JSON.stringify(runMetadata, null, 2);

function minimap2Tools() {
	return [{
		tool: "minimap2",
		version: "2.22",
		urlPrefix: "https://biowasm.com/cdn/v3/minimap2/2.22"
	}];
}

function samtoolsTools() {
	return [{
		tool: "samtools",
		version: "1.10",
		urlPrefix: "https://biowasm.com/cdn/v3/samtools/1.10"
	}];
}

try {
	await runAll();
	runMetadata.finishedAt = new Date().toISOString();
	runMetadata.status = results.every(result => result.passed) ? "PASS" : "FAIL";
	runMetadata.totalCases = results.length;
	runMetadata.passingCases = results.filter(result => result.passed).length;
	runMetadataNode.textContent = JSON.stringify(runMetadata, null, 2);
	status.textContent = results.every(result => result.passed) ? "PASS" : "FAIL";
} catch (error) {
	status.textContent = "ERROR";
	runMetadata.finishedAt = new Date().toISOString();
	runMetadata.status = "ERROR";
	runMetadata.totalCases = results.length;
	runMetadata.passingCases = results.filter(result => result.passed).length;
	runMetadataNode.textContent = JSON.stringify(runMetadata, null, 2);
	errors.textContent = error?.stack || String(error);
}

async function runAll() {
	await clearOpfs();
	await pushResult(await safeBenchmark("minimap2-large-explicit-output", "staged", () => benchmarkMinimap2("staged")));
	await pushResult(await safeBenchmark("minimap2-large-explicit-output", "direct", () => benchmarkMinimap2("direct")));
	for(const result of await benchmarkSamtoolsSuite("staged"))
		await pushResult(result);
	for(const result of await benchmarkSamtoolsSuite("direct"))
		await pushResult(result);
}

async function safeBenchmark(caseId, backend, run) {
	status.textContent = `Running ${caseId} (${backend})...`;
	try {
		return await run();
	} catch (error) {
		return {
			case: caseId,
			backend,
			inputSet: DEV_INPUT_SET,
			fixtureSource: "dev-seeded",
			command: "",
			toolMs: null,
			totalMs: null,
			postCommandMs: null,
			outputBytes: 0,
			jsHeapBefore: null,
			jsHeapAfter: null,
			jsHeapDelta: null,
			uaMemoryBefore: null,
			uaMemoryAfter: null,
			uaMemoryDelta: null,
			stderrSummary: "",
			passed: false,
			notes: error?.stack || String(error)
		};
	}
}

async function benchmarkMinimap2(backend) {
	return benchmarkCase({
		caseId: "minimap2-large-explicit-output",
		backend,
		tools: minimap2Tools(),
		prepare: async CLI => {
			await ensureDir(CLI, "/opfs/data");
			await ensureDir(CLI, "/opfs/results");
			await writeBenchText(CLI, backend, "/opfs/data/large-ref.fa", await loadBenchFixture("large-ref.fa"));
			await writeBenchText(CLI, backend, "/opfs/data/large-reads.fq", await loadBenchFixture("large-reads.fq"));
		},
		command: "minimap2 -a -o /opfs/results/aln.sam /opfs/data/large-ref.fa /opfs/data/large-reads.fq",
		fsOutputPath: "/opfs/results/aln.sam",
		outputPath: "/results/aln.sam",
		fixtureSource: "dev-seeded",
		validate: async CLI => {
			const preview = await readOpfsText("/results/aln.sam", 512);
			return {
				passed: preview.includes("@SQ") || preview.includes("@PG"),
				notes: preview.slice(0, 160)
			};
		}
	});
}

async function benchmarkSamtoolsFaidx(backend, CLI) {
	return benchmarkCase({
		caseId: "samtools-faidx-large-sidecar",
		backend,
		tools: samtoolsTools(),
		CLI,
		clearBefore: false,
		prepare: async CLI => {
			await ensureDir(CLI, "/opfs/data");
			await writeBenchText(CLI, backend, "/opfs/data/large-ref-indexable.fa", await loadBenchFixture("large-ref-indexable.fa"));
		},
		command: "samtools faidx /opfs/data/large-ref-indexable.fa",
		fsOutputPath: "/opfs/data/large-ref-indexable.fa.fai",
		outputPath: "/data/large-ref-indexable.fa.fai",
		fixtureSource: "dev-seeded",
		validate: async () => {
			const preview = await readOpfsText("/data/large-ref-indexable.fa.fai", 256);
			return {
				passed: preview.includes("chrDevIndex"),
				notes: preview.trim()
			};
		}
	});
}

async function benchmarkSamtoolsSuite(backend) {
	const CLI = await new Aioli(samtoolsTools(), {
		debug: true,
		printInterleaved: false,
		opfsBackend: backend
	});

	const resultsForBackend = [];
	resultsForBackend.push(await safeBenchmark("samtools-faidx-large-sidecar", backend, () => benchmarkSamtoolsFaidx(backend, CLI)));
	resultsForBackend.push(await safeBenchmark("samtools-view-large-explicit-output", backend, () => benchmarkSamtoolsView(backend, CLI)));
	resultsForBackend.push(await safeBenchmark("samtools-fastq-large-explicit-output", backend, () => benchmarkSamtoolsFastq(backend, CLI)));
	resultsForBackend.push(await safeBenchmark("samtools-sort-large-explicit-output", backend, () => benchmarkSamtoolsSort(backend, CLI)));
	resultsForBackend.push(await safeBenchmark("samtools-index-large-sidecar", backend, () => benchmarkSamtoolsIndex(backend, CLI)));
	resultsForBackend.push(await safeBenchmark("samtools-opfs-roundtrip-large", backend, () => benchmarkSamtoolsRoundtrip(backend, CLI)));
	return resultsForBackend;
}

async function benchmarkSamtoolsView(backend, CLI) {
	return benchmarkCase({
		caseId: "samtools-view-large-explicit-output",
		backend,
		tools: samtoolsTools(),
		CLI,
		clearBefore: false,
		prepare: async CLI => {
			await prepareSortedBam(CLI, backend);
			await ensureDir(CLI, "/opfs/results");
		},
		command: "samtools view -o /opfs/results/out.sam /opfs/data/large-sorted.bam",
		fsOutputPath: "/opfs/results/out.sam",
		outputPath: "/results/out.sam",
		fixtureSource: "generated-from-dev-sam",
		validate: async () => {
			const preview = await readOpfsText("/results/out.sam", 512);
			return {
				passed: preview.includes("read1") || preview.includes("read2"),
				notes: preview.slice(0, 160)
			};
		}
	});
}

async function benchmarkSamtoolsFastq(backend, CLI) {
	return benchmarkCase({
		caseId: "samtools-fastq-large-explicit-output",
		backend,
		tools: samtoolsTools(),
		CLI,
		clearBefore: false,
		prepare: async CLI => {
			await prepareSortedBam(CLI, backend);
			await ensureDir(CLI, "/opfs/results");
		},
		command: "samtools fastq -0 /opfs/results/out.fastq -o /opfs/results/out.fastq /opfs/data/large-sorted.bam",
		fsOutputPath: "/opfs/results/out.fastq",
		outputPath: "/results/out.fastq",
		fixtureSource: "generated-from-dev-sam",
		validate: async () => {
			const preview = await readOpfsText("/results/out.fastq", 256);
			return {
				passed: preview.includes("@read1") || preview.includes("@read2"),
				notes: preview.slice(0, 160)
			};
		}
	});
}

async function benchmarkSamtoolsSort(backend, CLI) {
	return benchmarkCase({
		caseId: "samtools-sort-large-explicit-output",
		backend,
		tools: samtoolsTools(),
		CLI,
		clearBefore: false,
		prepare: async CLI => {
			await ensureDir(CLI, "/opfs/data");
			await ensureDir(CLI, "/opfs/results");
			await writeBenchText(CLI, backend, "/opfs/data/large-unsorted.sam", await loadBenchFixture("large-unsorted.sam"));
		},
		command: "samtools sort -o /opfs/results/sorted.bam /opfs/data/large-unsorted.sam",
		fsOutputPath: "/opfs/results/sorted.bam",
		outputPath: "/results/sorted.bam",
		fixtureSource: "dev-seeded",
		validate: async CLI => {
			const view = await CLI.exec("samtools view /opfs/results/sorted.bam");
			return {
				passed: commandSucceeded(view) && view.stdout.includes("read1"),
				notes: view.stderr || ""
			};
		}
	});
}

async function benchmarkSamtoolsIndex(backend, CLI) {
	return benchmarkCase({
		caseId: "samtools-index-large-sidecar",
		backend,
		tools: samtoolsTools(),
		CLI,
		clearBefore: false,
		prepare: async CLI => {
			await prepareSortedBam(CLI, backend);
		},
		command: "samtools index /opfs/data/large-sorted.bam",
		fsOutputPath: "/opfs/data/large-sorted.bam.bai",
		outputPath: "/data/large-sorted.bam.bai",
		fixtureSource: "generated-from-dev-sam",
		validate: async () => {
			const size = await getOpfsFileSize("/data/large-sorted.bam.bai");
			return {
				passed: size > 0,
				notes: `size=${size}`
			};
		}
	});
}

async function benchmarkSamtoolsRoundtrip(backend, CLI) {
	return benchmarkCase({
		caseId: "samtools-opfs-roundtrip-large",
		backend,
		tools: samtoolsTools(),
		CLI,
		clearBefore: false,
		prepare: async CLI => {
			await prepareSortedBam(CLI, backend);
			await ensureDir(CLI, "/opfs/results");
		},
		command: "samtools view -o /opfs/results/from-opfs.sam /opfs/data/large-sorted.bam",
		fsOutputPath: "/opfs/results/from-opfs.sam",
		outputPath: "/results/from-opfs.sam",
		fixtureSource: "generated-from-dev-sam",
		validate: async () => {
			const preview = await readOpfsText("/results/from-opfs.sam", 512);
			return {
				passed: preview.includes("read1") || preview.includes("read2"),
				notes: preview.slice(0, 160)
			};
		}
	});
}

async function benchmarkCase({ caseId, backend, tools, CLI = null, clearBefore = false, prepare, command, fsOutputPath, outputPath, fixtureSource = "unknown", validate }) {
	const benchmarkCLI = CLI || await new Aioli(tools, {
		debug: true,
		printInterleaved: false,
		opfsBackend: backend
	});

	const before = await sampleMemory();
	if(prepare)
		await prepare(benchmarkCLI);

	const startedAt = performance.now();
	const commandResult = await benchmarkCLI.exec(command);
	const commandFinishedAt = performance.now();
	if(backend === "staged" && fsOutputPath)
		await benchmarkCLI.opfsFlush(fsOutputPath, outputPath);
	const outputBytes = await getOpfsFileSize(outputPath);
	const validation = await validate(benchmarkCLI, commandResult);
	const finishedAt = performance.now();
	const after = await sampleMemory();

	return {
		case: caseId,
		backend,
		inputSet: DEV_INPUT_SET,
		fixtureSource,
		command,
		toolMs: extractToolMs(commandResult.stderr),
		totalMs: roundMs(finishedAt - startedAt),
		postCommandMs: roundMs(finishedAt - commandFinishedAt),
		outputBytes,
		jsHeapBefore: before.jsHeap,
		jsHeapAfter: after.jsHeap,
		jsHeapDelta: diffMetric(before.jsHeap, after.jsHeap),
		uaMemoryBefore: before.uaMemory,
		uaMemoryAfter: after.uaMemory,
		uaMemoryDelta: diffMetric(before.uaMemory, after.uaMemory),
		stderrSummary: summarizeStderr(commandResult.stderr),
		passed: commandSucceeded(commandResult) && outputBytes > 0 && validation.passed,
		notes: validation.notes || ""
	};
}

async function prepareSortedBam(CLI, backend) {
	await ensureDir(CLI, "/opfs/data");
	await writeBenchText(CLI, backend, "/opfs/data/large-unsorted.sam", await loadBenchFixture("large-unsorted.sam"));
	await CLI.exec("samtools sort -o /opfs/data/large-sorted.bam /opfs/data/large-unsorted.sam");
}

async function writeBenchText(CLI, backend, publicPath, text) {
	if(backend === "direct") {
		await CLI.opfsWrite(toPersistPath(publicPath), text);
		return;
	}
	await CLI.write({
		path: publicPath,
		buffer: encoder.encode(text)
	});
}

async function ensureDir(CLI, path) {
	try {
		await CLI.mkdir(path);
	} catch {}
}

function toPersistPath(publicPath) {
	return publicPath.startsWith("/opfs/") ? publicPath.slice("/opfs".length) : publicPath;
}

async function loadBenchFixture(name) {
	const response = await fetch(`/tests/data/opfs-bench/${name}`);
	if(!response.ok)
		throw new Error(`Failed to load benchmark fixture ${name}`);
	return response.text();
}

async function clearOpfs() {
	const root = await navigator.storage.getDirectory();
	for await (const [name] of root.entries())
		await root.removeEntry(name, { recursive: true });
}

async function sampleMemory() {
	let jsHeap = null;
	if(performance?.memory?.usedJSHeapSize)
		jsHeap = performance.memory.usedJSHeapSize;

	let uaMemory = null;
	if(typeof performance.measureUserAgentSpecificMemory === "function") {
		try {
			const estimate = await performance.measureUserAgentSpecificMemory();
			uaMemory = estimate.bytes;
		} catch {
			uaMemory = null;
		}
	}

	return { jsHeap, uaMemory };
}

function diffMetric(before, after) {
	return Number.isFinite(before) && Number.isFinite(after) ? after - before : null;
}

function roundMs(value) {
	return Math.round(value * 1000) / 1000;
}

function extractToolMs(stderr) {
	if(typeof stderr !== "string" || stderr.length === 0)
		return null;

	const minimap2Match = stderr.match(/Real time:\s+([0-9.]+)\s+sec/i);
	if(minimap2Match)
		return Math.round(Number(minimap2Match[1]) * 1000 * 1000) / 1000;

	return null;
}

function summarizeStderr(stderr) {
	if(typeof stderr !== "string" || stderr.length === 0)
		return "";
	return stderr.trim().split("\n").slice(-3).join("\n");
}

function commandSucceeded(result) {
	if(typeof result?.stderr !== "string")
		return false;
	const stderr = result.stderr.toLowerCase();
	return !stderr.includes("exception thrown:")
		&& !stderr.includes("failed")
		&& !stderr.includes("could not")
		&& !stderr.includes("function not implemented")
		&& !stderr.includes("error");
}

async function getOpfsFileSize(path) {
	const handle = await getOpfsFileHandle(path);
	const file = await handle.getFile();
	return file.size;
}

async function readOpfsText(path, limit) {
	const handle = await getOpfsFileHandle(path);
	const file = await handle.getFile();
	return file.slice(0, limit).text();
}

async function getOpfsFileHandle(path) {
	const segments = path.split("/").filter(Boolean);
	let current = await navigator.storage.getDirectory();
	for(let i = 0; i < segments.length - 1; i += 1)
		current = await current.getDirectoryHandle(segments[i]);
	return current.getFileHandle(segments[segments.length - 1]);
}

async function pushResult(result) {
	results.push(result);
	resultsNode.textContent = JSON.stringify(results, null, 2);
	summaryNode.textContent = JSON.stringify(buildSummary(results), null, 2);
}

function buildSummary(results) {
	const byCase = {};

	for(const result of results) {
		if(!byCase[result.case])
			byCase[result.case] = {};
		byCase[result.case][result.backend] = {
			passed: result.passed,
			fixtureSource: result.fixtureSource,
			totalMs: result.totalMs,
			postCommandMs: result.postCommandMs,
			outputBytes: result.outputBytes,
			jsHeapDelta: result.jsHeapDelta,
			uaMemoryDelta: result.uaMemoryDelta
		};
	}

	const comparisons = {};
	const thresholdOverview = {
		totalComparedCases: 0,
		directPassingAllEvaluatedThresholds: 0,
		directFailingAnyEvaluatedThreshold: 0,
		directThresholdChecks: {
			jsHeapWithinLimit: { pass: 0, fail: 0, notApplicable: 0 },
			uaMemoryWithinLimit: { pass: 0, fail: 0, notApplicable: 0 },
			postCommandWithinLimit: { pass: 0, fail: 0, notApplicable: 0 },
			fasterThanStagedTarget: { pass: 0, fail: 0, notApplicable: 0 },
			postCommandReductionHit: { pass: 0, fail: 0, notApplicable: 0 }
		}
	};
	for(const [caseId, caseResults] of Object.entries(byCase)) {
		if(caseResults.staged && caseResults.direct) {
			const thresholdEvaluation = evaluateThresholds(caseResults.staged, caseResults.direct);
			const overallStatus = summarizeThresholdStatus(thresholdEvaluation);
			updateThresholdOverview(thresholdOverview, thresholdEvaluation, overallStatus);
			comparisons[caseId] = {
				stagedTotalMs: caseResults.staged.totalMs,
				directTotalMs: caseResults.direct.totalMs,
				totalMsDelta: diffNullable(caseResults.staged.totalMs, caseResults.direct.totalMs),
				stagedPostCommandMs: caseResults.staged.postCommandMs,
				directPostCommandMs: caseResults.direct.postCommandMs,
				postCommandDelta: diffNullable(caseResults.staged.postCommandMs, caseResults.direct.postCommandMs),
				stagedJsHeapDelta: caseResults.staged.jsHeapDelta,
				directJsHeapDelta: caseResults.direct.jsHeapDelta,
				jsHeapDeltaDifference: diffNullable(caseResults.staged.jsHeapDelta, caseResults.direct.jsHeapDelta),
				outputBytes: caseResults.direct.outputBytes || caseResults.staged.outputBytes,
				thresholdEvaluation,
				thresholdStatus: overallStatus
			};
		}
	}

	return {
		totalCases: results.length,
		passingCases: results.filter(result => result.passed).length,
		byCase,
		comparisons,
		thresholdOverview
	};
}

function diffNullable(left, right) {
	return Number.isFinite(left) && Number.isFinite(right) ? right - left : null;
}

function evaluateThresholds(staged, direct) {
	const outputBytes = direct.outputBytes || staged.outputBytes || 0;
	const jsHeapLimit = Math.max(64 * 1024 * 1024, outputBytes * 0.05);
	const uaMemoryLimit = Math.max(96 * 1024 * 1024, outputBytes * 0.10);
	const postCommandLimit = Math.max(2000, (direct.totalMs || 0) * 0.15);
	const totalMsImprovementTarget = outputBytes >= 1024 * 1024 * 1024 ? (staged.totalMs || 0) * 0.8 : null;
	const postCommandReductionTarget = staged.postCommandMs != null ? staged.postCommandMs * 0.2 : null;

	return {
		directJsHeapWithinLimit: direct.jsHeapDelta == null ? null : direct.jsHeapDelta <= jsHeapLimit,
		directJsHeapLimit: jsHeapLimit,
		directUaMemoryWithinLimit: direct.uaMemoryDelta == null ? null : direct.uaMemoryDelta <= uaMemoryLimit,
		directUaMemoryLimit: uaMemoryLimit,
		directPostCommandWithinLimit: direct.postCommandMs == null ? null : direct.postCommandMs <= postCommandLimit,
		directPostCommandLimit: postCommandLimit,
		directFasterThanStagedTarget: totalMsImprovementTarget == null || direct.totalMs == null
			? null
			: direct.totalMs <= totalMsImprovementTarget,
		directTotalMsTarget: totalMsImprovementTarget,
		directPostCommandReductionHit: postCommandReductionTarget == null || direct.postCommandMs == null
			? null
			: direct.postCommandMs <= postCommandReductionTarget,
		directPostCommandReductionTarget: postCommandReductionTarget
	};
}

function summarizeThresholdStatus(thresholdEvaluation) {
	const evaluated = Object.values(thresholdEvaluation).filter(value => typeof value === "boolean");
	return {
		evaluatedChecks: evaluated.length,
		passedChecks: evaluated.filter(Boolean).length,
		failedChecks: evaluated.filter(value => value === false).length,
		passesAllEvaluatedChecks: evaluated.length > 0 && evaluated.every(Boolean)
	};
}

function updateThresholdOverview(overview, evaluation, status) {
	overview.totalComparedCases += 1;
	if(status.passesAllEvaluatedChecks)
		overview.directPassingAllEvaluatedThresholds += 1;
	else
		overview.directFailingAnyEvaluatedThreshold += 1;

	updateThresholdCounter(overview.directThresholdChecks.jsHeapWithinLimit, evaluation.directJsHeapWithinLimit);
	updateThresholdCounter(overview.directThresholdChecks.uaMemoryWithinLimit, evaluation.directUaMemoryWithinLimit);
	updateThresholdCounter(overview.directThresholdChecks.postCommandWithinLimit, evaluation.directPostCommandWithinLimit);
	updateThresholdCounter(overview.directThresholdChecks.fasterThanStagedTarget, evaluation.directFasterThanStagedTarget);
	updateThresholdCounter(overview.directThresholdChecks.postCommandReductionHit, evaluation.directPostCommandReductionHit);
}

function updateThresholdCounter(counter, value) {
	if(value === true)
		counter.pass += 1;
	else if(value === false)
		counter.fail += 1;
	else
		counter.notApplicable += 1;
}
