import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  chmodSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initEnvironment, runCommand } from "./dev.mjs";
import { setTimeout as delay } from "node:timers/promises";

test("reinitializing local development preserves credentials and refuses exposed secret files", () => {
  const directory = mkdtempSync(join(tmpdir(), "refref-credentials-"));
  try {
    initEnvironment(directory);
    const original = readFileSync(join(directory, "dev.env"), "utf8");
    const login = readFileSync(join(directory, "credentials.txt"), "utf8");
    assert.equal(statSync(join(directory, "dev.env")).mode & 0o777, 0o600);
    assert.equal(
      statSync(join(directory, "credentials.txt")).mode & 0o777,
      0o600,
    );
    initEnvironment(directory);
    assert.equal(readFileSync(join(directory, "dev.env"), "utf8"), original);
    assert.equal(
      readFileSync(join(directory, "credentials.txt"), "utf8"),
      login,
    );
    chmodSync(join(directory, "dev.env"), 0o644);
    assert.throws(() => initEnvironment(directory), /permissions/);
    assert.equal(readFileSync(join(directory, "dev.env"), "utf8"), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "aborting a command stops its process group, including descendants",
  { timeout: 10000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "refref-command-"));
    const ready = join(directory, "ready");
    const controller = new AbortController();
    let groupPid;
    const failures = [];
    try {
      const grandchild = `require('node:fs').writeFileSync(process.argv[1], JSON.stringify({pid: process.pid, groupPid: Number(process.argv[2])})); setTimeout(() => {}, 5000);`;
      const child = `require('node:child_process').spawn(process.execPath, ['--max-old-space-size=32', '-e', ${JSON.stringify(grandchild)}, process.argv[1], String(process.pid)], {stdio: 'ignore'}); setTimeout(() => {}, 5000);`;
      const pending = runCommand(
        process.execPath,
        ["--max-old-space-size=32", "-e", child, ready],
        controller.signal,
      );
      const readinessDeadline = Date.now() + 3000;
      while (!existsSync(ready) && Date.now() < readinessDeadline)
        await delay(20);
      const processIds = JSON.parse(readFileSync(ready, "utf8"));
      assert.ok(
        Number.isInteger(processIds.groupPid) &&
          processIds.groupPid > 1 &&
          processIds.groupPid !== process.pid,
      );
      assert.ok(
        Number.isInteger(processIds.pid) &&
          processIds.pid > 1 &&
          processIds.pid !== process.pid,
      );
      groupPid = processIds.groupPid;
      controller.abort();
      await assert.rejects(pending, /interrupted/);
      const deadline = Date.now() + 1000;
      let state;
      do {
        try {
          const stat = readFileSync(`/proc/${processIds.pid}/stat`, "utf8");
          state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          state = "gone";
        }
        if (state === "gone" || state === "Z") break;
        await delay(20);
      } while (Date.now() < deadline);
      assert.ok(
        state === "gone" || state === "Z",
        `descendant still running (${state})`,
      );
    } catch (error) {
      failures.push(error);
    } finally {
      controller.abort();
      if (groupPid) {
        try {
          process.kill(-groupPid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") failures.push(error);
        }
      }
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Command assertion and cleanup failed");
    }
  },
);
