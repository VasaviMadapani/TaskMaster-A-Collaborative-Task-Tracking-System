import { unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { logger } from "../logger";

export async function removeStoredAttachments(storageKeys: string[]): Promise<void> {
  await Promise.all(storageKeys.map(async (storageKey) => {
    const filePath = path.resolve(config.UPLOAD_DIR, storageKey);
    if (path.dirname(filePath) !== path.resolve(config.UPLOAD_DIR)) {
      logger.error({ storageKey }, "Refusing to remove attachment outside the upload directory");
      return;
    }
    try {
      await unlink(filePath);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        logger.warn({ storageKey }, "Attachment file was already missing during cleanup");
        return;
      }
      logger.error({ err: error, storageKey }, "Unable to remove attachment file");
    }
  }));
}
