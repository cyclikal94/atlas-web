// A private fixture preview server for the profiling launchers: the vite preview of `dist-fixture` on a free loopback port, started in a
// process group of its own and stopped by that group's id (a `pnpm exec` wrapper and the vite process under it), never by name, so no
// other agent's server is touched.
import { spawn } from "node:child_process";
import { freePort } from "../integration/free-port.mjs";

export async function withFixtureServer(root, run) {
  const port = await freePort();
  const server = spawn(
    "pnpm",
    [
      "exec",
      "vite",
      "preview",
      "--mode",
      "fixture",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: root, stdio: "ignore", detached: true },
  );
  try {
    for (let i = 0; i < 100; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/__data`);
        if (response.ok) break;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
  }
}
