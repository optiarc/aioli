import Aioli from "../../dist/aioli.mjs";

const status = document.getElementById("status");
const stderr = document.getElementById("stderr");
const samPreview = document.getElementById("sam-preview");

status.textContent = "Initializing Aioli...";

const CLI = await new Aioli([{
	tool: "minimap2",
	version: "2.22",
	urlPrefix: "https://biowasm.com/cdn/v3/minimap2/2.22"
}], {
	debug: true,
	printInterleaved: false
});

status.textContent = "Preparing staged OPFS workspace...";
await clearOpfs();
await CLI.mkdir("/shared/opfs/results");

status.textContent = "Running minimap2...";
const output = await CLI.exec(
	"minimap2 -a -o /shared/opfs/results/aln.sam /minimap2/MT-human.fa /minimap2/MT-orang.fa"
);

status.textContent = "Flushing SAM output to browser OPFS...";
await CLI.opfsFlush("/shared/opfs/results/aln.sam", "/results/aln.sam");

const sam = await CLI.opfsRead("/results/aln.sam");

status.textContent = "Complete. Persisted file is available at /results/aln.sam in OPFS.";
stderr.textContent = output.stderr;
samPreview.textContent = sam.slice(0, 2000);

async function clearOpfs() {
	const root = await navigator.storage.getDirectory();
	for await (const [name] of root.entries())
		await root.removeEntry(name, { recursive: true });
}
