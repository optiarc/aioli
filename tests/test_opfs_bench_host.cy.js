describe("OPFS benchmark host-file harness", () => {
	it("runs the host-file large benchmark cases", () => {
		cy.visit("/src/examples/opfs-bench-host.html?mode=auto-host");
		cy.get("#status", { timeout: 3600000 }).should($status => {
			expect(["PASS", "FAIL", "ERROR"]).to.include($status.text());
		}).invoke("text").then(status => {
			if(status === "ERROR") {
				cy.get("#errors").invoke("text").then(errorText => {
					throw new Error(`host benchmark status=ERROR\n${errorText}`);
				});
				return;
			}
			cy.get("#results").invoke("text").then(text => {
				const results = JSON.parse(text || "[]");
				cy.writeFile("tests/.artifacts/opfs-bench-host-results.json", results);
				cy.get("#summary").invoke("text").then(summaryText => {
					const summary = JSON.parse(summaryText || "{}");
					cy.writeFile("tests/.artifacts/opfs-bench-host-summary.json", summary);
					cy.get("#run-metadata").invoke("text").then(metadataText => {
						const metadata = JSON.parse(metadataText || "{}");
						cy.writeFile("tests/.artifacts/opfs-bench-host-metadata.json", metadata);
						if(status !== "PASS") {
							const failed = results.filter(result => !result.passed)
								.map(result => `${result.case}:${result.source}\n${result.notes}`)
								.join("\n\n");
							throw new Error(`host benchmark status=${status}\n${failed}`);
						}
						expect(results).to.have.length(4);
						for(const result of results) {
							expect(result.inputSet).to.equal("host-large");
							expect(result.fixtureSource).to.equal("user-selected-host-files");
							expect(result.passed).to.equal(true);
							expect(result.outputBytes).to.be.greaterThan(0);
						}
						expect(summary.totalCases).to.equal(4);
						expect(summary.passingCases).to.equal(4);
						expect(summary.comparisons["minimap2-large-explicit-output"]).to.exist;
						expect(summary.comparisons["samtools-view-large-explicit-output"]).to.exist;
						expect(metadata.status).to.equal("PASS");
					});
				});
			});
		});
		cy.get("#errors").should("have.text", "");
	});
});
