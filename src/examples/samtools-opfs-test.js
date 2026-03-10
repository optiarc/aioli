import Aioli from "../../dist/aioli.mjs";

const status = document.getElementById("status");
const results = document.getElementById("results");
const errors = document.getElementById("errors");

const checks = [];

function recordCheck(name, passed, detail = "") {
	checks.push({
		name,
		passed,
		detail
	});
	results.textContent = JSON.stringify(checks, null, 2);
}

try {
	status.textContent = "Initializing Aioli...";

	const CLI = await new Aioli([{
		tool: "samtools",
		version: "1.10",
		urlPrefix: "https://biowasm.com/cdn/v3/samtools/1.10"
	}], {
		debug: true,
		opfsBackend: "direct",
		printInterleaved: false
	});

	await clearOpfs();
	await CLI.mkdir("/opfs/results");

	status.textContent = "Running samtools view...";
	const viewOutput = await CLI.exec(
		"samtools view -o /opfs/results/toy.sam /shared/samtools/examples/toy.sam"
	);
	const toySam = await CLI.opfsRead("/results/toy.sam");
	recordCheck("view-explicit-output", viewOutput.stderr === "" && toySam.includes("r001"));

	status.textContent = "Running samtools fastq...";
	const fastqOutput = await CLI.exec(
		"samtools fastq -0 /opfs/results/toy.fastq -o /opfs/results/toy.fastq /shared/samtools/examples/toy.sam"
	);
	const toyFastq = await CLI.opfsRead("/results/toy.fastq");
	recordCheck(
		"fastq-explicit-output",
		fastqOutput.stderr.includes("processed 12 reads") && toyFastq.includes("@r001"),
		fastqOutput.stderr
	);

	status.textContent = "Preparing OPFS input...";
	const sampleSam = await CLI.cat("/shared/samtools/examples/toy.sam");
	await CLI.opfsWrite("/inputs/toy.sam", sampleSam);

	status.textContent = "Running samtools with OPFS input...";
	const roundTripOutput = await CLI.exec(
		"samtools view -o /opfs/results/from-opfs.sam /opfs/inputs/toy.sam"
	);
	const roundTripSam = await CLI.opfsRead("/results/from-opfs.sam");
	recordCheck(
		"opfs-input-to-opfs-output",
		roundTripOutput.stderr === "" && roundTripSam.includes("r001")
	);

	status.textContent = checks.every(check => check.passed) ? "PASS" : "FAIL";
} catch (error) {
	status.textContent = "ERROR";
	errors.textContent = error?.stack || String(error);
}

async function clearOpfs() {
	const root = await navigator.storage.getDirectory();
	for await (const [name] of root.entries())
		await root.removeEntry(name, { recursive: true });
}
