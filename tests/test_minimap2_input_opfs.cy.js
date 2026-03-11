describe("minimap2 /input to /opfs workflow", () => {
	it("reads mounted /input FASTA files and writes SAM to OPFS", () => {
		cy.visit("/src/examples/minimap2-input-opfs-test.html");
		cy.get("#status").should("have.text", "PASS");
		cy.get("#results").invoke("text").then(text => {
			const results = JSON.parse(text);
			const byName = Object.fromEntries(results.map(result => [result.name, result]));
			expect(byName["mount-inputs"].passed).to.equal(true);
			expect(byName["stderr-real-time"].passed).to.equal(true);
			expect(byName["opfs-output"].passed).to.equal(true);
			expect(byName["input-still-readable"].passed).to.equal(true);
		});
		cy.get("#errors").should("have.text", "");
	});
});
