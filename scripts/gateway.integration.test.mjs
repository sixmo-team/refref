import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const image =
  process.env.TEST_NGINX_IMAGE ??
  "nginx:stable-alpine@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5";

test(
  "cold static loading neither fails nor consumes the protected-route quota",
  { timeout: 30000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "refref-gateway-"));
    const name = `refref-gateway-test-${randomUUID()}`;
    const docker = (args) =>
      spawnSync("docker", args, { encoding: "utf8", timeout: 10000 });
    const upstream = createServer((_request, response) => response.end("ok"));
    try {
      chmodSync(directory, 0o755);
      const socket = join(directory, "upstream.sock");
      await new Promise((resolve) => upstream.listen(socket, resolve));
      chmodSync(socket, 0o666);
      const config = readFileSync(
        new URL("../infra/nginx.conf", import.meta.url),
        "utf8",
      ).replaceAll(
        /server (?:webapp:3000|api:3001|refer:3002);/g,
        "server unix:/fixture/upstream.sock;",
      );
      writeFileSync(join(directory, "nginx.conf"), config, { mode: 0o644 });
      writeFileSync(join(directory, "widget.v1.js"), "void 0;", {
        mode: 0o644,
      });
      const started = docker([
        "run",
        "-d",
        "--pull=never",
        "--name",
        name,
        "--publish",
        "127.0.0.1::8080",
        "--user",
        "nginx",
        "--memory=64m",
        "--memory-swap=64m",
        "--cpus=0.25",
        "--pids-limit=32",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--tmpfs",
        "/tmp:rw,size=16m",
        "--mount",
        `type=bind,src=${directory},dst=/fixture,readonly`,
        "--mount",
        `type=bind,src=${join(directory, "nginx.conf")},dst=/etc/nginx/nginx.conf,readonly`,
        "--mount",
        `type=bind,src=${join(directory, "widget.v1.js")},dst=/srv/assets/widget.v1.js,readonly`,
        "--entrypoint",
        "nginx",
        image,
        "-g",
        "daemon off;",
      ]);
      assert.equal(started.status, 0, started.stderr);
      const port = docker(["port", name, "8080/tcp"]);
      assert.equal(port.status, 0, port.stderr);
      assert.match(port.stdout.trim(), /^127\.0\.0\.1:\d+$/);
      const origin = `http://${port.stdout.trim()}`;
      const get = async (path) => {
        const response = await fetch(`${origin}${path}`, {
          signal: AbortSignal.timeout(2000),
        });
        await response.arrayBuffer();
        return response.status;
      };
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          if ((await get("/healthz")) === 200) break;
        } catch {
          /* startup only */
        }
        assert.ok(Date.now() < deadline, "native gateway did not become ready");
        await delay(25);
      }
      const burst = async (path, count) => {
        const statuses = [];
        let next = 0;
        await Promise.all(
          Array.from({ length: 4 }, async () => {
            while (next < count) statuses.push(await get(path(next++)));
          }),
        );
        return statuses;
      };
      assert.deepEqual(
        new Set(await burst((i) => `/_next/static/chunks/cold-${i}.js`, 80)),
        new Set([200]),
      );
      assert.deepEqual(
        new Set(await burst(() => "/assets/widget.v1.js", 12)),
        new Set([200]),
      );
      assert.equal(await get("/api/auth/get-session"), 200);
      const protectedBurst = await burst(() => "/api/auth/get-session", 80);
      assert.ok(
        protectedBurst.includes(200),
        "ordinary protected requests must remain usable",
      );
      assert.ok(
        protectedBurst.includes(429),
        "protected requests must retain their rate limit",
      );
    } finally {
      docker(["rm", "--force", name]);
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
