# OPFS benchmark development fixtures

This directory seeds the filenames needed by the OPFS benchmark harnesses.

Files present now:

- `large-ref.fa`
- `large-reads.fq`
- `large-ref-indexable.fa`
- `large-unsorted.sam`
- `large-sorted.sam`
- `large-unsorted.bam`
- `large-sorted.bam`

Notes:

- The `.fa`, `.fq`, and `.sam` files are tiny valid development fixtures.
- The `.bam` files are placeholders only. Replace them with valid BAM files before running real `samtools view`, `sort`, `fastq`, or `index` benchmarks.
- The `.sam` sources are included so valid BAMs can be generated externally later without inventing a schema from scratch.

## Replacing with larger files

Keep the filenames unchanged and replace the contents in place:

- `large-ref.fa`
- `large-reads.fq`
- `large-ref-indexable.fa`
- `large-unsorted.bam`
- `large-sorted.bam`

Recommended workflow:

1. Keep the existing filenames.
2. Replace the tiny development files with your larger real files.
3. Rerun:
   - the browser harness at `/src/examples/opfs-bench-dev.html`
   - or `tests/test_opfs_bench_dev.cy.js`

The benchmark JSON includes a `fixtureSource` field so you can tell whether a case used:

- `dev-seeded`
- `generated-from-dev-sam`
- or a later real-file workflow once the harness is expanded for larger external inputs
