import Aioli from "../dist/aioli.js";

const TOOLS_LOCAL = [
	{
		tool: "coreutils",
		program: "cat",
		version: "8.32",
		urlPrefix: "http://localhost:11111/tests/data/cat"
	},
	{
		tool: "samtools",
		version: "1.10",
		urlPrefix: "http://localhost:11111/tests/data/samtools"
	}
];

describe("OPFS utilities", () => {
	it("writes, lists, persists, copies, and deletes OPFS files", async () => {
		const CLI = await new Aioli(TOOLS_LOCAL, { debug: true });
		await clearOpfs();

		await CLI.opfsMkdir("/results");
		await CLI.opfsWrite("/results/hello.txt", "hello opfs");

		const text = await CLI.opfsRead("/results/hello.txt");
		expect(text).to.equal("hello opfs");

		const entries = await CLI.opfsList("/results");
		expect(entries).to.deep.equal([
			{ name: "hello.txt", kind: "file" }
		]);

		await CLI.mkdir("/shared/data/out");
		await CLI.copyFromOpfs("/results/hello.txt", "/shared/data/out/hello.txt");
		const copiedIntoFs = await CLI.cat("/shared/data/out/hello.txt");
		expect(copiedIntoFs).to.equal("hello opfs");

		const [fsInputPath] = await CLI.mount([{ name: "from-fs.txt", data: "fs payload" }]);
		const copiedPath = await CLI.copyToOpfs(fsInputPath, "/results/from-fs.txt");
		expect(copiedPath).to.equal("/results/from-fs.txt");
		expect(await CLI.opfsRead("/results/from-fs.txt")).to.equal("fs payload");

		const CLI2 = await new Aioli(TOOLS_LOCAL, { debug: true });
		expect(await CLI2.opfsRead("/results/hello.txt")).to.equal("hello opfs");
		expect(await CLI2.opfsRead("/results/from-fs.txt")).to.equal("fs payload");

		await CLI2.opfsDelete("/results/hello.txt");
		await CLI2.opfsDelete("/results/from-fs.txt");
		await CLI2.opfsDelete("/results", { recursive: true });
		expect(await CLI2.opfsList("/")).to.deep.equal([]);
	});

	it("persists command-generated files to OPFS via exec options", async () => {
		const CLI = await new Aioli(TOOLS_LOCAL, { debug: true });
		await clearOpfs();

		const stderr = await CLI.exec(
			"samtools fastq -0 toy.fastq -o toy.fastq /shared/samtools/examples/toy.sam",
			null,
			{ persist: { from: "toy.fastq", to: "/results/toy.fastq" } }
		);

		expect(stderr).to.equal(`[M::bam2fq_mainloop] discarded 0 singletons\n[M::bam2fq_mainloop] processed 12 reads\n`);
		expect(await CLI.opfsRead("/results/toy.fastq")).to.include("@r001");

		const entries = await CLI.opfsList("/results");
		expect(entries).to.deep.equal([
			{ name: "toy.fastq", kind: "file" }
		]);
	});

	it("stages tool-visible /opfs paths for command input and output", async () => {
		const CLI = await new Aioli(TOOLS_LOCAL, { debug: true });
		await clearOpfs();

		await CLI.opfsWrite("/inputs/message.txt", "hello staged opfs");
		await CLI.opfsStage("/inputs/message.txt");
		const catOutput = await CLI.exec("cat /shared/opfs/inputs/message.txt");
		expect(catOutput).to.equal("hello staged opfs\n");

		await CLI.mkdir("/shared/opfs/results");
		await CLI.exec("samtools view -o /shared/opfs/results/toy.sam /shared/samtools/examples/toy.sam");
		await CLI.opfsFlush("/shared/opfs/results/toy.sam", "/results/toy.sam");

		const persisted = await CLI.opfsRead("/results/toy.sam");
		expect(persisted).to.include("r001");
	});
});

async function clearOpfs() {
	const root = await navigator.storage.getDirectory();
	for await (const [name] of root.entries())
		await root.removeEntry(name, { recursive: true });
}
