import Aioli from "../../dist/aioli.mjs";

const status = document.getElementById("status");
const resultsNode = document.getElementById("results");
const errors = document.getElementById("errors");
const results = [];

function record(name, passed, detail = "") {
	results.push({ name, passed, detail });
	resultsNode.textContent = JSON.stringify(results, null, 2);
}

try {
	status.textContent = "Initializing Aioli...";

	const CLI = await new Aioli([{
		tool: "samtools",
		version: "1.10",
		urlPrefix: "https://biowasm.com/cdn/v3/samtools/1.10"
	}], {
		debug: true,
		printInterleaved: false,
		opfsBackend: "direct"
	});

	await clearOpfs();
	await CLI.mkdir("/opfs/tmp");
	await CLI.mkdir("/opfs/results");

	status.textContent = "Creating a BAM source file...";
	await CLI.exec("samtools view -b -o /opfs/tmp/user.bam /shared/samtools/examples/toy.sam");
	const bamBlob = await CLI.downloadBlob("/opfs/tmp/user.bam");
	const mounted = await CLI.mountInputs([
		new File([bamBlob], "user.bam", { type: "application/octet-stream" })
	]);
	record("mount-input", mounted.includes("/input/user.bam"), JSON.stringify(mounted));

	status.textContent = "Running samtools view...";
	const output = await CLI.exec("samtools view -o /opfs/results/out.sam /input/user.bam");
	record("stderr-clean", output.stderr === "", output.stderr);

	const sam = await CLI.opfsRead("/results/out.sam");
	record("opfs-output", sam.includes("r001") && sam.includes("r003"), sam.slice(0, 200));
	record("input-still-readable", (await CLI.ls("/input")).includes("user.bam"), "");

	status.textContent = results.every(result => result.passed) ? "PASS" : "FAIL";
} catch (error) {
	status.textContent = "ERROR";
	errors.textContent = error?.stack || String(error);
}

async function clearOpfs() {
	const root = await navigator.storage.getDirectory();
	for await (const [name] of root.entries())
		await root.removeEntry(name, { recursive: true });
}
