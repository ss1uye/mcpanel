import fs from 'node:fs/promises';
import type { ProbeResult } from '@mcpanel/shared';
import { detectJava, type JavaInfo } from '../nodes/java-detect';
import type { PathSandbox } from '../nodes/path-sandbox';
import {
  loadServerProperties,
  parsePort,
  propertyValue,
  readSandboxedTextFile,
  type ParsedProperties,
} from './properties-service';

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

    const warnings: ProbeResult['warnings'] = [];
    let parsed: ParsedProperties | null = null;
    try {
      const loaded = await loadServerProperties(realPath, this.sandbox);
      parsed = loaded?.parsed ?? null;
      if (!loaded) {
        warnings.push({ code: 'PROPERTIES_UNREADABLE', message: 'server.properties 不存在或无法读取，已回退到默认值' });
      }
    } catch {
      warnings.push({ code: 'PROPERTIES_UNREADABLE', message: 'server.properties 无法读取，已回退到默认值' });
    }

    const eula = await readEula(realPath, this.sandbox);
    const enableRcon = propertyValue(parsed, 'enable-rcon', 'false').toLowerCase() === 'true';
    const rconPort = parsePort(propertyValue(parsed, 'rcon.port', '25575'), 25575);
    const serverPort = parsePort(propertyValue(parsed, 'server-port', '25565'), 25565);
    const onlineMode = propertyValue(parsed, 'online-mode', 'true').toLowerCase() !== 'false';
    const java = await this.detect(null);

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

async function readEula(root: string, sandbox: PathSandbox): Promise<boolean> {
  try {
    const file = await readSandboxedTextFile(sandbox, root, 'eula.txt');
    if (!file) return false;
    return file.raw.split(/\r?\n/).some((line) => /^[ \t]*eula[ \t]*=[ \t]*true[ \t]*$/i.test(line));
  } catch {
    return false;
  }
}
