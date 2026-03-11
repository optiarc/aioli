describe("samtools /input to /opfs workflow", () => {
	it("reads a mounted /input BAM file and writes SAM to OPFS", () => {
		cy.visit("/src/examples/samtools-input-opfs-test.html");
		cy.get("#status").should("have.text", "PASS");
		cy.get("#results").invoke("text").then(text => {
			const results = JSON.parse(text);
			const byName = Object.fromEntries(results.map(result => [result.name, result]));
			expect(byName["mount-input"].passed).to.equal(true);
			expect(byName["stderr-clean"].passed).to.equal(true);
			expect(byName["opfs-output"].passed).to.equal(true);
			expect(byName["input-still-readable"].passed).to.equal(true);
		});
		cy.get("#errors").should("have.text", "");
	});
});
