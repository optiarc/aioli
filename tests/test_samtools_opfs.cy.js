describe("samtools OPFS workflows", () => {
	it("passes the explicit-output harness page", () => {
		cy.visit("/src/examples/samtools-opfs-test.html");
		cy.get("#status").should("have.text", "PASS");
		cy.get("#results").invoke("text").then(text => {
			const checks = JSON.parse(text);
			cy.writeFile("tests/.artifacts/samtools-opfs-results.json", checks);
			const byName = Object.fromEntries(checks.map(check => [check.name, check]));

			expect(byName["view-explicit-output"].passed).to.equal(true);
			expect(byName["fastq-explicit-output"].passed).to.equal(true);
			expect(byName["opfs-input-to-opfs-output"].passed).to.equal(true);

			expect(byName["sort-explicit-output-probe"]).to.exist;
			expect(byName["index-sidecar-probe"]).to.exist;
			expect(byName["faidx-sidecar-probe"]).to.exist;
		});
		cy.get("#errors").should("have.text", "");
	});

	describe("future workflows", () => {
		it.skip("sort output to OPFS", () => {});
		it.skip("index sidecar creation in OPFS", () => {});
		it.skip("faidx sidecar creation in OPFS", () => {});
	});
});
