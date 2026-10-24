export interface FakeRcon {
  port: number;
  close: () => Promise<void>;
}

export interface FakeRconOptions {
  password?: string;
  port?: number;
  saveAllDelayMs?: number;
  logFile?: string | null;
}

export function startFakeRcon(options?: FakeRconOptions): Promise<FakeRcon>;
