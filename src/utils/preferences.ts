import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logWarning } from "./log.js";
import { getExtmgrCacheDir } from "./pi-paths.js";

function preferencesFile(): string {
  return join(getExtmgrCacheDir(), "preferences.json");
}

async function readPreferences(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("Invalid extmgr preferences JSON.", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid extmgr preferences: expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

let preferenceRevision = 0;

export async function getShowFooterStatus(onReadError?: () => void): Promise<boolean> {
  try {
    const file = preferencesFile();
    for (;;) {
      const revision = preferenceRevision;
      const preferences = await readPreferences(file);
      // Save may replace the file while this read still holds the old contents.
      if (revision === preferenceRevision) return preferences.showFooterStatus !== false;
    }
  } catch {
    if (onReadError) onReadError();
    else logWarning("Cannot read extmgr preferences; keeping footer status visible.");
    return true;
  }
}

let preferenceWrites: Promise<void> = Promise.resolve();

export function setShowFooterStatus(visible: boolean): Promise<void> {
  const file = preferencesFile();
  const write = preferenceWrites.then(async () => {
    const preferences = await readPreferences(file);
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ ...preferences, showFooterStatus: visible }, null, 2)}\n`,
        { mode: 0o600, flag: "wx" }
      );
      await rename(temporary, file);
      preferenceRevision += 1;
    } finally {
      await rm(temporary, { force: true });
    }
  });
  preferenceWrites = write.catch(() => undefined);
  return write;
}
