import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const image =
  "postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea";
const guard = fileURLToPath(
  new URL("../infra/postgres-guard.sh", import.meta.url),
);

test("disk guard stops PostgreSQL even while its first initialization script is running", () => {
  const directory = mkdtempSync(join(tmpdir(), "refref-guard-init-"));
  const name = `refref-guard-init-${randomUUID()}`;
  const docker = (args, timeout = 10000) =>
    spawnSync("docker", args, { encoding: "utf8", timeout });
  try {
    const sql = join(directory, "slow.sql");
    writeFileSync(sql, "SELECT pg_sleep(60);\n", { mode: 0o644 });
    const started = docker([
      "run",
      "-d",
      "--pull=never",
      "--name",
      name,
      "--network",
      "none",
      "--user",
      "postgres",
      "--memory",
      "256m",
      "--memory-swap",
      "256m",
      "--cpus",
      "0.5",
      "--pids-limit",
      "64",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--log-driver",
      "local",
      "--log-opt",
      "max-size=1m",
      "--log-opt",
      "max-file=2",
      "--tmpfs",
      "/var/lib/postgresql/data:rw,size=160m,uid=70,gid=70",
      "--tmpfs",
      "/var/run/postgresql:rw,size=4m,uid=70,gid=70",
      "--tmpfs",
      "/tmp:rw,size=8m",
      "--mount",
      `type=bind,src=${guard},dst=/guard,readonly`,
      "--mount",
      `type=bind,src=${sql},dst=/docker-entrypoint-initdb.d/slow.sql,readonly`,
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "--env",
      "REFREF_DATA_MAX_KIB=1",
      "--env",
      "REFREF_MIN_FREE_KIB=1",
      "--health-cmd",
      "pg_isready -U postgres",
      "--health-interval",
      "1s",
      "--health-timeout",
      "1s",
      "--health-retries",
      "30",
      "--entrypoint",
      "/bin/sh",
      image,
      "/guard",
      "postgres",
      "-c",
      "shared_buffers=16MB",
      "-c",
      "max_connections=10",
    ]);
    assert.equal(started.status, 0, started.stderr);
    const waited = docker(["wait", name], 30000);
    assert.equal(waited.status, 0, String(waited.error ?? waited.stderr));
    const state = JSON.parse(
      docker(["inspect", "--format", "{{json .State}}", name]).stdout,
    );
    assert.equal(state.Running, false);
    assert.equal(state.ExitCode, 0);
    assert.equal(
      state.Health.Log.some((entry) => entry.ExitCode === 0),
      true,
      "PostgreSQL must have actually started during initialization",
    );
  } finally {
    docker(["rm", "--force", name]);
    rmSync(directory, { recursive: true, force: true });
  }
});
