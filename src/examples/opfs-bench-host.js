import Aioli from "../../dist/aioli.mjs";

const REQUIRED_SUFFIXES = [
	"ref.fa",
	"reads.fq.gz",
	"sorted.bam",
	"unsorted.bam"
];
const DATASET_PREFIXES = ["small", "medium", "large"];
const searchParams = new URLSearchParams(location.search);
const AUTO_MODE = searchParams.get("mode") === "auto-host";
const AUTO_DATASET = searchParams.get("dataset");
const COMMAND_TIMEOUT_MINUTES = Number(searchParams.get("timeoutMinutes") || "30");
const COMMAND_TIMEOUT_MS = COMMAND_TIMEOUT_MINUTES * 60 * 1000;
const RESOURCE_INTERVAL_MINUTES = Number(searchParams.get("resourceMinutes") || "2");
const RESOURCE_INTERVAL_MS = RESOURCE_INTERVAL_MINUTES * 60 * 1000;
const HOST_URLS = Object.fromEntries(
	DATASET_PREFIXES.flatMap(prefix => REQUIRED_SUFFIXES.map(suffix => {
		const canonicalName = `large-${suffix}`;
		const datasetName = `${prefix}-${suffix}`;
		return [[`${prefix}:${canonicalName}`, new URL(`/tests/data/opfs-bench-host/${datasetName}`, location.origin).href]];
	}))
);

const statusPill = document.getElementById("status-pill");
const status = document.getElementById("status") || statusPill;
const sourceMode = document.getElementById("source-mode");
const sourceModeHelp = document.getElementById("source-mode-help");
const selectedSourcesNode = document.getElementById("selected-sources");
const progressBar = document.getElementById("progress-bar");
const progressText = document.getElementById("progress-text");
const currentStepNode = document.getElementById("current-step");
const peakJsHeapNode = document.getElementById("peak-js-heap");
const resultTableBody = document.getElementById("result-table-body");
const phasesNode = document.getElementById("phases");
const resourceLogNode = document.getElementById("resource-log");
const resultsNode = document.getElementById("results");
const summaryNode = document.getElementById("summary");
const runMetadataNode = document.getElementById("run-metadata");
const errors = document.getElementById("errors");
const fileInput = document.getElementById("files");
const runButton = document.getElementById("run");

const results = [];
const phases = [];
const resourceLog = [];
const sourceSizeCache = new Map();
let currentStep = "Idle";
let resourceIntervalId = null;
const runMetadata = {
	runLabel: "opfs-bench-host",
	startedAt: null,
	finishedAt: null,
	status: "IDLE",
	inputSet: "host-large",
	commandTimeoutMinutes: COMMAND_TIMEOUT_MINUTES,
	resourceIntervalMinutes: RESOURCE_INTERVAL_MINUTES,
	requiredFiles: REQUIRED_SUFFIXES.map(suffix => `<prefix>-${suffix}`),
	userAgent: navigator.userAgent,
	platform: navigator.platform || "",
	hardwareConcurrency: navigator.hardwareConcurrency || null,
	deviceMemory: navigator.deviceMemory || null,
	origin: location.origin
};

render();
sourceMode.value = AUTO_MODE ? "auto-host" : "manual";
updateSourceModeUi();
runButton.addEventListener("click", () => {
	void runSelected();
});
sourceMode.addEventListener("change", () => {
	updateSourceModeUi();
});
fileInput.addEventListener("change", () => {
	render();
});
if(AUTO_MODE) {
	runButton.textContent = "Running host benchmark...";
	void runSelected();
}

async function runSelected() {
	runButton.disabled = true;
	errors.textContent = "None";
	results.length = 0;
	phases.length = 0;
	resourceLog.length = 0;
	runMetadata.startedAt = new Date().toISOString();
	runMetadata.finishedAt = null;
	runMetadata.status = "RUNNING";
	currentStep = "Initializing run";
	await logResourceSample("run:start");
	startResourceSampler();
	render();

	try {
		const sourceMap = selectedSourcesByName();
		phase("clear-opfs:start");
		await clearOpfs();
		phase("clear-opfs:done");
		await pushResult(await benchmarkMinimap2Source("opfs", sourceMap));
		await pushResult(await benchmarkMinimap2Source("input", sourceMap));
		await pushResult(await benchmarkSamtoolsViewSource("opfs", sourceMap));
		await pushResult(await benchmarkSamtoolsViewSource("input", sourceMap));
		runMetadata.status = results.every(result => result.passed) ? "PASS" : "FAIL";
		status.textContent = runMetadata.status;
	} catch (error) {
		runMetadata.status = "ERROR";
		status.textContent = "ERROR";
		errors.textContent = error?.stack || String(error);
	} finally {
		stopResourceSampler();
		await logResourceSample("run:finished");
		runMetadata.finishedAt = new Date().toISOString();
		render();
		runButton.disabled = false;
	}
}

async function benchmarkMinimap2Source(source, sourceMap) {
	status.textContent = `Running minimap2 (${source})...`;
	const CLI = await new Aioli([{
		tool: "minimap2",
		version: "2.22",
		urlPrefix: "https://biowasm.com/cdn/v3/minimap2/2.22"
	}], {
		debug: true,
		printInterleaved: false,
		opfsBackend: "direct"
	});

	try {
		await CLI.mkdir("/opfs/data");
		await CLI.mkdir("/opfs/results");
		phase(`minimap2/${source}:prepare:start`);
		const command = source === "input"
			? await prepareMinimap2Input(CLI, sourceMap)
			: await prepareMinimap2Opfs(CLI, sourceMap);
		const inputBytes = await sumSourceBytes([
			sourceMap["large-ref.fa"],
			sourceMap["large-reads.fq.gz"]
		]);
		phase(`minimap2/${source}:prepare:done`);
		return await runCase(CLI, {
			caseId: "minimap2-large-explicit-output",
			source,
			command,
			inputBytes,
			outputPath: "/results/host-aln.sam",
			validate: async () => {
				const preview = await readOpfsText("/results/host-aln.sam", 512);
				return {
					passed: preview.includes("@SQ") || preview.includes("@PG"),
					notes: preview.slice(0, 160)
				};
			}
		});
	} finally {
		await safeClose(CLI);
	}
}

async function benchmarkSamtoolsViewSource(source, sourceMap) {
	status.textContent = `Running samtools view (${source})...`;
	const CLI = await new Aioli([{
		tool: "samtools",
		version: "1.10",
		urlPrefix: "https://biowasm.com/cdn/v3/samtools/1.10"
	}], {
		debug: true,
		printInterleaved: false,
		opfsBackend: "direct"
	});

	try {
		await CLI.mkdir("/opfs/data");
		await CLI.mkdir("/opfs/results");
		phase(`samtools-view/${source}:prepare:start`);
		const command = source === "input"
			? await prepareSamtoolsInput(CLI, sourceMap)
			: await prepareSamtoolsOpfs(CLI, sourceMap);
		const inputBytes = await sumSourceBytes([
			sourceMap["large-sorted.bam"]
		]);
		phase(`samtools-view/${source}:prepare:done`);
		return await runCase(CLI, {
			caseId: "samtools-view-large-explicit-output",
			source,
			command,
			inputBytes,
			outputPath: "/results/host-view.sam",
			validate: async () => {
				const preview = await readOpfsText("/results/host-view.sam", 512);
				return {
					passed: preview.includes("@HD")
						|| preview.includes("@SQ")
						|| preview.includes("\t"),
					notes: preview.slice(0, 160)
				};
			}
		});
	} finally {
		await safeClose(CLI);
	}
}

async function prepareMinimap2Input(CLI, sourceMap) {
	phase("minimap2/input:mount-inputs:start");
	await CLI.mountInputs([
		toMountedSource(sourceMap["large-ref.fa"], "large-ref.fa"),
		toMountedSource(sourceMap["large-reads.fq.gz"], "large-reads.fq.gz")
	]);
	phase("minimap2/input:mount-inputs:done");
	return "minimap2 -a -o /opfs/results/host-aln.sam /input/large-ref.fa /input/large-reads.fq.gz";
}

async function prepareMinimap2Opfs(CLI, sourceMap) {
	phase("minimap2/opfs:import-ref:start");
	await importSourceToOpfs(CLI, "/data/large-ref.fa", sourceMap["large-ref.fa"]);
	phase("minimap2/opfs:import-ref:done");
	phase("minimap2/opfs:import-reads:start");
	await importSourceToOpfs(CLI, "/data/large-reads.fq.gz", sourceMap["large-reads.fq.gz"]);
	phase("minimap2/opfs:import-reads:done");
	return "minimap2 -a -o /opfs/results/host-aln.sam /opfs/data/large-ref.fa /opfs/data/large-reads.fq.gz";
}

async function prepareSamtoolsInput(CLI, sourceMap) {
	phase("samtools-view/input:mount-inputs:start");
	await CLI.mountInputs([toMountedSource(sourceMap["large-sorted.bam"], "large-sorted.bam")]);
	phase("samtools-view/input:mount-inputs:done");
	return "samtools view -h -o /opfs/results/host-view.sam /input/large-sorted.bam";
}

async function prepareSamtoolsOpfs(CLI, sourceMap) {
	phase("samtools-view/opfs:import-bam:start");
	await importSourceToOpfs(CLI, "/data/large-sorted.bam", sourceMap["large-sorted.bam"]);
	phase("samtools-view/opfs:import-bam:done");
	return "samtools view -h -o /opfs/results/host-view.sam /opfs/data/large-sorted.bam";
}

async function runCase(CLI, { caseId, source, command, inputBytes, outputPath, validate }) {
	const before = await sampleMemory();
	const started = performance.now();
	phase(`${caseId}/${source}:exec:start`);
	const commandResult = await withTimeout(CLI.exec(command), `${caseId}/${source} timed out after ${COMMAND_TIMEOUT_MINUTES} minutes`, COMMAND_TIMEOUT_MS);
	phase(`${caseId}/${source}:exec:done`);
	const commandFinished = performance.now();
	const outputBytes = await getOpfsFileSize(outputPath);
	phase(`${caseId}/${source}:validate:start`);
	const validation = await validate();
	phase(`${caseId}/${source}:validate:done`);
	const finished = performance.now();
	const after = await sampleMemory();

	return {
		case: caseId,
		source,
		inputSet: runMetadata.inputSet,
		fixtureSource: "user-selected-host-files",
		command,
		inputBytes,
		toolMs: extractToolMs(commandResult.stderr),
		totalMs: roundMs(finished - started),
		postCommandMs: roundMs(finished - commandFinished),
		outputBytes,
		jsHeapBefore: before.jsHeap,
		jsHeapAfter: after.jsHeap,
		jsHeapDelta: diffMetric(before.jsHeap, after.jsHeap),
		uaMemoryBefore: before.uaMemory,
		uaMemoryAfter: after.uaMemory,
		uaMemoryDelta: diffMetric(before.uaMemory, after.uaMemory),
		stderrSummary: summarizeStderr(commandResult.stderr),
		passed: commandSucceeded(commandResult) && outputBytes > 0 && validation.passed,
		notes: [validation.notes, summarizeStderr(commandResult.stderr)].filter(Boolean).join("\n\n")
	};
}

function selectedSourcesByName() {
	if(sourceMode.value === "auto-host")
		return buildResolvedSourceMap(buildAutoHostSources());

	return buildResolvedSourceMap(Object.fromEntries(Array.from(fileInput.files || []).map(file => [file.name, file])));
}

async function pushResult(result) {
	results.push(result);
	render();
}

function render() {
	selectedSourcesNode.textContent = JSON.stringify(currentSourceSummary(), null, 2);
	progressBar.max = 4;
	progressBar.value = results.length;
	progressText.textContent = `${results.length} / 4`;
	currentStepNode.textContent = currentStep;
	statusPill.textContent = runMetadata.status;
	statusPill.className = `status-pill ${statusClass(runMetadata.status)}`;
	peakJsHeapNode.textContent = formatBytes(maxMetric(results, "jsHeapDelta"));
	resultTableBody.innerHTML = buildResultTableRows(results);
	phasesNode.textContent = JSON.stringify(phases, null, 2);
	resourceLogNode.textContent = JSON.stringify(resourceLog, null, 2);
	resultsNode.textContent = JSON.stringify(results, null, 2);
	summaryNode.textContent = JSON.stringify(buildSummary(results), null, 2);
	runMetadataNode.textContent = JSON.stringify(runMetadata, null, 2);
}

function buildSummary(results) {
	const byCase = {};
	for(const result of results) {
		if(!byCase[result.case])
			byCase[result.case] = {};
		byCase[result.case][result.source] = {
			passed: result.passed,
			totalMs: result.totalMs,
			postCommandMs: result.postCommandMs,
			inputBytes: result.inputBytes,
			outputBytes: result.outputBytes,
			fixtureSource: result.fixtureSource,
			stderrSummary: result.stderrSummary,
			notes: result.notes
		};
	}

	const comparisons = {};
	for(const [caseId, caseResults] of Object.entries(byCase)) {
		if(caseResults.input && caseResults.opfs) {
			comparisons[caseId] = {
				inputMs: caseResults.input.totalMs,
				opfsMs: caseResults.opfs.totalMs,
				deltaMs: diffNullable(caseResults.input.totalMs, caseResults.opfs.totalMs),
				inputPostCommandMs: caseResults.input.postCommandMs,
				opfsPostCommandMs: caseResults.opfs.postCommandMs,
				postCommandDelta: diffNullable(caseResults.input.postCommandMs, caseResults.opfs.postCommandMs),
				inputBytes: caseResults.input.inputBytes || caseResults.opfs.inputBytes,
				outputBytes: caseResults.input.outputBytes || caseResults.opfs.outputBytes
			};
		}
	}

	return {
		totalCases: results.length,
		passingCases: results.filter(result => result.passed).length,
		byCase,
		comparisons
	};
}

function buildResultTableRows(results) {
	if(results.length === 0)
		return `<tr><td colspan="9">No benchmark results yet.</td></tr>`;

	return results.map(result => `
		<tr>
			<td>${escapeHtml(result.case)}</td>
			<td>${escapeHtml(result.source)}</td>
			<td><span class="status-pill ${result.passed ? "status-pass" : "status-fail"}">${result.passed ? "PASS" : "FAIL"}</span></td>
			<td>${formatDuration(result.totalMs)}</td>
			<td>${formatDuration(result.postCommandMs)}</td>
			<td>${formatBytes(result.inputBytes)}</td>
			<td>${formatBytes(result.outputBytes)}</td>
			<td>${formatBytes(result.jsHeapDelta)}</td>
			<td>${formatBytes(result.uaMemoryDelta)}</td>
		</tr>
	`).join("");
}

async function sumSourceBytes(sources) {
	const sizes = await Promise.all(sources.map(getSourceBytes));
	return sizes.reduce((sum, size) => sum + size, 0);
}

async function getSourceBytes(source) {
	if(source instanceof File)
		return source.size;

	if(source?.url) {
		if(sourceSizeCache.has(source.url))
			return sourceSizeCache.get(source.url);

		const response = await fetch(source.url, { method: "HEAD" });
		if(!response.ok)
			throw new Error(`Failed to fetch size for ${source.url}: HTTP ${response.status}`);
		const length = Number(response.headers.get("content-length"));
		if(!Number.isFinite(length))
			throw new Error(`Missing content-length for ${source.url}`);
		sourceSizeCache.set(source.url, length);
		return length;
	}

	throw new Error(`Unsupported source for size calculation: ${source}`);
}

function toMountedSource(source, targetName) {
	if(source instanceof File)
		return { name: targetName, data: source };
	if(source?.url)
		return { name: targetName, url: source.url };
	throw new Error(`Unsupported mounted source: ${source}`);
}

async function importSourceToOpfs(CLI, publicPath, source) {
	if(source instanceof File)
		return CLI.opfsWrite(publicPath, source);
	if(source?.url)
		return CLI.opfsImportFromUrl(publicPath, source.url);
	throw new Error(`Unsupported OPFS source: ${source}`);
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

async function sampleResources() {
	const memory = await sampleMemory();
	let storageUsage = null;
	let storageQuota = null;
	if(navigator.storage?.estimate) {
		try {
			const estimate = await navigator.storage.estimate();
			storageUsage = estimate.usage ?? null;
			storageQuota = estimate.quota ?? null;
		} catch {}
	}

	return {
		jsHeap: memory.jsHeap,
		uaMemory: memory.uaMemory,
		storageUsage,
		storageQuota
	};
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

function summarizeStderr(stderr) {
	if(typeof stderr !== "string" || stderr.length === 0)
		return "";
	return stderr.trim().split("\n").slice(-3).join("\n");
}

function extractToolMs(stderr) {
	if(typeof stderr !== "string" || stderr.length === 0)
		return null;
	const minimap2Match = stderr.match(/Real time:\s+([0-9.]+)\s+sec/i);
	if(minimap2Match)
		return Math.round(Number(minimap2Match[1]) * 1000 * 1000) / 1000;
	return null;
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

function diffMetric(before, after) {
	return Number.isFinite(before) && Number.isFinite(after) ? after - before : null;
}

function diffNullable(left, right) {
	return Number.isFinite(left) && Number.isFinite(right) ? right - left : null;
}

function roundMs(value) {
	return Math.round(value * 1000) / 1000;
}

async function withTimeout(promise, message, timeoutMs) {
	let timeoutId = null;
	const timeout = new Promise((_, reject) => {
		timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timeoutId);
	}
}

async function safeClose(CLI) {
	try {
		void CLI.close();
	} catch {}
}

function phase(name) {
	currentStep = name;
	phases.push({
		name,
		at: new Date().toISOString()
	});
	status.textContent = name;
	render();
}

function updateSourceModeUi() {
	const autoHost = sourceMode.value === "auto-host";
	fileInput.disabled = autoHost;
	sourceModeHelp.textContent = autoHost
		? "Auto-host URLs: use the same-origin links mapped to the current /opt/lucemics/data dataset."
		: "Manual file picker: choose one consistent set of small-, medium-, or large-* files from your local filesystem.";
	render();
}

function currentSourceSummary() {
	if(sourceMode.value === "auto-host") {
		const prefix = autoDatasetPrefix();
		return REQUIRED_SUFFIXES.map(suffix => {
			const canonicalName = `large-${suffix}`;
			return {
				name: canonicalName,
				datasetName: `${prefix}-${suffix}`,
				mode: "auto-host",
				url: HOST_URLS[`${prefix}:${canonicalName}`]
			};
		});
	}

	return Array.from(fileInput.files || []).map(file => ({
		name: file.name,
		mode: "manual",
		size: file.size
	}));
}

function buildAutoHostSources() {
	const prefix = autoDatasetPrefix();
	return Object.fromEntries(REQUIRED_SUFFIXES.map(suffix => {
		const canonicalName = `large-${suffix}`;
		const datasetName = `${prefix}-${suffix}`;
		return [datasetName, {
			name: datasetName,
			mode: "auto-host",
			url: HOST_URLS[`${prefix}:${canonicalName}`]
		}];
	}));
}

function statusClass(status) {
	switch(status) {
		case "PASS":
			return "status-pass";
		case "FAIL":
			return "status-fail";
		case "ERROR":
			return "status-error";
		default:
			return "status-running";
	}
}

function maxMetric(items, key) {
	const values = items.map(item => item[key]).filter(Number.isFinite);
	return values.length ? Math.max(...values) : null;
}

function formatDuration(value) {
	if(!Number.isFinite(value))
		return "n/a";
	if(value >= 60000)
		return `${(value / 60000).toFixed(1)} min`;
	if(value >= 1000)
		return `${(value / 1000).toFixed(1)} s`;
	return `${value.toFixed(1)} ms`;
}

function formatBytes(value) {
	if(!Number.isFinite(value))
		return "n/a";
	if(value === 0)
		return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let size = value;
	let unitIndex = 0;
	while(size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex += 1;
	}
	return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function buildResolvedSourceMap(availableSources) {
	const prefix = detectDatasetPrefix(Object.keys(availableSources));
	const resolved = {};
	for(const suffix of REQUIRED_SUFFIXES) {
		const name = `${prefix}-${suffix}`;
		if(!(name in availableSources))
			throw new Error(`Missing required files for '${prefix}' dataset: ${name}`);
		resolved[`large-${suffix}`] = availableSources[name];
	}
	runMetadata.inputSet = `${prefix}-host`;
	runMetadata.selectedDatasetPrefix = prefix;
	return resolved;
}

function detectDatasetPrefix(names) {
	for(const prefix of DATASET_PREFIXES) {
		if(REQUIRED_SUFFIXES.every(suffix => names.includes(`${prefix}-${suffix}`)))
			return prefix;
	}
	throw new Error(`Missing required files: select one complete set of ${DATASET_PREFIXES.map(prefix => `${prefix}-*`).join(", ")} files`);
}

function autoDatasetPrefix() {
	if(AUTO_DATASET && DATASET_PREFIXES.includes(AUTO_DATASET))
		return AUTO_DATASET;
	return "large";
}

function startResourceSampler() {
	stopResourceSampler();
	if(!(RESOURCE_INTERVAL_MS > 0))
		return;
	resourceIntervalId = setInterval(() => {
		void logResourceSample("interval");
	}, RESOURCE_INTERVAL_MS);
}

function stopResourceSampler() {
	if(resourceIntervalId != null) {
		clearInterval(resourceIntervalId);
		resourceIntervalId = null;
	}
}

async function logResourceSample(reason) {
	const resources = await sampleResources();
	resourceLog.push({
		at: new Date().toISOString(),
		reason,
		currentStep,
		elapsedSeconds: elapsedSeconds(),
		jsHeap: resources.jsHeap,
		uaMemory: resources.uaMemory,
		storageUsage: resources.storageUsage,
		storageQuota: resources.storageQuota
	});
	render();
}

function elapsedSeconds() {
	if(!runMetadata.startedAt)
		return 0;
	return Math.round((Date.now() - Date.parse(runMetadata.startedAt)) / 1000);
}
