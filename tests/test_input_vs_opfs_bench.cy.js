describe("/input vs /opfs benchmark", () => {
	it("compares read sources for minimap2 and samtools view", () => {
		cy.visit("/src/examples/input-vs-opfs-bench.html");
		cy.get("#status", { timeout: 120000 }).should($status => {
			expect(["PASS", "ERROR"]).to.include($status.text());
		}).invoke("text").then(status => {
			if(status !== "PASS") {
				cy.get("#errors").invoke("text").then(errorText => {
					throw new Error(`input-vs-opfs status=${status}\n${errorText}`);
				});
			}
		});
		cy.get("#results").invoke("text").then(text => {
			const results = JSON.parse(text);
			expect(results).to.have.length(4);
			for(const result of results)
				expect(result.passed).to.equal(true);
		});
		cy.get("#summary").invoke("text").then(text => {
			const summary = JSON.parse(text);
			expect(summary.totalCases).to.equal(4);
			expect(summary.passingCases).to.equal(4);
			expect(summary.comparisons["minimap2-read-source"]).to.exist;
			expect(summary.comparisons["samtools-view-read-source"]).to.exist;
		});
		cy.get("#errors").should("have.text", "");
	});
});
