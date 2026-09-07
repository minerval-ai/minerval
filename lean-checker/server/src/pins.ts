/**
 * The pin record the image writes to /etc/minerval-lean-pin.json and every
 * response carries (design sections 5.3 and 5.5).
 *
 * The image digest cannot be known while the image is being built (it is a
 * digest of the finished image), so the file holds a placeholder and the
 * deployment passes the real digest in `LEAN_CHECKER_IMAGE_DIGEST`; when it
 * is absent the placeholder is reported as-is so the gap is visible rather
 * than hidden behind a made-up value.
 */
import { readFileSync } from "node:fs";

export interface PinInfo {
  pin_id: string;
  lean_toolchain: string;
  mathlib_rev: string;
  mathlib_tag: string | null;
  image_digest: string;
  checker_version: string;
}

export interface PinFile {
  pin_id: string;
  lean_toolchain: string;
  mathlib_rev: string;
  mathlib_tag?: string | null;
  image_digest_placeholder?: string;
  checker_version: string;
}

export function pinFromFile(file: PinFile, imageDigest?: string): PinInfo {
  return {
    pin_id: file.pin_id,
    lean_toolchain: file.lean_toolchain,
    mathlib_rev: file.mathlib_rev,
    mathlib_tag: file.mathlib_tag ?? null,
    image_digest: imageDigest && imageDigest.length > 0
      ? imageDigest
      : file.image_digest_placeholder ?? "unknown",
    checker_version: file.checker_version,
  };
}

export function loadPins(path: string, imageDigest?: string): PinInfo {
  const raw = JSON.parse(readFileSync(path, "utf8")) as PinFile;
  for (const key of ["pin_id", "lean_toolchain", "mathlib_rev", "checker_version"] as const) {
    if (typeof raw[key] !== "string" || raw[key].length === 0) {
      throw new Error(`pin file ${path} is missing ${key}`);
    }
  }
  return pinFromFile(raw, imageDigest);
}
