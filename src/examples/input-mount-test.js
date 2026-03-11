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
		urlPrefix: `${location.origin}/tests/data/samtools`,
		loading: "lazy"
	}], {
		printInterleaved: false
	});

	status.textContent = "Mounting inputs...";
	const mounted = await CLI.mountInputs([
		new File(["input\ncontents\n"], "input.txt")
	]);
	record("mount-path", JSON.stringify(mounted) === JSON.stringify(["/input/input.txt"]), JSON.stringify(mounted));

	const listed = await CLI.listInputs();
	record("list-inputs", Array.isArray(listed) && listed.includes("input.txt"), JSON.stringify(listed));

	const contents = await CLI.cat("/input/input.txt");
	record("read-input", contents === "input\ncontents\n", contents);

	try {
		await CLI.write({ path: "/input/input.txt", buffer: new Uint8Array([65]) });
		record("reject-write", false, "write unexpectedly succeeded");
	} catch (error) {
		record("reject-write", String(error).includes("Cannot write to read-only mounted input path"), String(error));
	}

	status.textContent = results.every(result => result.passed) ? "PASS" : "FAIL";
} catch (error) {
	status.textContent = "ERROR";
	errors.textContent = error?.stack || String(error);
}
