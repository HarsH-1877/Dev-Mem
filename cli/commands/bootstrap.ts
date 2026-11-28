import { bootstrapProject, type BootstrapResult } from "../../core/bootstrap/index.js";

export async function runBootstrap(cwd: string, args: string[] = []): Promise<BootstrapResult> {
  const fromFiles: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) {
      fromFiles.push(args[i + 1]);
      i++;
    }
  }
  return bootstrapProject({ projectRoot: cwd, fromFiles });
}
