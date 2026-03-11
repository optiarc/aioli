describe("OPFS benchmark dev harness", () => {
	it("emits benchmark results for the development fixtures", () => {
		cy.visit("/src/examples/opfs-bench-dev.html");
		cy.get("#status", { timeout: 120000 }).should($status => {
			expect(["PASS", "FAIL", "ERROR"]).to.include($status.text());
		}).invoke("text").then(status => {
			if(status === "ERROR") {
				cy.get("#errors").invoke("text").then(errorText => {
					throw new Error(`benchmark harness status=ERROR\n${errorText}`);
				});
				return;
			}
			if(status !== "PASS") {
				cy.get("#results").invoke("text").then(text => {
					const results = JSON.parse(text || "[]");
					const failed = results.filter(result => !result.passed)
						.map(result => `${result.case}:${result.backend}\n${result.notes}`)
						.join("\n\n");
					throw new Error(`benchmark harness status=${status}\n${failed}`);
				});
			}
		});
		cy.get("#results").invoke("text").then(text => {
			const results = JSON.parse(text);
			cy.writeFile("tests/.artifacts/opfs-bench-dev-results.json", results);

			expect(results).to.have.length(14);

			for(const result of results) {
				expect(result.inputSet).to.equal("dev-small");
				expect(result.fixtureSource).to.be.a("string");
				expect(result.passed).to.equal(true);
				expect(result.outputBytes).to.be.greaterThan(0);
				expect(result).to.have.property("totalMs");
				expect(result).to.have.property("postCommandMs");
				expect(result).to.have.property("stderrSummary");
			}

			const byCaseAndBackend = Object.fromEntries(
				results.map(result => [`${result.case}:${result.backend}`, result])
			);

			expect(byCaseAndBackend["minimap2-large-explicit-output:staged"]).to.exist;
			expect(byCaseAndBackend["minimap2-large-explicit-output:direct"]).to.exist;
			expect(byCaseAndBackend["samtools-view-large-explicit-output:staged"]).to.exist;
			expect(byCaseAndBackend["samtools-view-large-explicit-output:direct"]).to.exist;
			expect(byCaseAndBackend["samtools-fastq-large-explicit-output:staged"]).to.exist;
			expect(byCaseAndBackend["samtools-fastq-large-explicit-output:direct"]).to.exist;
			expect(byCaseAndBackend["samtools-sort-large-explicit-output:staged"]).to.exist;
			expect(byCaseAndBackend["samtools-sort-large-explicit-output:direct"]).to.exist;
			expect(byCaseAndBackend["samtools-index-large-sidecar:staged"]).to.exist;
			expect(byCaseAndBackend["samtools-index-large-sidecar:direct"]).to.exist;
			expect(byCaseAndBackend["samtools-faidx-large-sidecar:staged"]).to.exist;
			expect(byCaseAndBackend["samtools-faidx-large-sidecar:direct"]).to.exist;
			expect(byCaseAndBackend["samtools-opfs-roundtrip-large:staged"]).to.exist;
			expect(byCaseAndBackend["samtools-opfs-roundtrip-large:direct"]).to.exist;
		});
		cy.get("#summary").invoke("text").then(text => {
			const summary = JSON.parse(text);
			cy.writeFile("tests/.artifacts/opfs-bench-dev-summary.json", summary);
			expect(summary.totalCases).to.equal(14);
			expect(summary.passingCases).to.equal(14);
			expect(summary.comparisons["minimap2-large-explicit-output"]).to.exist;
			expect(summary.comparisons["samtools-sort-large-explicit-output"]).to.exist;
			expect(summary.byCase["samtools-index-large-sidecar"].staged.fixtureSource).to.be.a("string");
			expect(summary.comparisons["minimap2-large-explicit-output"].thresholdEvaluation).to.exist;
			expect(summary.comparisons["samtools-sort-large-explicit-output"].thresholdEvaluation).to.exist;
			expect(summary.comparisons["samtools-sort-large-explicit-output"].thresholdEvaluation).to.have.property("directPostCommandWithinLimit");
			expect(summary.comparisons["samtools-sort-large-explicit-output"].thresholdStatus).to.exist;
			expect(summary.thresholdOverview.totalComparedCases).to.equal(7);
			expect(summary.thresholdOverview.directThresholdChecks).to.have.property("jsHeapWithinLimit");
		});
		cy.get("#run-metadata").invoke("text").then(text => {
			const metadata = JSON.parse(text);
			cy.writeFile("tests/.artifacts/opfs-bench-dev-metadata.json", metadata);
			expect(metadata.runLabel).to.equal("opfs-bench-dev");
			expect(metadata.status).to.equal("PASS");
			expect(metadata.totalCases).to.equal(14);
			expect(metadata.passingCases).to.equal(14);
			expect(metadata.startedAt).to.be.a("string");
			expect(metadata.finishedAt).to.be.a("string");
			expect(metadata.userAgent).to.be.a("string");
		});
		cy.get("#errors").should("have.text", "");
	});
});
