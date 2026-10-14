// The verified release cache shared by integration runs (WEB-08d design assessment, preparation step 2): an extracted release is
// published once, atomically, into a directory named by its target and checksum, and never written again. Extraction happens in a
// private staging directory that is renamed into place; a second run that finishes extracting the same release finds it published
// and discards its own copy. So one run can never overwrite an executable another run is using.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const MARK = ".verified";

/** `dir/key`, filled by `fill(staging)` unless it is already published. Returns { path, reused }. */
export function publish({ dir, key, fill }) {
  mkdirSync(dir, { recursive: true });
  const final = join(dir, key);
  const published = () => {
    try {
      return readFileSync(join(final, MARK), "utf8") === key;
    } catch {
      return false;
    }
  };
  if (published()) return { path: final, reused: true };
  const staging = mkdtempSync(join(dir, `.staging-${key}-`));
  try {
    fill(staging);
    writeFileSync(join(staging, MARK), key);
    try {
      renameSync(staging, final);
      return { path: final, reused: false };
    } catch (error) {
      if (published()) {
        rmSync(staging, { recursive: true, force: true });
        return { path: final, reused: true };
      }
      throw error;
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Write `bytes` to `path` atomically (a reader sees the old file or the whole new one, never part of it). */
export function writeAtomic(path, bytes) {
  const temporary = `${path}.${process.pid}.${Date.now()}.partial`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, path);
}

export const isPublished = (dir, key) => existsSync(join(dir, key, MARK));
