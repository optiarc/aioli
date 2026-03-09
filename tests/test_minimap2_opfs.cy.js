import Aioli from "../dist/aioli.js";

const TOOLS_MINIMAP2 = [
	{
		tool: "minimap2",
		version: "2.22",
		urlPrefix: "https://biowasm.com/cdn/v3/minimap2/2.22"
	}
];

describe("minimap2 OPFS workflow", () => {
	it("writes SAM output through the staged OPFS workspace", async () => {
		const CLI = await new Aioli(TOOLS_MINIMAP2, {
			debug: true,
			printInterleaved: false
		});
		await clearOpfs();

		await CLI.mkdir("/shared/opfs/results");
		const output = await CLI.exec(
			"minimap2 -a -o /shared/opfs/results/aln.sam /minimap2/MT-human.fa /minimap2/MT-orang.fa"
		);
		await CLI.opfsFlush("/shared/opfs/results/aln.sam", "/results/aln.sam");

		expect(output.stdout).to.equal("");
		expect(output.stderr).to.include("Real time");

		const sam = await CLI.opfsRead("/results/aln.sam");
		expect(sam).to.include("@SQ");
		expect(sam).to.include("MT-human");
		expect(sam).to.include("MT-orang");
	});
});

async function clearOpfs() {
	const root = await navigator.storage.getDirectory();
	for await (const [name] of root.entries())
		await root.removeEntry(name, { recursive: true });
}
