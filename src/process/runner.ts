/**
 * Real ProcessRunner implementation using Deno.Command.
 *
 * All external commands go through this interface.
 * This enables dry-run, test faking, signal forwarding, and permission validation.
 */
import type { ProcessResult, ProcessRunner, RunOptions, StreamOptions } from "./types.ts";

/**
 * Real process runner that executes commands via Deno.Command.
 *
 * Two modes:
 * - Normal: executes commands against the real OS
 * - Dry-run: logs the intended command instead of executing
 */
export class RealProcessRunner implements ProcessRunner {
  readonly dryRun: boolean;

  constructor(dryRun = false) {
    this.dryRun = dryRun;
  }

  /** Run a command and capture its output. */
  async run(cmd: string[], options?: RunOptions): Promise<ProcessResult> {
    if (cmd.length === 0) {
      return { stdout: "", stderr: "", code: 1, success: false, command: cmd };
    }

    if (this.dryRun) {
      const msg = `[dry-run] would run: ${cmd.join(" ")}`;
      console.log(msg);
      return { stdout: "", stderr: "", code: 0, success: true, command: cmd };
    }

    const [executable, ...args] = cmd;
    const command = new Deno.Command(executable, {
      args,
      stdout: "piped",
      stderr: "piped",
      cwd: options?.cwd,
      env: options?.env,
    });

    let output: Deno.CommandOutput;
    try {
      output = await command.output();
    } catch (err: unknown) {
      return {
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        code: 1,
        success: false,
        command: cmd,
      };
    }

    const decoder = new TextDecoder();
    return {
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
      code: output.code,
      success: output.success,
      command: cmd,
    };
  }

  /** Run a command with streaming output via onStdout/onStderr callbacks. */
  async stream(cmd: string[], options?: StreamOptions): Promise<ProcessResult> {
    if (cmd.length === 0) {
      return { stdout: "", stderr: "", code: 1, success: false, command: cmd };
    }

    if (this.dryRun) {
      const msg = `[dry-run] would stream: ${cmd.join(" ")}`;
      console.log(msg);
      return { stdout: "", stderr: "", code: 0, success: true, command: cmd };
    }

    const [executable, ...args] = cmd;
    const command = new Deno.Command(executable, {
      args,
      stdout: "piped",
      stderr: "piped",
      cwd: options?.cwd,
      env: options?.env,
    });

    const child = command.spawn();

    // Forward SIGINT/SIGTERM to child process
    const signalHandler = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Child may already have exited
      }
    };
    Deno.addSignalListener("SIGINT", signalHandler);
    Deno.addSignalListener("SIGTERM", signalHandler);

    try {
      const stdoutText = await drainStream(child.stdout, options?.onStdout);
      const stderrText = await drainStream(child.stderr, options?.onStderr);
      const status = await child.status;

      return {
        stdout: stdoutText,
        stderr: stderrText,
        code: status.code,
        success: status.success,
        command: cmd,
      };
    } catch (err: unknown) {
      return {
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        code: 1,
        success: false,
        command: cmd,
      };
    } finally {
      Deno.removeSignalListener("SIGINT", signalHandler);
      Deno.removeSignalListener("SIGTERM", signalHandler);
    }
  }

  /** Validate that a command binary exists on PATH. */
  async which(name: string): Promise<boolean> {
    try {
      const command = new Deno.Command("which", { args: [name], stdout: "null", stderr: "null" });
      const output = await command.output();
      return output.success;
    } catch {
      return false;
    }
  }

  /** Create a new runner with the given dry-run mode. */
  withDryRun(dryRun: boolean): ProcessRunner {
    return new RealProcessRunner(dryRun);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Drain a ReadableStream<Uint8Array> to a string, optionally emitting lines
 * through an onLine callback.
 */
async function drainStream(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  let result = "";
  let buffer = "";

  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      if (onLine) {
        // Emit complete lines, keeping residual in buffer
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          onLine(line);
        }
      }

      result += chunk;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be closed
    }
  }

  // Flush remaining buffer
  if (onLine && buffer) {
    onLine(buffer);
  }

  return result;
}
