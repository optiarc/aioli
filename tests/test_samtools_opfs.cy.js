describe("samtools OPFS workflows", () => {
	it("passes the harness page with sort, index, and faidx as required behaviors", () => {
		cy.visit("/src/examples/samtools-opfs-test.html");
		cy.get("#status").should("have.text", "PASS");
		cy.get("#results").invoke("text").then(text => {
			const checks = JSON.parse(text);
			cy.writeFile("tests/.artifacts/samtools-opfs-results.json", checks);
			const byName = Object.fromEntries(checks.map(check => [check.name, check]));

			expect(byName["view-explicit-output"].passed).to.equal(true);
			expect(byName["fastq-explicit-output"].passed).to.equal(true);
			expect(byName["opfs-input-to-opfs-output"].passed).to.equal(true);
			expect(byName["sort-explicit-output"].passed).to.equal(true);
			expect(byName["index-sidecar"].passed).to.equal(true);
			expect(byName["faidx-sidecar"].passed).to.equal(true);

			expect(byName["sort-explicit-output"]).to.exist;
			expect(byName["index-sidecar"]).to.exist;
			expect(byName["faidx-sidecar"]).to.exist;
		});
		cy.get("#errors").should("have.text", "");
	});

	describe("future workflows", () => {
		it.skip("broader implicit file creation in OPFS", () => {});
	});
});
