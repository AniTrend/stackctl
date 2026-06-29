#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-sys --allow-run=git,docker,docker-compose,sops,age,age-keygen,shred,rm
/**
 * stackctl — standalone repository-aware Docker Swarm stack controller.
 *
 * Compiled binary permissions allow:
 *   --allow-read   (read stack files, config, env)
 *   --allow-write  (write rendered output)
 *   --allow-env    (read shell environment for interpolation)
 *   --allow-sys    (host info, OS detection)
 *   --allow-run=docker,docker-compose,sops,age,age-keygen,shred,rm
 *
 * @module
 */

import { main } from "./cli/mod.ts";

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
