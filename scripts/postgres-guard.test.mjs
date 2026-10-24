import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../infra/postgres-guard.sh", import.meta.url),
);

test("database disk guard permits headroom and refuses data growth or exhausted host space", () => {
  const directory = mkdtempSync(join(tmpdir(), "refref-disk-guard-"));
  const check = (maximum, minimum) =>
    spawnSync("sh", [script, "--check"], {
      env: {
        ...process.env,
        PGDATA: directory,
        REFREF_DATA_MAX_KIB: String(maximum),
        REFREF_MIN_FREE_KIB: String(minimum),
      },
      encoding: "utf8",
    });
  try {
    assert.equal(check(1024, 1).status, 0);
    writeFileSync(join(directory, "data"), Buffer.alloc(16 * 1024, 1));
    assert.equal(check(1, 1).status, 78);
    assert.equal(check(1024, Number.MAX_SAFE_INTEGER).status, 78);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
