import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("admin config lock", () => {
  it("serializes concurrent config.json mutations across processes", async () => {
    const home = mkdtempSync(join(tmpdir(), "zhishi-config-lock-"));
    const configDir = join(home, ".zhishi");
    const configPath = join(configDir, "config.json");
    const adminConfigUrl = pathToFileURL(
      join(process.cwd(), "src/server/utils/admin-config.ts"),
    ).href;

    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ initial: true }, null, 2),
      "utf-8",
    );

    const runMutation = (key: string, value: string, holdMs: number) =>
      execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx/esm",
          "-e",
          `
          const { atomicModifyConfig } = await import(${JSON.stringify(adminConfigUrl)});
          await atomicModifyConfig(async (config) => {
            if (${holdMs} > 0) {
              await new Promise(r => setTimeout(r, ${holdMs}));
            }
            return { ...config, ${JSON.stringify(key)}: ${JSON.stringify(value)} };
          });
        `,
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
          },
        },
      );

    try {
      await Promise.all([
        runMutation("first", "a", 300),
        runMutation("second", "b", 0),
      ]);

      const finalConfig = JSON.parse(
        readFileSync(configPath, "utf-8"),
      ) as Record<string, unknown>;
      expect(finalConfig).toMatchObject({
        initial: true,
        first: "a",
        second: "b",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 10000);
});
