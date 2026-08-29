import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface TempFiles {
  /** Write `content` under `name` and return the path the CLI should be given. */
  write: (name: string, content: string) => string;
  /** Remove everything written. Safe to call more than once. */
  cleanup: () => void;
}

/**
 * A per-request scratch directory for anything too large to be an argument.
 *
 * Linux caps a SINGLE argv entry or environment variable at MAX_ARG_STRLEN — 128 KiB, and
 * not raisable — so a request carrying enough tool schemas makes `spawn` fail outright with
 * E2BIG before the CLI runs at all. Measured against this proxy: a request passed at 120 KB
 * and failed at 131 KB, which is that limit exactly.
 *
 * Files have no such ceiling, and the CLI takes a path everywhere it takes one of these
 * blobs. Creating the directory lazily keeps the ordinary small request from touching the
 * filesystem at all.
 */
export function tempFiles(prefix = 'claude-proxy-'): TempFiles {
  let dir: string | null = null;

  return {
    write(name: string, content: string): string {
      if (dir === null) {
        dir = mkdtempSync(join(tmpdir(), prefix));
      }
      const path = join(dir, name);
      writeFileSync(path, content, 'utf-8');
      return path;
    },
    cleanup(): void {
      if (dir === null) return;
      const doomed = dir;
      dir = null;
      try {
        rmSync(doomed, { recursive: true, force: true });
      } catch {
        // A leftover temp directory is not worth failing a completed request over.
      }
    },
  };
}
