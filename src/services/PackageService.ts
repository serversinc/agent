import { ShellService } from "./Shell";
import { hostCommand } from "./HostShell";

// Valid Debian/apt package name — blocks shell injection, not specific packages.
const VALID_PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]*$/;

interface InstallResult {
  output: string;
  error: string;
  exitCode: number;
}

export class PackageService {
  constructor(private readonly shellService: ShellService = new ShellService()) {}

  // apt lives on the host, not in the agent's own (Alpine/apk) container —
  // see HostShell for why this has to cross into the host namespace.
  async install(name: string): Promise<InstallResult> {
    if (!VALID_PACKAGE_NAME.test(name)) {
      throw new Error(`Invalid package name: ${name}`);
    }

    return this.shellService.exec(
      hostCommand(`sh -c 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${name}'`),
      { timeout: 300_000 },
    );
  }
}

export const packageService = new PackageService();
