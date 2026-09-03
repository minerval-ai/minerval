/**
 * Entry point. Reads configuration, refuses to start without a bearer
 * token, wires the real runner, and listens. In the cold lane the process
 * exits once its check has been fetched (or after the idle timeout), which
 * is what makes a `RunTask` task cost only what one check costs.
 */
import { buildApp } from "./app.js";
import { loadServerConfig } from "./config.js";
import { loadPins } from "./pins.js";
import { ProcessLeanRunner } from "./runner-process.js";

async function main(): Promise<void> {
  const config = loadServerConfig();
  const pins = loadPins(config.pinFile, config.imageDigest);
  const runner = new ProcessLeanRunner({
    projectDir: config.projectDir,
    workRoot: config.workRoot,
    checkerBin: config.checkerBin,
    replayTool: config.replayTool,
    killAfterS: config.killAfterS,
  });
  let closing = false;
  const app = buildApp({
    config,
    runner,
    pins,
    logger: true,
    onColdComplete: () => {
      if (closing) return;
      closing = true;
      app.log.info("cold lane: check fetched or idle; exiting");
      void app.close().then(() => process.exit(0));
    },
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      void app.close().then(() => process.exit(0));
    });
  }
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ lane: config.lane, pin: pins.pin_id, image_digest: pins.image_digest }, "lean-checker listening");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
