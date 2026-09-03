import { buildApp, type AppOptions } from "../src/app.js";
import { loadServerConfig, type ServerConfig } from "../src/config.js";
import type { PinInfo } from "../src/pins.js";
import { FakeLeanRunner } from "../src/runner-fake.js";

export const TOKEN = "test-token-0123456789";

export const NS = "Minerval.S0000a001_v1";

export const STATEMENT = `import Mathlib
set_option autoImplicit false
namespace ${NS}
/-- Statement 1 of claim 0000a001. The canonical form is in the correspondence note. -/
def Statement : Prop :=
  ∀ n : ℕ, n + 0 = n
end ${NS}
`;

export const VALID_PROOF = `theorem ${NS}.proof : ${NS}.Statement := by
  intro n
  exact Nat.add_zero n
`;

export function pins(over: Partial<PinInfo> = {}): PinInfo {
  return {
    pin_id: "mathlib-v4.33.0",
    lean_toolchain: "leanprover/lean4:v4.33.0",
    mathlib_rev: "0123456789abcdef0123456789abcdef01234567",
    mathlib_tag: "v4.33.0",
    image_digest: "sha256:test",
    checker_version: "0.1.0",
    ...over,
  };
}

export function config(over: Partial<ServerConfig> = {}, env: NodeJS.ProcessEnv = {}): ServerConfig {
  return {
    ...loadServerConfig({ LEAN_CHECKER_TOKEN: TOKEN, ...env }),
    ...over,
  };
}

export function app(over: Partial<AppOptions> = {}, configOver: Partial<ServerConfig> = {}) {
  const runner = over.runner ?? new FakeLeanRunner();
  const instance = buildApp({
    config: config(configOver),
    runner,
    pins: pins(),
    ...over,
  });
  return { app: instance, runner: runner as FakeLeanRunner };
}

export const auth = { authorization: `Bearer ${TOKEN}` };
