describe("Aioli /input mounts", () => {
	it("mounts read-only input files under /input", () => {
		cy.visit("/src/examples/input-mount-test.html");
		cy.get("#status").should("have.text", "PASS");
		cy.get("#results").invoke("text").then(text => {
			const results = JSON.parse(text);
			const byName = Object.fromEntries(results.map(result => [result.name, result]));
			expect(byName["mount-path"].passed).to.equal(true);
			expect(byName["list-inputs"].passed).to.equal(true);
			expect(byName["read-input"].passed).to.equal(true);
			expect(byName["reject-write"].passed).to.equal(true);
		});
		cy.get("#errors").should("have.text", "");
	});
});
