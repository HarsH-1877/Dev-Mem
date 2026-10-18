import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let cachedVersion: string | null = null;

function resolveVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    // Traverse upwards from current file to find package.json
    let curr = __dirname;
    for (let i = 0; i < 4; i++) {
      const pkgPath = join(curr, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.version) {
          cachedVersion = pkg.version;
          return pkg.version;
        }
      }
      curr = dirname(curr);
    }
  } catch {
    // fallback
  }
  return "0.2.1";
}

export interface BannerOptions {
  noColor?: boolean;
  version?: string;
}

export function getBanner(options: BannerOptions = {}): string {
  const isNoColorEnv = typeof process !== "undefined" && Boolean(process.env.NO_COLOR && process.env.NO_COLOR !== "0");
  const useColor = !isNoColorEnv && !options.noColor;

  const version = options.version || resolveVersion();

  const cyan = useColor ? "\x1b[36m" : "";
  const bold = useColor ? "\x1b[1m" : "";
  const dim = useColor ? "\x1b[2m" : "";
  const reset = useColor ? "\x1b[0m" : "";

  const lines = [
    `${cyan}██████╗ ███████╗██╗   ██╗    ███╗   ███╗███████╗███╗   ███╗${reset}`,
    `${cyan}██╔══██╗██╔════╝██║   ██║    ████╗ ████║██╔════╝████╗ ████║${reset}`,
    `${cyan}██║  ██║█████╗  ██║   ██║    ██╔████╔██║█████╗  ██╔████╔██║${reset}`,
    `${cyan}██║  ██║██╔══╝  ╚██╗ ██╔╝    ██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║${reset}`,
    `${cyan}██████╔╝███████╗ ╚████╔╝     ██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║${reset}`,
    `${cyan}╚═════╝ ╚══════╝  ╚═══╝      ╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝${reset}`,
    `  ${dim}Persistent Knowledge Graph for AI Coding Agents${reset} ${bold}• v${version}${reset}`,
  ];

  return lines.join("\n");
}
