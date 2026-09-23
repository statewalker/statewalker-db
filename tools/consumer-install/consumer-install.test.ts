import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  {
    name: "@statewalker/db-duckdb-browser",
    dir: "db-duckdb-browser",
    subpaths: ["."],
    browserOnly: ["."],
  },
  {
    name: "@statewalker/db-sqlite-browser",
    dir: "db-sqlite-browser",
    subpaths: ["."],
    browserOnly: ["."],
  },
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
 * Every package under `packages/`, indexed by the name it publishes under.
 *
 * Built by reading the directory, deliberately NOT from `PACKAGES`: a workspace
 * sibling the harness does not target still has to be packed from the working
 * tree. If it is missing from the index, `pnpm pack` rewrites the target's
 * `workspace:*` on it to the sibling's local version and `npm install` then
 * fetches THAT version from the registry — so the harness certifies a blend of
 * working tree and registry, and 404s outright the moment a local version is
 * bumped ahead of what is published.
 */
function workspacePackages(): Map<string, ConsumerTarget> {
  const listed = new Map(PACKAGES.map((p) => [p.name, p]));
  const index = new Map<string, ConsumerTarget>();
  for (const entry of readdirSync(join(REPO, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(REPO, "packages", entry.name, "package.json");
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof name !== "string") continue;
    // A targeted package keeps its PACKAGES entry (browserOnly and friends);
    // an untargeted sibling gets a pack-only entry with no subpaths to probe.
    index.set(name, listed.get(name) ?? { name, dir: entry.name, subpaths: [] });
  }
  return index;
}

/**
 * The target plus every package in `packages/` it depends on, transitively — so the
 * install below never has to reach the npm registry for a workspace sibling that only
 * exists, fixed, in this working tree.
 */
function workspaceClosure(target: ConsumerTarget): ConsumerTarget[] {
  const byName = workspacePackages();
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

/**
 * Every string leaf of an `exports` map, paired with the subpath and the condition
 * chain it sits under. Conditions nest arbitrarily and arrays are fallback lists, so
 * this walks rather than reading one level.
 */
export function exportLeaves(
  exportsField: unknown,
): { subpath: string; condition: string; target: string }[] {
  const leaves: { subpath: string; condition: string; target: string }[] = [];
  const walk = (node: unknown, subpath: string, condition: string) => {
    if (typeof node === "string") {
      leaves.push({ subpath, condition, target: node });
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, subpath, condition);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key.startsWith(".")) walk(value, key, condition);
      else walk(value, subpath, condition === "" ? key : `${condition}.${key}`);
    }
  };
  walk(exportsField, ".", "");
  return leaves;
}

/**
 * Assert that every file the INSTALLED exports map names is actually in the installed
 * package, and that no resolvable condition names raw TypeScript.
 *
 * This is the only coverage a `browserOnly` package gets — its import probe never runs —
 * so it has to be real. Without it, reverting such a package's `exports["."]` back to
 * `./src/index.ts` leaves the whole suite green, which is the exact defect class this
 * harness exists to catch.
 */
function assertExportsResolve(target: ConsumerTarget, installed: string): void {
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  const leaves = exportLeaves(manifest.exports ?? { ".": manifest.main ?? "./index.js" });
  expect(leaves.length, `${target.name} publishes no exports targets at all`).toBeGreaterThan(0);

  for (const leaf of leaves) {
    const where = `${target.name} exports["${leaf.subpath}"]${leaf.condition ? `.${leaf.condition}` : ""} -> ${leaf.target}`;
    // A bare specifier is a redirect to another package, not a file in this one.
    if (!leaf.target.startsWith("./")) continue;

    expect(
      existsSync(join(installed, leaf.target)),
      `${where}: the published tarball does not ship that file`,
    ).toBe(true);

    // "source" is a bundler hint that no runtime ever resolves, so it may legitimately
    // name src/. Every other condition is resolvable, and a resolvable condition naming
    // raw TypeScript is un-importable by any non-bundler consumer — the original defect.
    if (leaf.condition.split(".").includes("source")) continue;
    const isDeclaration = /\.d\.[cm]?ts$/.test(leaf.target);
    const namesTypeScript = /\.[cm]?tsx?$/.test(leaf.target) && !isDeclaration;
    expect(
      namesTypeScript,
      `${where}: a resolvable export condition must name built output, not raw TypeScript`,
    ).toBe(false);
  }
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
  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify({ name: "c", type: "module", private: true }),
  );
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
  it("subpaths match the package's exports map", () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO, "packages", target.dir, "package.json"), "utf8"),
    );
    const declared = Object.keys(manifest.exports ?? { ".": {} }).filter(
      (k) => k !== "./package.json",
    );
    expect(new Set(target.subpaths)).toEqual(new Set(declared));
  });
});

describe.each(PACKAGES)("$name installs and imports as an external consumer", (target) => {
  it("packs, installs, and imports every export subpath", () => {
    const scratch = installFromTarball(target);
    const installed = join(scratch, "node_modules", ...target.name.split("/"));

    // (5) the tarball must actually ship dist/ — and every file its exports map names.
    expect(readdirSync(installed)).toContain("dist");
    assertExportsResolve(target, installed);

    const importable = target.subpaths.filter((s) => !target.browserOnly?.includes(s));
    for (const subpath of importable) {
      const specifier =
        subpath === "." ? target.name : `${target.name}/${subpath.replace(/^\.\//, "")}`;
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
      expect(
        result,
        `${specifier} must import${target.typesOnly ? "" : " and export something"}`,
      ).toContain("OK");
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
      const specifier =
        subpath === "." ? target.name : `${target.name}/${subpath.replace(/^\.\//, "")}`;
      const script = `import * as m from ${JSON.stringify(specifier)};
        console.log(JSON.stringify(Object.keys(m)));`;
      writeFileSync(join(scratch, "probe.mjs"), script);
      const result = execFileSync("node", ["probe.mjs"], { cwd: scratch, encoding: "utf8" });
      const keys = JSON.parse(result.trim().split("\n").at(-1) as string);
      expect(keys, `${specifier} is declared typesOnly but exports: ${keys.join(", ")}`).toEqual(
        [],
      );
    }
  });
});

/** (3) A catalog: dependency cannot be installed by npm at all. */
describe.each(PACKAGES)("$name installs cleanly alongside current peers", (target) => {
  it("has no unresolved workspace protocols in its published manifest", () => {
    const scratch = installFromTarball(target);
    // Read the installed manifest straight off disk: none of these packages' exports maps
    // whitelist "./package.json", so `require("<name>/package.json")` hits Node's own
    // ERR_PACKAGE_PATH_NOT_EXPORTED before this assertion ever runs.
    const manifest = JSON.parse(
      readFileSync(
        join(scratch, "node_modules", ...target.name.split("/"), "package.json"),
        "utf8",
      ),
    );
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        expect(String(range), `${target.name} ${field}.${dep}`).not.toMatch(
          /^(catalog:|workspace:)/,
        );
      }
    }
  });
});
