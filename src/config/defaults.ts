/**
 * Default configuration values.
 *
 * These serve as the base layer for config resolution.
 * All fields match the StackctlConfig type shape.
 */
import type { StackctlConfig } from "./types.ts";

export const DEFAULT_CONFIG: StackctlConfig = {
  project: "",
  stack: {
    directory: "stacks",
    names: [],
    network: "",
    composeStackKey: "x-stack",
    skipDirectories: [],
    networkDriver: "overlay",
  },
  render: {
    outputDirectory: ".rendered",
  },
  env: {
    activeName: ".env",
    allowPlaintextProfiles: false,
  },
  overrides: {
    autoDiscoverProfiles: true,
    exclude: [],
  },
};
