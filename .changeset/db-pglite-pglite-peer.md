---
"@statewalker/db-pglite": minor
---

`@electric-sql/pglite` is now a peer dependency (`^0.5.15`) instead of a regular dependency, so
the driver and the extensions you pass (such as `@electric-sql/pglite-pgvector`) share one PGlite
instead of installing two copies. Breaking for consumers (a minor bump on this 0.x line): install
`@electric-sql/pglite` yourself, at the version your extensions are built for.
