/**
 * Test utilities: fakes and test helpers.
 *
 * Provides FakeProcessRunner for unit testing command execution
 * without requiring Docker, sops, age, or other external tools.
 */

import {
  type ProcessResult,
  type ProcessRunner,
  type RunOptions,
  type StreamOptions,
} from "../process/types.ts";

/** Pre-programmed response for a single command. */
export interface CommandResponse {
  /** Expected command pattern (checked via .startsWith or .includes). */
  match: string[];
  /** Whether to match by exact equality (default: false — uses startsWith). */
  exact?: boolean;
  /** Response to return. */
  result: ProcessResult;
}

/** Builder for FakeProcessRunner. */
export class FakeProcessRunnerBuilder {
  private responses: CommandResponse[] = [];
  private _dryRun = false;

  /** Add a response that matches a command. */
  addResponse(response: CommandResponse): this {
    this.responses.push(response);
    return this;
  }

  /** Set dry-run mode. */
  dryRun(value: boolean): this {
    this._dryRun = value;
    return this;
  }

  /** Build the fake runner. */
  build(): FakeProcessRunner {
    return new FakeProcessRunner(this.responses, this._dryRun);
  }

  /** Create builder with sensible defaults for tests. */
  static success(stdout = "", stderr = ""): FakeProcessRunnerBuilder {
    return new FakeProcessRunnerBuilder().addResponse({
      match: [],
      result: { stdout, stderr, code: 0, success: true, command: [] },
    });
  }

  /** Create builder that matches a specific command. */
  static forCommand(
    command: string[],
    result: Partial<ProcessResult>,
  ): FakeProcessRunnerBuilder {
    return new FakeProcessRunnerBuilder().addResponse({
      match: command,
      exact: true,
      result: {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        code: result.code ?? 0,
        success: result.code == null || result.code === 0,
        command,
      },
    });
  }
}

/**
 * Fake process runner for unit tests.
 *
 * Records all executed commands and returns pre-programmed responses.
 * Fails test if an unknown command is executed.
 */
export class FakeProcessRunner implements ProcessRunner {
  readonly recorded: string[][] = [];
  readonly dryRun: boolean;
  private responses: CommandResponse[];

  constructor(responses: CommandResponse[] = [], dryRun = false) {
    this.responses = responses;
    this.dryRun = dryRun;
  }

  run(cmd: string[], _options?: RunOptions): Promise<ProcessResult> {
    this.recorded.push(cmd);
    const response = this.matchResponse(cmd);
    if (!response) {
      throw new Error(
        `FakeProcessRunner: no response configured for command: ${cmd.join(" ")}`,
      );
    }
    return Promise.resolve({ ...response.result, command: cmd });
  }

  stream(cmd: string[], _options?: StreamOptions): Promise<ProcessResult> {
    return this.run(cmd, _options);
  }

  which(name: string): Promise<boolean> {
    const cmd = ["which", name];
    this.recorded.push(cmd);
    const response = this.matchResponse(cmd);
    return Promise.resolve(response?.result.success ?? false);
  }

  withDryRun(dryRun: boolean): ProcessRunner {
    return new FakeProcessRunner(this.responses, dryRun);
  }

  /** Get all recorded command invocations (for assertions). */
  get commands(): string[][] {
    return [...this.recorded];
  }

  /** Verify that a command was executed. */
  containsCommand(partial: string[]): boolean {
    return this.recorded.some((cmd) => partial.every((p, i) => cmd[i] === p));
  }

  private matchResponse(cmd: string[]): CommandResponse | undefined {
    for (const response of this.responses) {
      if (response.match.length === 0) return response; // catch-all
      if (response.exact) {
        if (
          cmd.length === response.match.length &&
          cmd.every((p, i) => p === response.match[i])
        ) {
          return response;
        }
      } else {
        if (
          cmd.length >= response.match.length &&
          response.match.every((p, i) => cmd[i] === p)
        ) {
          return response;
        }
      }
    }
    return undefined;
  }
}

/** Helper to create a successful process result. */
export function successResult(stdout = "", stderr = ""): ProcessResult {
  return { stdout, stderr, code: 0, success: true, command: [] };
}

/** Helper to create a failure process result. */
export function failureResult(
  code: number,
  stderr: string,
  stdout = "",
): ProcessResult {
  return { stdout, stderr, code, success: false, command: [] };
}
