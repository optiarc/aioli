describe("samtools OPFS workflows", () => {
	it("passes the explicit-output harness page", () => {
		cy.visit("/src/examples/samtools-opfs-test.html");
		cy.get("#status").should("have.text", "PASS");
		cy.get("#results").should("contain.text", "\"name\": \"view-explicit-output\"");
		cy.get("#results").should("contain.text", "\"name\": \"fastq-explicit-output\"");
		cy.get("#results").should("contain.text", "\"name\": \"opfs-input-to-opfs-output\"");
		cy.get("#results").should("not.contain.text", "\"passed\": false");
		cy.get("#errors").should("have.text", "");
	});

	describe("future workflows", () => {
		it.skip("sort output to OPFS", () => {});
		it.skip("index sidecar creation in OPFS", () => {});
		it.skip("faidx sidecar creation in OPFS", () => {});
	});
});
