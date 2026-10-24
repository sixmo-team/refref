import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const local = join(root, ".local");
const nodeImage =
  "node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f";
const builder = "refref-dev-bounded";
const targets = ["database", "webapp", "api", "refer", "migrate", "gateway"];

function privateFile(path) {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(`Unsafe secret-file permissions: ${path}`);
  }
}

function environment(path) {
  privateFile(path);
  const result = Object.create(null);
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1 || !/^[A-Z][A-Z0-9_]*$/.test(line.slice(0, separator))) {
      throw new Error(`Invalid local environment format: ${path}`);
    }
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

export function initEnvironment(directory = local) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.uid !== process.getuid())
    throw new Error(
      "Local secrets directory must be owned by this user and cannot be a symlink",
    );
  chmodSync(directory, 0o700);
  const path = join(directory, "dev.env");
  if (!existsSync(path)) {
    const admin = randomBytes(32).toString("base64url");
    const migrator = randomBytes(32).toString("base64url");
    const app = randomBytes(32).toString("base64url");
    const values = {
      REFREF_IMAGE_TAG: "unbuilt",
      REFREF_ADMIN_PASSWORD: admin,
      REFREF_MIGRATOR_PASSWORD: migrator,
      REFREF_APP_PASSWORD: app,
      REFREF_MIGRATOR_DATABASE_URL: `postgresql://refref_migrator:${migrator}@database:5432/refref`,
      REFREF_RUNTIME_DATABASE_URL: `postgresql://refref_app:${app}@database:5432/refref`,
      BETTER_AUTH_SECRET: randomBytes(48).toString("base64url"),
      REFREF_DEV_EMAIL: `dev-${randomUUID()}@refref.invalid`,
      REFREF_DEV_PASSWORD: randomBytes(24).toString("base64url"),
    };
    writeFileSync(
      path,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
      { mode: 0o600, flag: "wx" },
    );
  }
  const values = environment(path);
  const credentials = join(directory, "credentials.txt");
  if (!existsSync(credentials)) {
    writeFileSync(
      credentials,
      `URL=http://127.0.0.1:4310\nEMAIL=${values.REFREF_DEV_EMAIL}\nPASSWORD=${values.REFREF_DEV_PASSWORD}\n`,
      { mode: 0o600, flag: "wx" },
    );
  }
  privateFile(credentials);
  const test = join(directory, "test.env");
  if (!existsSync(test)) {
    const password = randomBytes(32).toString("base64url");
    const url = `postgresql://refref_test:${password}@refref-test-db:5432/refref_test`;
    writeFileSync(
      test,
      `POSTGRES_PASSWORD=${password}\nTEST_DATABASE_URL=${url}\nDATABASE_URL=${url}\nBETTER_AUTH_SECRET=${randomBytes(48).toString("base64url")}\nBETTER_AUTH_URL=http://127.0.0.1:4310\nNEXT_PUBLIC_APP_URL=http://127.0.0.1:4310\n`,
      { mode: 0o600, flag: "wx" },
    );
  }
  privateFile(test);
}

function headroom(minimumMemoryMiB) {
  const available = /^MemAvailable:\s+(\d+) kB$/m.exec(
    readFileSync("/proc/meminfo", "utf8"),
  );
  if (!available || Number(available[1]) < minimumMemoryMiB * 1024)
    throw new Error(
      `Refusing operation: need at least ${minimumMemoryMiB} MiB available host RAM`,
    );
  const disk = statfsSync(root);
  if (disk.bavail * disk.bsize < 8 * 1024 ** 3)
    throw new Error(
      "Refusing operation: need at least 8 GiB available disk space",
    );
}

function command(binary, args, capture = false) {
  const result = spawnSync(binary, args, {
    cwd: root,
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${binary} failed (${result.status ?? result.signal})${capture ? `: ${result.stderr?.trim()}` : ""}`,
    );
  return result.stdout?.trim();
}

/** Abort the whole private process group, not just a CLI that may have plugin children. */
export function runCommand(binary, args, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Command interrupted"));
    const child = spawn(binary, args, {
      cwd: root,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    });
    let forceTimer;
    const kill = (name) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, name);
      } catch (error) {
        if (error.code !== "ESRCH") reject(error);
      }
    };
    const abort = () => {
      kill("SIGTERM");
      forceTimer = setTimeout(() => kill("SIGKILL"), 2000);
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      clearTimeout(forceTimer);
      reject(error);
    });
    child.once("close", (code, stoppedBy) => {
      signal?.removeEventListener("abort", abort);
      clearTimeout(forceTimer);
      if (signal?.aborted) {
        kill("SIGKILL");
        reject(new Error("Command interrupted"));
      } else if (code !== 0)
        reject(new Error(`${binary} failed (${code ?? stoppedBy})`));
      else resolve();
    });
  });
}

function compose(args, test = false) {
  command("docker", [
    "compose",
    "--env-file",
    join(local, test ? "test.env" : "dev.env"),
    "-f",
    test ? "compose.test.yml" : "docker-compose.yml",
    ...args,
  ]);
}

function bounded(args, network, memory = "1536m") {
  const cache = join(process.env.HOME, ".cache", "refref-build");
  mkdirSync(join(cache, "pnpm"), { recursive: true, mode: 0o700 });
  return command("docker", [
    "run",
    "--rm",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--network",
    network,
    "--memory",
    memory,
    "--memory-swap",
    memory,
    "--cpus",
    "1",
    "--pids-limit",
    "256",
    "--read-only",
    "--ulimit",
    "core=0:0",
    "--ulimit",
    "nofile=8192:8192",
    "--oom-score-adj",
    "500",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=128m,mode=1777",
    "--log-driver",
    "local",
    "--log-opt",
    "max-size=10m",
    "--log-opt",
    "max-file=2",
    "--mount",
    `type=bind,src=${root},dst=/workspace`,
    "--mount",
    `type=bind,src=${cache},dst=/cache`,
    "--mount",
    `type=bind,src=${join(cache, "pnpm")},dst=/pnpm-store`,
    "--workdir",
    "/workspace",
    "--tmpfs",
    `/workspace/.local:rw,noexec,nosuid,nodev,size=16m,uid=${process.getuid()},gid=${process.getgid()},mode=0700`,
    ...(network === "refref-test"
      ? ["--env-file", join(local, "test.env")]
      : []),
    "--env",
    "COREPACK_HOME=/cache/corepack",
    "--env",
    "COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
    "--env",
    "SWC_NATIVE_BINDING_CACHE=/cache/swc",
    "--env",
    "HOME=/tmp/home",
    "--env",
    `NODE_OPTIONS=--max-old-space-size=${memory === "2g" ? 1408 : memory === "768m" ? 512 : 1024}`,
    "--env",
    "NEXT_TELEMETRY_DISABLED=1",
    "--env",
    "TURBO_TELEMETRY_DISABLED=1",
    "--env",
    "DO_NOT_TRACK=1",
    nodeImage,
    ...args,
  ]);
}

async function main() {
  const [action = "help", ...args] = process.argv.slice(2);
  if (action === "init") {
    initEnvironment();
    console.log(
      "Private local configuration ready; existing secrets preserved. Login file: .local/credentials.txt",
    );
    return;
  }
  if (action === "help") {
    console.log(
      "Commands: init | prepare [--update] | audit [--prod] | testdb | run <command...> | build | up | bootstrap | down | status | logs",
    );
    return;
  }
  initEnvironment();
  if (action === "prepare") {
    headroom(3072);
    const update = args[0] === "--update";
    bounded(
      [
        "corepack",
        "pnpm",
        ...(update
          ? ["update", "-r", "--depth=100"]
          : ["install", "--frozen-lockfile"]),
        "--ignore-scripts",
        "--store-dir",
        "/pnpm-store",
        "--network-concurrency=4",
        "--config.child-concurrency=1",
      ],
      "bridge",
      "2g",
    );
  } else if (action === "audit") {
    headroom(1536);
    bounded(["corepack", "pnpm", "audit", "--json", ...args], "bridge", "768m");
  } else if (action === "testdb") {
    headroom(2304);
    compose(["down"], true);
    compose(["up", "-d", "--wait", "--wait-timeout", "60"], true);
    const journal = JSON.parse(
      readFileSync(
        join(root, "packages/coredb/drizzle/meta/_journal.json"),
        "utf8",
      ),
    );
    const sql = journal.entries
      .map(({ tag }) =>
        readFileSync(
          join(root, "packages/coredb/drizzle", `${tag}.sql`),
          "utf8",
        ),
      )
      .join("\n");
    const result = spawnSync(
      "docker",
      [
        "exec",
        "-i",
        "refref-test-db",
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "refref_test",
        "-d",
        "refref_test",
      ],
      { input: `BEGIN;\n${sql}\nCOMMIT;`, encoding: "utf8" },
    );
    if (result.status !== 0)
      throw new Error(
        `Disposable test schema initialization failed: ${result.stderr}`,
      );
    console.log(
      "Disposable refref_test schema initialized from versioned migrations.",
    );
  } else if (action === "run") {
    if (!args.length) throw new Error("run requires a command");
    headroom(2304);
    bounded(args, "refref-test");
  } else if (action === "build") {
    headroom(3072);
    const buildkitImage =
      "moby/buildkit@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea";
    const container = `buildx_buildkit_${builder}0`;
    const inspect = spawnSync("docker", ["buildx", "inspect", builder], {
      stdio: "pipe",
    });
    if (inspect.status !== 0) {
      command("docker", [
        "buildx",
        "create",
        "--name",
        builder,
        "--driver",
        "docker-container",
        "--driver-opt",
        `image=${buildkitImage}`,
        "--driver-opt",
        "restart-policy=no",
      ]);
    }
    const existing = spawnSync("docker", ["inspect", container], {
      encoding: "utf8",
    });
    if (existing.status === 0) {
      const details = JSON.parse(existing.stdout)[0];
      if (details.Config.Labels?.["org.refref.development"] !== "true")
        throw new Error("Refusing to alter an unowned builder container");
      if (details.State.Running)
        throw new Error(
          "Dedicated builder is already running; do not overlap builds",
        );
    } else {
      command("docker", [
        "create",
        "--name",
        container,
        "--init",
        "--privileged",
        "--restart",
        "no",
        "--memory",
        "2g",
        "--memory-swap",
        "2g",
        "--cpus",
        "1",
        "--pids-limit",
        "384",
        "--oom-score-adj",
        "500",
        "--ulimit",
        "core=0:0",
        "--ulimit",
        "nofile=8192:8192",
        "--log-driver",
        "local",
        "--log-opt",
        "max-size=10m",
        "--log-opt",
        "max-file=3",
        "--label",
        "org.refref.development=true",
        "--env",
        "BUILDKIT_STEP_LOG_MAX_SIZE=1048576",
        "--volume",
        `${container}_state:/var/lib/buildkit`,
        buildkitImage,
        "--config",
        "/tmp/refref-buildkitd.toml",
      ]);
    }
    command("docker", [
      "cp",
      "infra/buildkitd.toml",
      `${container}:/tmp/refref-buildkitd.toml`,
    ]);
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    try {
      await runCommand(
        "docker",
        ["buildx", "inspect", "--bootstrap", builder],
        controller.signal,
      );
      const limits = JSON.parse(
        command(
          "docker",
          ["inspect", "--format", "{{json .HostConfig}}", container],
          true,
        ),
      );
      if (
        limits.Memory !== 2 * 1024 ** 3 ||
        limits.MemorySwap !== limits.Memory ||
        limits.NanoCpus !== 1000000000 ||
        limits.PidsLimit !== 384 ||
        limits.OomScoreAdj !== 500 ||
        limits.LogConfig.Type !== "local" ||
        limits.LogConfig.Config["max-size"] !== "10m" ||
        limits.LogConfig.Config["max-file"] !== "3"
      )
        throw new Error("Builder hard limits/log rotation were not applied");
      const revision = command("git", ["rev-parse", "--short=8", "HEAD"], true);
      const tag = `${revision}-${Date.now().toString(36)}`;
      for (const target of targets) {
        headroom(3072);
        const [blocks, blockSize] = command(
          "docker",
          ["exec", container, "stat", "-f", "-c", "%a %S", "/var/lib/buildkit"],
          true,
        )
          .split(/\s+/)
          .map(Number);
        if (
          !Number.isFinite(blocks * blockSize) ||
          blocks * blockSize < 8 * 1024 ** 3
        )
          throw new Error(
            "Refusing build: Docker storage needs at least 8 GiB free",
          );
        await runCommand(
          "docker",
          [
            "buildx",
            "build",
            "--builder",
            builder,
            "--load",
            "--provenance=false",
            "--target",
            target,
            "--ulimit",
            "core=0:0",
            "--ulimit",
            "nofile=8192:8192",
            "--tag",
            `local/refref-${target}:${tag}`,
            "--label",
            `org.opencontainers.image.revision=${revision}`,
            "--label",
            "org.refref.development=true",
            ".",
          ],
          controller.signal,
        );
      }
      const path = join(local, "dev.env");
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(
          /^REFREF_IMAGE_TAG=.*$/m,
          `REFREF_IMAGE_TAG=${tag}`,
        ),
        { mode: 0o600 },
      );
    } finally {
      try {
        await runCommand("docker", ["buildx", "stop", builder]);
      } finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
      }
    }
  } else if (action === "up") {
    headroom(2048);
    const values = environment(join(local, "dev.env"));
    for (const target of targets)
      command(
        "docker",
        [
          "image",
          "inspect",
          `local/refref-${target}:${values.REFREF_IMAGE_TAG}`,
          "--format",
          "{{.Id}}",
        ],
        true,
      );
    compose(["config", "--quiet"]);
    compose(["up", "-d", "--wait", "--wait-timeout", "60", "database"]);
    compose(["run", "--rm", "--no-deps", "migrate"]);
    compose([
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "120",
      "webapp",
      "api",
      "refer",
      "gateway",
    ]);
  } else if (action === "bootstrap") {
    headroom(1024);
    compose(["run", "--rm", "--no-deps", "bootstrap"]);
  } else if (action === "down") {
    compose(["down"]);
  } else if (action === "status") {
    compose(["ps"]);
  } else if (action === "logs") {
    compose(["logs", "--tail", "100"]);
  } else {
    throw new Error(`Unknown command: ${action}`);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
