# Private corpus acceptance

Private source text and annotations stay outside this repository. The runner reads a local schema v2 annotation file, builds the normal derived index beside the authorized source, and prints only aggregate metrics and failed fact IDs. It never prints source text, evidence quotes, or absolute paths.

Run on PowerShell:

```powershell
$env:WRITING_MCP_PRIVATE_ACCEPTANCE='X:\private\annotations.json'
pnpm benchmark:private
```

Required annotation properties:

- root: `schemaVersion: 2`, `work.private: true`, `work.sourcePath`, and `facts`;
- fact: unique `id`, `category`, `question`, keyword `query`, non-empty `expectedTerms`, non-empty verbatim `evidenceQuotes`, `expectedChapters`, and `required`;
- chapter reference: `{ "volume": 1, "chapter": 2 }`, `{ "volume": 1, "from": 2, "to": 4 }`, or an array of those references.

The gating metrics are gold-span recall, required gold-span recall, evidence provenance coverage, initial indexing time, and warm-query P95. Verbatim quote exposure inside the bounded excerpt is reported separately so compression misses remain visible without being confused with retrieval misses.
