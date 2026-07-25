# src/secrets/

## Responsibility

The secrets module provides the public API and implementation for managing dotenv secret files with
SOPS and age. It encrypts plaintext `.env` files to `.env.enc`, decrypts `.env.enc` files back to
`.env` materialized files, verifies required external tooling, securely removes decrypted material,
and runs the deploy pipeline that decrypts, generates stack compose data, renders environment
substitutions, deploys with Docker, and cleans up decrypted files.

## Design Patterns

- External command adapter: all subprocess calls use the `ProcessRunner` interface, with
  `RealProcessRunner` as the default and injectable runners for tests or callers.
- Result objects over thrown errors for operational steps: encrypt, decrypt, clean, and deploy
  return structured success, warning, and error values. Tooling enforcement is the exception, where
  `ensureTooling` throws on missing dependencies.
- SOPS-owned key resolution: encryption and decryption invoke SOPS with dotenv input and output
  types, and do not pass age recipients or key paths. SOPS resolves age configuration from its own
  config, typically `.sops.yaml`.
- Best-effort cleanup: decrypted files are removed with `shred -u` first, then `rm -f` as a fallback
  when shredding fails or is unavailable.
- Dry-run propagation: the deploy pipeline records intended mutations as warnings, and cleanup
  returns the files that would be removed without deleting them.

## Data & Control Flow

1. Tooling checks call `runner.which("sops")` and `runner.which("age")`; status checks also call
   `<tool> --version` through `runner.run` and capture the first stdout line.
2. Encryption accepts a plaintext source path, verifies it exists, derives `<source>.enc`, then runs
   `sops --encrypt --input-type dotenv --output-type dotenv --output <source>.enc <source>`.
3. Decryption accepts an encrypted source path, strips the `.enc` suffix for the plaintext output
   path, verifies the encrypted file exists, then runs
   `sops --decrypt --input-type dotenv --output-type dotenv --output <plainPath> <source>`.
4. Discovery walks the working directory and collects files named `.env.enc` or `.env.example`,
   skipping `.git`, `.rendered`, and `node_modules`.
5. The deploy pipeline discovers `.env.enc` files, decrypts each one, derives affected stack names
   from each encrypted file parent directory, resolves stack configuration, discovers compose files,
   generates in-memory stack YAML, renders `${VAR}` placeholders against the repository context,
   deploys each rendered stack with Docker, and finally cleans up every materialized `.env` file.
6. Cleanup iterates materialized env files and invokes `shred -u <path>` through the runner. If that
   command does not succeed, it invokes `rm -f <path>` through the same runner.

Age key generation is not implemented in this module. The code checks for the `age` binary but does
not invoke `age-keygen`, create key files, or manage recipient material directly.

## Integration Points

- `index.ts` re-exports the public types and functions from `types.ts` and `mod.ts`.
- `types.ts` defines deploy, tooling, encryption, decryption, and cleanup result contracts.
- `../process/types.ts` supplies `ProcessRunner`; `../process/runner.ts` supplies
  `RealProcessRunner` for command execution.
- `@std/fs` supplies `exists` and `walk` for source validation and repository traversal.
- `../config/mod.ts` provides `resolveConfig` for pipeline configuration and repository root
  resolution.
- `../compose/mod.ts` provides compose discovery and in-memory stack generation.
- `../render/mod.ts` provides `renderStack` for environment interpolation before deployment.
- `../docker/mod.ts` provides `dockerStackDeploy` for stack deployment.
- `@std/yaml` parses generated YAML before rendering and stringifies rendered compose data into a
  temporary deployment file.
