import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

export type ConsumerTarget = {
  /** Published package name. */
  name: string;
  /** Directory under packages/ holding it. */
  dir: string;
  /** Export subpaths to import. "." is the root entry. */
  subpaths: string[];
  /** Subpaths that legitimately cannot import under Node (browser-only). */
  browserOnly?: string[];
  /** Deliberately types-only: it imports cleanly but exports nothing at runtime
   *  (tsdown emits `export {}`). The import MUST still run — that is the defect
   *  class this harness catches — only the non-empty assertion is skipped. */
  typesOnly?: boolean;
};

export const PACKAGES: ConsumerTarget[] = [
  {
    name: "@statewalker/db-api",
    dir: "db-api",
    subpaths: ["."],
    // db-api is a deliberate types-only interface package (see its README —
    // "import type { DbClient }"); src/index.ts contains only `export type`
    // declarations, so tsdown correctly emits `export {}` at runtime. It CAN be
    // imported under Node — that must keep being verified — it just has no
    // runtime exports to assert non-empty.
    typesOnly: true,
  },
  { name: "@statewalker/db-duckdb-node", dir: "db-duckdb-node", subpaths: ["."] },
  { name: "@statewalker/db-sqlite-node", dir: "db-sqlite-node", subpaths: ["."] },
  { name: "@statewalker/db-duckdb-browser", dir: "db-duckdb-browser", subpaths: ["."], browserOnly: ["."] },
  { name: "@statewalker/db-sqlite-browser", dir: "db-sqlite-browser", subpaths: ["."], browserOnly: ["."] },
];

const REPO = resolve(import.meta.dirname, "../..");
const scratches: string[] = [];

afterAll(() => {
  for (const s of scratches) rmSync(s, { recursive: true, force: true });
});

/** Names this repo's own dependencies (direct + peer) a package's package.json declares. */
function ownWorkspaceDeps(dir: string): string[] {
  const pkgPath = join(REPO, "packages", dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
}

/**
 * The target plus every package in `packages/` it depends on, transitively — so the
 * install below never has to reach the npm registry for a workspace sibling that only
 * exists, fixed, in this working tree.
 */
function workspaceClosure(target: ConsumerTarget): ConsumerTarget[] {
  const byName = new Map(PACKAGES.map((p) => [p.name, p]));
  const closure = new Map<string, ConsumerTarget>();
  const stack: ConsumerTarget[] = [target];
  while (stack.length > 0) {
    const t = stack.pop() as ConsumerTarget;
    if (closure.has(t.name)) continue;
    closure.set(t.name, t);
    for (const depName of ownWorkspaceDeps(t.dir)) {
      const dep = byName.get(depName);
      if (dep) stack.push(dep);
    }
  }
  return [...closure.values()];
}

function packOne(target: ConsumerTarget): string {
  const pkgDir = join(REPO, "packages", target.dir);
  const out = execFileSync("pnpm", ["pack", "--pack-destination", pkgDir], {
    cwd: pkgDir,
    encoding: "utf8",
  });
  return resolve(pkgDir, out.trim().split("\n").at(-1) as string);
}

/**
 * Pack the target and its transitive workspace-dependency closure, then install every
 * tarball together in one `npm install`. Installing the closure's tarballs alongside the
 * target is what lets npm satisfy a workspace sibling from the working tree instead of
 * fetching whatever is currently published on the registry.
 */
function installFromTarball(target: ConsumerTarget): string {
  const closure = workspaceClosure(target);
  const tarballs = closure.map(packOne);

  const scratch = mkdtempSync(join(tmpdir(), "consumer-"));
  scratches.push(scratch);
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "c", type: "module", private: true }));
  try {
    execFileSync("npm", ["install", "--no-audit", "--no-fund", ...tarballs], {
      cwd: scratch,
      encoding: "utf8",
    });
  } finally {
    for (const tarball of tarballs) rmSync(tarball, { force: true });
  }
  return scratch;
}

/** (1) Every subpath an exports map declares must be listed and tested. */
describe.each(PACKAGES)("$name declares every exports subpath to the harness", (target) => {
  it("subpaths match the package's exports map", async () => {
    const manifest = await import(
      join(REPO, "packages", target.dir, "package.json"),
      { with: { type: "json" } }
    );
    const declared = Object.keys(manifest.default.exports ?? { ".": {} })
      .filter((k) => k !== "./package.json");
    expect(new Set(target.subpaths)).toEqual(new Set(declared));
  });
});

describe.each(PACKAGES)("$name installs and imports as an external consumer", (target) => {
  it("packs, installs, and imports every export subpath", () => {
    const scratch = installFromTarball(target);

    // (5) the tarball must actually ship dist/
    const installed = join(scratch, "node_modules", ...target.name.split("/"));
    expect(readdirSync(installed)).toContain("dist");

    const importable = target.subpaths.filter((s) => !target.browserOnly?.includes(s));
    for (const subpath of importable) {
      const specifier = subpath === "." ? target.name : `${target.name}/${subpath.replace(/^\.\//, "")}`;
      // typesOnly still MUST import successfully — that is the defect class this
      // harness exists to catch — it just does not have to export anything.
      const script = target.typesOnly
        ? `import * as m from ${JSON.stringify(specifier)};
        console.log("OK");`
        : `import * as m from ${JSON.stringify(specifier)};
        if (Object.keys(m).length === 0) { console.error("EMPTY"); process.exit(2); }
        console.log("OK");`;
      writeFileSync(join(scratch, "probe.mjs"), script);
      const result = execFileSync("node", ["probe.mjs"], { cwd: scratch, encoding: "utf8" });
      expect(result, `${specifier} must import${target.typesOnly ? "" : " and export something"}`).toContain("OK");
    }
  });

  // (2) an exclusion list that excludes nothing is dead code
  it("browserOnly, if declared, names a subpath that exists", () => {
    for (const s of target.browserOnly ?? []) {
      expect(target.subpaths, `browserOnly "${s}" is not in subpaths`).toContain(s);
    }
  });

  // (6) typesOnly is self-policing: if the package ever starts shipping runtime
  // exports, this catches the stale flag instead of letting it silently hide a
  // regression in the non-empty assertion above.
  it("typesOnly, if declared, genuinely exports nothing", () => {
    if (!target.typesOnly) return;
    const scratch = installFromTarball(target);
    const importable = target.subpaths.filter((s) => !target.browserOnly?.includes(s));
    for (const subpath of importable) {
      const specifier = subpath === "." ? target.name : `${target.name}/${subpath.replace(/^\.\//, "")}`;
      const script = `import * as m from ${JSON.stringify(specifier)};
        console.log(JSON.stringify(Object.keys(m)));`;
      writeFileSync(join(scratch, "probe.mjs"), script);
      const result = execFileSync("node", ["probe.mjs"], { cwd: scratch, encoding: "utf8" });
      const keys = JSON.parse(result.trim().split("\n").at(-1) as string);
      expect(keys, `${specifier} is declared typesOnly but exports: ${keys.join(", ")}`).toEqual([]);
    }
  });
});

/** (3) A catalog: dependency cannot be installed by npm at all. */
/** (4) A peer range that excludes the current release fails at install. */
describe.each(PACKAGES)("$name installs cleanly alongside current peers", (target) => {
  it("has no unresolved workspace protocols in its published manifest", () => {
    const scratch = installFromTarball(target);
    // Read the installed manifest straight off disk: none of these packages' exports maps
    // whitelist "./package.json", so `require("<name>/package.json")` hits Node's own
    // ERR_PACKAGE_PATH_NOT_EXPORTED before this assertion ever runs.
    const manifest = JSON.parse(
      readFileSync(join(scratch, "node_modules", ...target.name.split("/"), "package.json"), "utf8"),
    );
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        expect(String(range), `${target.name} ${field}.${dep}`).not.toMatch(/^(catalog:|workspace:)/);
      }
    }
  });

  it("resolves against the current @statewalker/webrun-files release", () => {
    const peers = Object.keys(
      JSON.parse(
        execFileSync("node", ["-p", `JSON.stringify(require("./packages/${target.dir}/package.json").peerDependencies ?? {})`], {
          cwd: REPO, encoding: "utf8",
        }),
      ),
    );
    if (!peers.includes("@statewalker/webrun-files")) return; // not applicable
    const scratch = installFromTarball(target);
    // Installing the CURRENT files release must not ERESOLVE.
    expect(() =>
      execFileSync("npm", ["install", "--no-audit", "--no-fund", "@statewalker/webrun-files@latest"], {
        cwd: scratch, encoding: "utf8", stdio: "pipe",
      }),
    ).not.toThrow();
  });
});
