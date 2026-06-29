/**
 * Shared configuration types for stackctl.
 *
 * These types define the shape of `.stackctl` config files,
 * profile overlays, and resolved merged configuration.
 */

/** Core stackctl configuration. */
export interface StackctlConfig {
  /** Human-readable project name. */
  project: string;
  /** Repository root (auto-detected, overridable). */
  repoRoot?: string;
  /** Default profile name */
  defaultProfile?: string;
  /** Stack generation configuration. */
  stack: StackConfig;
  /** Stack rendering configuration. */
  render: RenderConfig;
  /** Environment file configuration. */
  env: EnvConfig;
  /** Secrets configuration. */
  secrets?: SecretsConfig;
  /** Command-specific defaults. */
  commands?: CommandsConfig;
}

export interface StackConfig {
  /** Subdirectory name for generated stacks (default: "stacks"). */
  directory: string;
  /** Generated stack names. */
  names: string[];
  /** Compose discovery metadata key (default: "x-stack"). */
  composeStackKey?: string;
  /** Directories to skip during discovery. */
  skipDirectories?: string[];
  /** External network name for all stacks. */
  network: string;
  /** External network driver (default: "overlay"). */
  networkDriver?: string;
}

export interface RenderConfig {
  /** Subdirectory name for rendered output (default: ".rendered"). */
  outputDirectory: string;
}

export interface EnvConfig {
  /** Active .env file name (default: ".env"). */
  activeName?: string;
  /** Allow plaintext profile env files (default: false). */
  allowPlaintextProfiles?: boolean;
  /** Pattern for plaintext profile env files. */
  plaintextProfilePattern?: string;
  /** Pattern for encrypted profile env files. */
  encryptedProfilePattern?: string;
}

export interface SecretsConfig {
  /** Encrypted dotenv file name (default: ".env.enc"). */
  encryptedFileName?: string;
  /** Path to a file containing the age public key for sops encryption. */
  ageKeyFile?: string;
  /** Directory where secrets live (default: repo root). */
  secretsDir?: string;
}

export interface CommandsConfig {
  /** Default settings for `up` command. */
  up?: UpConfig;
  /** Default settings for `reload` command. */
  reload?: ReloadConfig;
}

export interface UpConfig {
  /** Follow logs after deploy (default: true). */
  followLogs?: boolean;
}

export interface ReloadConfig {
  /** Follow logs after reload (default: false). */
  followLogs?: boolean;
  /** Auto-generate stacks (default: true). */
  autoGenerate?: boolean;
  /** Force service update after deploy (default: false). */
  forceServiceUpdate?: boolean;
}

/** A resolved profile configuration — partial config that overlays base config. */
export type ProfileConfig = Partial<StackctlConfig>;

/** Override file entry (profile or explicit). */
export interface OverrideEntry {
  /** Source of this override file. */
  source: "profile" | "explicit";
  /** Absolute path to the override YAML file. */
  path: string;
}

/** Final merged configuration after all layers are resolved. */
export interface ResolvedConfig {
  /** The fully-resolved base config. */
  base: StackctlConfig;
  /** Active profile name, if selected. */
  profile?: string;
  /** Profile config overlay, if any. */
  profileConfig?: ProfileConfig;
  /** Local config overlay (.stackctl.local). */
  localConfig?: ProfileConfig;
  /** Local profile config overlay (.stackctl.local.<profile>). */
  localProfileConfig?: ProfileConfig;
  /** Override files discovered or provided. */
  overrides: OverrideEntry[];
}

/** Exit code constants. */
export enum ExitCode {
  Success = 0,
  DriftOrValidation = 1,
  UserConfigError = 2,
  MissingDependency = 3,
  UnexpectedError = 4,
}
