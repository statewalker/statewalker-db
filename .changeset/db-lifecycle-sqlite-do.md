---
"@statewalker/db-sqlite-do": patch
---

README: the real-DO conformance run skips the `runDbConformance` scenarios its HTTP/JSON harness cannot carry (call order, close during a call, BLOB and bigint round trips); they run on the fake.
