function runDerivedDataset(prefix) {
	cy.visit(`/src/examples/opfs-bench-host.html?mode=auto-host&dataset=${prefix}&timeoutMinutes=30&resourceMinutes=1`);
	cy.get("#status", { timeout: 3600000 }).should($status => {
		expect(["PASS", "FAIL", "ERROR"]).to.include($status.text());
	}).invoke("text").then(status => {
		cy.get("#results").invoke("text").then(text => {
			const results = JSON.parse(text || "[]");
			cy.writeFile(`tests/.artifacts/opfs-bench-${prefix}-results.json`, results);
			cy.get("#summary").invoke("text").then(summaryText => {
				const summary = JSON.parse(summaryText || "{}");
				cy.writeFile(`tests/.artifacts/opfs-bench-${prefix}-summary.json`, summary);
				cy.get("#run-metadata").invoke("text").then(metadataText => {
					const metadata = JSON.parse(metadataText || "{}");
					cy.writeFile(`tests/.artifacts/opfs-bench-${prefix}-metadata.json`, metadata);

					if(status === "ERROR") {
						cy.get("#errors").invoke("text").then(errorText => {
							throw new Error(`${prefix} benchmark status=ERROR\n${errorText}`);
						});
						return;
					}

					if(status !== "PASS") {
						const failed = results.filter(result => !result.passed)
							.map(result => `${result.case}:${result.source}\n${result.notes}`)
							.join("\n\n");
						throw new Error(`${prefix} benchmark status=${status}\n${failed}`);
					}

					expect(results).to.have.length(4);
					for(const result of results) {
						expect(result.inputSet).to.equal(`${prefix}-host`);
						expect(result.fixtureSource).to.equal("user-selected-host-files");
						expect(result.passed).to.equal(true);
						expect(result.outputBytes).to.be.greaterThan(0);
					}

					expect(summary.totalCases).to.equal(4);
					expect(summary.passingCases).to.equal(4);
					expect(summary.comparisons["minimap2-large-explicit-output"]).to.exist;
					expect(summary.comparisons["samtools-view-large-explicit-output"]).to.exist;
					expect(metadata.status).to.equal("PASS");
					expect(metadata.inputSet).to.equal(`${prefix}-host`);
				});
			});
		});
	});
	cy.get("#errors").then($errors => {
		const text = $errors.text();
		if(text && text !== "None")
			throw new Error(`${prefix} benchmark page errors:\n${text}`);
	});
}

describe("OPFS benchmark derived datasets", () => {
	it("runs the small derived dataset", () => {
		runDerivedDataset("small");
	});

	it("runs the medium derived dataset", () => {
		runDerivedDataset("medium");
	});
});
