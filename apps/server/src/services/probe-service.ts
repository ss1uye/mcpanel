import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProbeResult } from '@mcpanel/shared';
import { detectJava, type JavaInfo } from '../nodes/java-detect';
import type { PathSandbox } from '../nodes/path-sandbox';
import { loadServerProperties, propertyValue } from './properties-service';

export type JavaDetector = (javaPath: string | null) => Promise<JavaInfo | null>;

export class ProbeService {
  constructor(
    private readonly sandbox: PathSandbox,
    private readonly detect: JavaDetector = detectJava,
  ) {}

  async probe(rootPath: string, otherRoots: string[]): Promise<ProbeResult> {
    const { realPath } = await this.sandbox.validateRoot(rootPath, otherRoots);
    const entries = await fs.readdir(realPath, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const directories = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));

    const startScripts = files.filter((file) => /^(run|start)\.(bat|cmd|sh)$/i.test(file));
    const serverJars = files.filter((file) => /\.jar$/i.test(file) && /(server|fabric|forge|neoforge)/i.test(file));
    const parsed = (await loadServerProperties(realPath))?.parsed ?? null;
    const eula = await readEula(realPath);
    const enableRcon = propertyValue(parsed, 'enable-rcon', 'false') === 'true';
    const rconPort = Number(propertyValue(parsed, 'rcon.port', '25575')) || 25575;
    const serverPort = Number(propertyValue(parsed, 'server-port', '25565')) || 25565;
    const onlineMode = propertyValue(parsed, 'online-mode', 'true') !== 'false';
    const java = await this.detect(null);

    const warnings: ProbeResult['warnings'] = [];
    if (!eula) warnings.push({ code: 'EULA_NOT_ACCEPTED', message: 'eula.txt 尚未接受' });
    if (enableRcon && propertyValue(parsed, 'rcon.password', '') === '') {
      warnings.push({ code: 'RCON_PASSWORD_EMPTY', message: 'RCON 已启用但密码为空' });
    }
    if (startScripts.length === 0) {
      warnings.push({ code: 'NO_START_SCRIPT', message: '未找到 run/start 脚本，请手动填写启动命令' });
    }

    return {
      rootPath: realPath,
      valid: true,
      detected: {
        startScripts,
        serverJars,
        levelName: propertyValue(parsed, 'level-name', 'world'),
        serverPort,
        enableRcon,
        rconPort,
        onlineMode,
        hasMods: directories.has('mods'),
        hasConfig: directories.has('config'),
        eula,
      },
      java,
      suggestedStartCommand: startScripts[0] ?? null,
      warnings,
    };
  }
}

async function readEula(root: string): Promise<boolean> {
  try {
    return /^\s*eula\s*=\s*true\s*$/im.test(await fs.readFile(path.join(root, 'eula.txt'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
