import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildServerEnv, buildShellCommand, processMatchesRoot } from '../../src/nodes/process-tree';

describe('buildShellCommand', () => {
  it('keeps the instance root inside the Windows command line for PID verification', () => {
    const root = 'D:\\servers\\survival';
    const command = buildShellCommand(root, 'run.bat', 'win32');
    expect(command.file).toBe('cmd.exe');
    expect(command.verbatim).toBe(true);
    expect(command.args[3]).toContain(root);
    expect(command.args[3]).toContain('run.bat');
  });

  it('rejects a Windows root path containing a double quote', () => {
    expect(() => buildShellCommand('D:\\evil"root', 'run.bat', 'win32')).toThrow(/非法字符/);
  });

  it('single-quotes the POSIX root and escapes embedded quotes', () => {
    const command = buildShellCommand("/srv/it's here", './run.sh', 'linux');
    expect(command.file).toBe('/bin/sh');
    expect(command.verbatim).toBe(false);
    expect(command.args[1]).toBe(`cd -- '/srv/it'\\''s here' && ./run.sh`);
  });

  it('resolves a bare POSIX shell script from the instance root', () => {
    const command = buildShellCommand('/srv/survival', 'start.sh --nogui', 'linux');
    expect(command.args[1]).toBe(`cd -- '/srv/survival' && ./start.sh --nogui`);
  });

  it('leaves qualified paths and explicit interpreters unchanged', () => {
    expect(buildShellCommand('/srv/survival', './start.sh', 'linux').args[1]).toBe(
      `cd -- '/srv/survival' && ./start.sh`,
    );
    expect(buildShellCommand('/srv/survival', 'sh start.sh', 'linux').args[1]).toBe(
      `cd -- '/srv/survival' && sh start.sh`,
    );
  });
});

describe('buildServerEnv', () => {
  const javaPath = path.resolve('jdks', 'jdk-17', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const binDir = path.dirname(javaPath);

  it('prepends the configured Java bin directory and sets JAVA_HOME', () => {
    const env = buildServerEnv(javaPath, { Path: '/base/path', JAVA_HOME: '/old' });
    expect(env.Path).toBe(`${binDir}${path.delimiter}/base/path`);
    expect(env.JAVA_HOME).toBe(path.dirname(binDir));
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'path')).toHaveLength(1);
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'java_home')).toHaveLength(1);
  });

  it('ignores a relative java path and keeps the base environment', () => {
    const env = buildServerEnv('java', { Path: '/base/path' });
    expect(env.Path).toBe('/base/path');
    expect(env.JAVA_HOME).toBeUndefined();
  });
});

describe('processMatchesRoot', () => {
  const list = [
    { pid: 10, command: 'C:\\Windows\\System32\\cmd.exe', params: '/d /s /c cd /d "D:\\Server\\Survival" && run.bat' },
    { pid: 20, command: '/usr/bin/java', params: '-jar server.jar' },
    { pid: 30, command: '', params: '' },
  ];

  it('matches case-insensitively on the recorded command line', () => {
    expect(processMatchesRoot(list, 10, path.win32.resolve('D:\\server\\survival'))).toBe(true);
  });

  it('reports a mismatch for an unrelated process', () => {
    expect(processMatchesRoot(list, 20, 'D:\\Server\\Survival')).toBe(false);
  });

  it('reports null when the command line is unreadable', () => {
    expect(processMatchesRoot(list, 30, 'D:\\Server\\Survival')).toBeNull();
  });

  it('reports false when the pid is gone', () => {
    expect(processMatchesRoot(list, 999, 'D:\\Server\\Survival')).toBe(false);
  });
});
