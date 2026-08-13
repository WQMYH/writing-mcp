# ADR 0002: JSZip for local EPUB container parsing

- Status: Accepted
- Date: 2026-08-13

## Decision

Use JSZip 3.x to read local EPUB ZIP containers, then deterministically parse `META-INF/container.xml`, the OPF manifest and spine. Writing MCP selects JSZip's MIT license option; its installed license file states the package is dual-licensed under MIT or GPLv3.

v1 supports unencrypted EPUB files only. It rejects corrupt ZIPs, missing container metadata, missing OPF packages and packages with no readable spine documents. It does not attempt DRM removal, remote resources, layout reconstruction or semantic HTML interpretation.

## Consequences

- The dependency is pure JavaScript and works in the chosen Node runtime without a native build toolchain.
- EPUB evidence uses `<epub-relative-path>#<spine-entry-path>` because source line numbers are not stable inside compressed XHTML resources.
- Namespace-heavy metadata, footnotes and malformed-but-recoverable publications require later fixtures before support can be claimed.
