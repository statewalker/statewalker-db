---
"@statewalker/db-sqlite-do": patch
---

`newFakeDoStorage()` stores an empty BLOB as a BLOB, as Durable Object storage does. On Node 22, node:sqlite binds a view whose buffer has no backing store (`new Uint8Array(new ArrayBuffer(0))`, which the fake made of every empty ArrayBuffer) as NULL, so an empty BLOB written through the fake read back as NULL: a format that tells "empty" from "absent" by NULL (webrun-files' sqlar marks a directory that way) saw an empty file as something else. The platform probe now checks this too (`emptyBlobIsBlob`), on the fake and in `test:do` on real DO SQLite.
