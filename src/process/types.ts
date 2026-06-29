/**
 * Typed process runner abstraction.
 *
 * All external commands must go through this interface.
 * This enables dry-run, test faking, signal forwarding, and permission validation.
 */

/** Result of a completed process execution. */
export interface ProcessResult {
  /** Standard output (captured, not streamed). */
  stdout: string;
  /** Standard error. */
  stderr: string;
  /** Process exit code. */
  code: number;
  /** Whether the process exited successfully (code === 0). */
  success: boolean;
  /** Command that was executed (for diagnostics and dry-run output). */
  command: string[];
}

/** Options for running a command. */
export interface RunOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Environment variables to set for the command. */
  env?: Record<string, string>;
  /** Timeout in milliseconds. */
  timeout?: number;
  /** Signal to use for timeout (default: "SIGTERM"). */
  timeoutSignal?: "SIGTERM" | "SIGKILL";
}

/** Options for streaming a command's output. */
export interface StreamOptions extends RunOptions {
  /** Handler for each stdout line. */
  onStdout?: (line: string) => void;
  /** Handler for each stderr line. */
  onStderr?: (line: string) => void;
}

/**
 * Process runner interface.
 *
 * Two modes:
 * - `run()` — capture stdout/stderr, return when process exits.
 * - `stream()` — pipe stdout/stderr to handlers, return when process exits.
 */
export interface ProcessRunner {
  /** Run a command and capture its output. */
  run(cmd: string[], options?: RunOptions): Promise<ProcessResult>;

  /** Run a command with streaming output. */
  stream(cmd: string[], options?: StreamOptions): Promise<ProcessResult>;

  /** Validate that a command binary exists on PATH. */
  which(name: string): Promise<boolean>;

  /** Current dry-run mode. In dry-run, run/stream log commands but do not execute. */
  readonly dryRun: boolean;
  /** Create a new runner with the given dry-run mode. */
  withDryRun(dryRun: boolean): ProcessRunner;
}
