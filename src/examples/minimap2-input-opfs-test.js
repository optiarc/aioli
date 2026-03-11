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
		tool: "minimap2",
		version: "2.22",
		urlPrefix: "https://biowasm.com/cdn/v3/minimap2/2.22"
	}], {
		debug: true,
		printInterleaved: false,
		opfsBackend: "direct"
	});

	await clearOpfs();
	await CLI.mkdir("/opfs/results");

	status.textContent = "Loading bundled FASTA inputs...";
	const human = await CLI.cat("/minimap2/MT-human.fa");
	const orang = await CLI.cat("/minimap2/MT-orang.fa");
	const mounted = await CLI.mountInputs([
		new File([human], "MT-human.fa"),
		new File([orang], "MT-orang.fa")
	]);
	record("mount-inputs", mounted.includes("/input/MT-human.fa") && mounted.includes("/input/MT-orang.fa"), JSON.stringify(mounted));

	status.textContent = "Running minimap2...";
	const output = await CLI.exec(
		"minimap2 -a -o /opfs/results/aln.sam /input/MT-human.fa /input/MT-orang.fa"
	);
	record("stderr-real-time", output.stderr.includes("Real time"), output.stderr);

	const sam = await CLI.opfsRead("/results/aln.sam");
	record("opfs-output", sam.includes("@SQ") && sam.includes("MT_human") && sam.includes("MT_orang"), sam.slice(0, 200));
	record("input-still-readable", (await CLI.cat("/input/MT-human.fa")).includes("MT_human"), "");

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
