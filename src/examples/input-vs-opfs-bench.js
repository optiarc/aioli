import Aioli from "../../dist/aioli.mjs";

const status = document.getElementById("status");
const resultsNode = document.getElementById("results");
const summaryNode = document.getElementById("summary");
const errors = document.getElementById("errors");

const results = [];
let runCounter = 0;

function record(result) {
	results.push(result);
	resultsNode.textContent = JSON.stringify(results, null, 2);
	summaryNode.textContent = JSON.stringify(buildSummary(results), null, 2);
}

void main();

async function main() {
	try {
		await clearOpfs();
		await safeRun("minimap2-read-source", "opfs", () => runMinimap2("opfs"));
		await safeRun("minimap2-read-source", "input", () => runMinimap2("input"));
		await safeRun("samtools-view-read-source", "opfs", () => runSamtoolsView("opfs"));
		await safeRun("samtools-view-read-source", "input", () => runSamtoolsView("input"));
		status.textContent = results.every(result => result.passed) ? "PASS" : "FAIL";
	} catch (error) {
		status.textContent = "ERROR";
		errors.textContent = error?.stack || String(error);
	}
}

async function safeRun(caseName, source, run) {
	try {
		await withTimeout(run(), `${caseName}/${source} timed out`, 15000);
	} catch (error) {
		record({
			case: caseName,
			source,
			totalMs: null,
			passed: false,
			notes: error?.stack || String(error)
		});
	}
}

async function runMinimap2(source) {
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
	const runId = nextRunId("minimap2", source);

	await CLI.mkdir("/opfs/results");
	await CLI.mkdir("/opfs/data");
	const human = await CLI.cat("/minimap2/MT-human.fa");
	const orang = await CLI.cat("/minimap2/MT-orang.fa");
	const command = source === "input"
		? await prepareMinimap2InputPaths(CLI, human, orang, runId)
		: await prepareMinimap2OpfsPaths(CLI, human, orang, runId);

	const started = performance.now();
	const output = await CLI.exec(command);
	const totalMs = Math.round((performance.now() - started) * 1000) / 1000;
	const sam = await CLI.opfsRead(`/results/minimap2-${runId}.sam`);

	record({
		case: "minimap2-read-source",
		source,
		totalMs,
		passed: output.stderr.includes("Real time") && sam.includes("@SQ"),
		notes: output.stderr.trim().split("\n").slice(-2).join("\n")
	});
}

async function runSamtoolsView(source) {
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
	const runId = nextRunId("samtools-view", source);

	await CLI.mkdir("/opfs/tmp");
	await CLI.mkdir("/opfs/results");
	await CLI.mkdir("/opfs/data");
	await CLI.exec(`samtools view -b -o /opfs/tmp/user-${runId}.bam /shared/samtools/examples/toy.sam`);
	const bamBlob = await CLI.downloadBlob(`/opfs/tmp/user-${runId}.bam`);

	const command = source === "input"
		? await prepareSamtoolsInputPath(CLI, bamBlob, runId)
		: await prepareSamtoolsOpfsPath(CLI, bamBlob, runId);

	const started = performance.now();
	const output = await CLI.exec(command);
	const totalMs = Math.round((performance.now() - started) * 1000) / 1000;
	const sam = await CLI.opfsRead(`/results/samtools-${runId}.sam`);

	record({
		case: "samtools-view-read-source",
		source,
		totalMs,
		passed: output.stderr === "" && sam.includes("r001"),
		notes: output.stderr
	});
}

async function prepareMinimap2InputPaths(CLI, human, orang, runId) {
	await CLI.mountInputs([
		new File([human], `MT-human-${runId}.fa`),
		new File([orang], `MT-orang-${runId}.fa`)
	]);
	return `minimap2 -a -o /opfs/results/minimap2-${runId}.sam /input/MT-human-${runId}.fa /input/MT-orang-${runId}.fa`;
}

async function prepareMinimap2OpfsPaths(CLI, human, orang, runId) {
	await CLI.opfsWrite(`/data/MT-human-${runId}.fa`, human);
	await CLI.opfsWrite(`/data/MT-orang-${runId}.fa`, orang);
	return `minimap2 -a -o /opfs/results/minimap2-${runId}.sam /opfs/data/MT-human-${runId}.fa /opfs/data/MT-orang-${runId}.fa`;
}

async function prepareSamtoolsInputPath(CLI, bamBlob, runId) {
	await CLI.mountInputs([
		new File([bamBlob], `user-${runId}.bam`, { type: "application/octet-stream" })
	]);
	return `samtools view -o /opfs/results/samtools-${runId}.sam /input/user-${runId}.bam`;
}

async function prepareSamtoolsOpfsPath(CLI, bamBlob, runId) {
	await CLI.opfsWrite(`/data/user-${runId}.bam`, bamBlob);
	return `samtools view -o /opfs/results/samtools-${runId}.sam /opfs/data/user-${runId}.bam`;
}

function buildSummary(results) {
	const byCase = {};
	for(const result of results) {
		if(!byCase[result.case])
			byCase[result.case] = {};
		byCase[result.case][result.source] = {
			passed: result.passed,
			totalMs: result.totalMs
		};
	}

	return {
		totalCases: results.length,
		passingCases: results.filter(result => result.passed).length,
		comparisons: Object.fromEntries(Object.entries(byCase).map(([name, value]) => [
			name,
			{
				inputMs: value.input?.totalMs ?? null,
				opfsMs: value.opfs?.totalMs ?? null,
				deltaMs: value.input && value.opfs ? value.input.totalMs - value.opfs.totalMs : null
			}
		]))
	};
}

async function clearOpfs() {
	const root = await navigator.storage.getDirectory();
	for await (const [name] of root.entries())
		await root.removeEntry(name, { recursive: true });
}

function nextRunId(caseName, source) {
	runCounter += 1;
	return `${caseName}-${source}-${runCounter}`;
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
