import type { FanvueReadTransport } from "./live-read-contracts";

export const fanvueApiVersion = "2025-06-26";
export const fanvueReadConcurrency = 6;
export const fanvueReadBudgetPerMinute = 200;

type TransportOptions = {
  accessToken: string;
  /** Stable creator UUID, used to coordinate concurrent transport instances without retaining a token. */
  coordinationKey?: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (this.active >= fanvueReadConcurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    return () => {
      this.active -= 1;
      this.waiting.shift()?.();
    };
  }
}

type TransportControl = { semaphore: Semaphore; starts: number[] };
const controls = new Map<string, TransportControl>();

/** Creator-scoped, bounded transport for every live Fanvue read adapter. */
export function createFanvueReadTransport(options: TransportOptions): FanvueReadTransport {
  if (!options.accessToken.trim()) throw new Error("A verified creator access token is required");
  const fetcher = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? "https://api.fanvue.com";
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const key = options.coordinationKey?.trim() || options.accessToken;
  const control = controls.get(key) ?? { semaphore: new Semaphore(), starts: [] };
  controls.set(key, control);

  const reserveBudget = async () => {
    while (true) {
      const current = now();
      while (control.starts.length > 0 && control.starts[0] <= current - 60_000) control.starts.shift();
      if (control.starts.length < fanvueReadBudgetPerMinute) {
        control.starts.push(current);
        return;
      }
      await sleep(Math.max(1, control.starts[0] + 60_000 - current));
    }
  };

  return async (path, init = {}) => {
    const release = await control.semaphore.acquire();
    try {
      await reserveBudget();
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${options.accessToken}`);
      headers.set("X-Fanvue-API-Version", fanvueApiVersion);
      return await fetcher(new URL(path, baseUrl), { ...init, headers });
    } finally {
      release();
    }
  };
}
