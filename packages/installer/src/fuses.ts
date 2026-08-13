import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";

const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
const embeddedAsarIntegrityValidationIndex = 4;
const fuseState = {
  off: 0x30,
  on: 0x31,
  removed: 0x32,
  inherit: 0x33,
} as const;

type FuseValue = keyof typeof fuseState;

export interface ElectronFuseSnapshot {
  schemaVersion: number;
  values: FuseValue[];
  offset: number;
}

export function readElectronFuses(binaryPath: string): ElectronFuseSnapshot {
  const binary = readFileSync(binaryPath);
  const sentinelOffset = binary.indexOf(sentinel);
  if (sentinelOffset < 0) throw new Error(`Electron fuse sentinel is missing: ${binaryPath}`);

  const headerOffset = sentinelOffset + sentinel.length;
  const schemaVersion = binary[headerOffset];
  const count = binary[headerOffset + 1];
  if (schemaVersion !== 1) throw new Error(`Unsupported Electron fuse schema: ${schemaVersion}`);
  if (count < 1 || count > 32) throw new Error(`Invalid Electron fuse count: ${count}`);

  const offset = headerOffset + 2;
  const values = Array.from(binary.subarray(offset, offset + count), decodeFuseValue);
  return { schemaVersion, values, offset };
}

export function isEmbeddedAsarIntegrityValidationDisabled(binaryPath: string): boolean {
  return readElectronFuses(binaryPath).values[embeddedAsarIntegrityValidationIndex] === "off";
}

export function disableEmbeddedAsarIntegrityValidation(
  binaryPath: string,
): { from: FuseValue; to: "off" } {
  const snapshot = readElectronFuses(binaryPath);
  if (embeddedAsarIntegrityValidationIndex >= snapshot.values.length) {
    throw new Error("Electron embedded ASAR integrity fuse is missing");
  }
  const from = snapshot.values[embeddedAsarIntegrityValidationIndex];
  if (from === "off") return { from, to: "off" };
  if (from === "removed") throw new Error("Electron embedded ASAR integrity fuse was removed");

  const file = openSync(binaryPath, "r+");
  try {
    writeSync(
      file,
      Buffer.from([fuseState.off]),
      0,
      1,
      snapshot.offset + embeddedAsarIntegrityValidationIndex,
    );
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  if (!isEmbeddedAsarIntegrityValidationDisabled(binaryPath)) {
    throw new Error("Electron embedded ASAR integrity fuse change could not be verified");
  }
  return { from, to: "off" };
}

function decodeFuseValue(value: number): FuseValue {
  for (const [name, byte] of Object.entries(fuseState)) {
    if (byte === value) return name as FuseValue;
  }
  throw new Error(`Unknown Electron fuse byte: 0x${value.toString(16)}`);
}
