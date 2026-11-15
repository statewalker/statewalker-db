# @statewalker/db-sqlite-do

## 0.1.1

### Patch Changes

- c82d3d7: `newFakeDoStorage()` stores an empty BLOB as a BLOB, as Durable Object storage does. On Node 22, node:sqlite binds a view whose buffer has no backing store (`new Uint8Array(new ArrayBuffer(0))`, which the fake made of every empty ArrayBuffer) as NULL, so an empty BLOB written through the fake read back as NULL: a format that tells "empty" from "absent" by NULL (webrun-files' sqlar marks a directory that way) saw an empty file as something else. The platform probe now checks this too (`emptyBlobIsBlob`), on the fake and in `test:do` on real DO SQLite.
- Updated dependencies
  - @statewalker/db-api@0.1.5

## 0.1.0

### Minor Changes

- 4bcd1a8: New package: `newDoSqliteDb(ctx.storage)`, a Db on Durable Object SQLite with `inTransaction` support, and `@statewalker/db-sqlite-do/fake`, a node:sqlite stand-in with the DO limits.

### Patch Changes

- Updated dependencies
- Updated dependencies [4f7f4c9]
  - @statewalker/db-api@0.1.4
  - @statewalker/db-sqlite@0.1.0
