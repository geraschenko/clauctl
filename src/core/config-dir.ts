import envPaths from "env-paths";

/** clauctl's config directory: `$CLAUCTL_CONFIG_DIR`, else the platform's
 *  user config path for "clauctl". */
export function clauctlConfigDir(): string {
  return (
    process.env.CLAUCTL_CONFIG_DIR ?? envPaths("clauctl", { suffix: "" }).config
  );
}
