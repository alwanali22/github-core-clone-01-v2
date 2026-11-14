import { createApp } from "./app.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl || envUrl.trim() === "") {
    console.error("MAKEFUN_ENV_URL is not set or empty");
    process.exit(1);
  }
  const baseUrl = envUrl.replace(/\/+$/, "");

  const server = createApp();

  server.on("error", (err: Error) => {
    console.error("Server error:", err);
    process.exit(1);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, () => {
      resolve();
    });
    server.once("error", reject);
  });

  const addr = server.address();
  if (!addr || typeof addr === "string" || typeof addr.port !== "number") {
    console.error("Invalid server address:", addr);
    process.exit(1);
  }

  const port = addr.port;
  console.log(`listening port: ${port}`);

  let delay = 250;
  while (true) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const res = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.status === 200 || res.status === 409) {
        console.log(`registered: status ${res.status}`);
        break;
      }
      if (res.status === 400 || res.status === 405) {
        console.error(`Fatal contract error on register: ${res.status}`);
        process.exit(1);
      }
      console.warn(`Register status ${res.status}, retrying in ${delay}ms...`);
    } catch (err) {
      console.warn(`Register error: ${err}, retrying in ${delay}ms...`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }

  delay = 250;
  while (true) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const res = await fetch(`${baseUrl}/done`, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.status === 200) {
        const data = (await res.json()) as { done?: boolean };
        if (data && data.done === true) {
          console.log("done: true");
          break;
        }
        delay = 250;
        await sleep(500);
        continue;
      } else {
        console.warn(`Poll done status ${res.status}, retrying in ${delay}ms...`);
      }
    } catch (err) {
      console.warn(`Poll done error: ${err}, retrying in ${delay}ms...`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }

  server.closeAllConnections?.();
  server.close();
  console.log("server closed, exiting 0");
  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected fatal error:", err);
  process.exit(1);
});
