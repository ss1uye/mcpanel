import { spawn } from 'node:child_process';
import path from 'node:path';

export interface JavaInfo {
  path: string;
  major: number;
}

export type JavaExec = (command: string) => Promise<string>;

export function parseJavaMajor(output: string): number | null {
  const match = output.match(/^(?:openjdk|java) version "(?:1\.)?(\d+)/im);
  return match ? Number(match[1]) : null;
}

export function javaCandidates(javaPath: string | null, env: NodeJS.ProcessEnv = process.env): string[] {
  const executable = process.platform === 'win32' ? 'java.exe' : 'java';
  const candidates: string[] = [];
  if (javaPath) candidates.push(javaPath);
  if (env.JAVA_HOME) candidates.push(path.join(env.JAVA_HOME, 'bin', executable));
  candidates.push('java');
  return [...new Set(candidates)];
}

function defaultExec(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['-version'], { windowsHide: true });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('java -version timeout'));
    }, 5000);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`java exited with ${code}`));
    });
  });
}

export async function detectJava(javaPath: string | null, exec: JavaExec = defaultExec): Promise<JavaInfo | null> {
  for (const candidate of javaCandidates(javaPath)) {
    try {
      const major = parseJavaMajor(await exec(candidate));
      if (major !== null) return { path: candidate, major };
    } catch {
      // try the next candidate
    }
  }
  return null;
}
