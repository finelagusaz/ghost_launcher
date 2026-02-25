import { vi } from "vitest";

export class LazyStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private store: Record<string, any> = {};

  get = vi.fn(<T>(key: string): Promise<T | null> =>
    Promise.resolve(key in this.store ? (this.store[key] as T) : null)
  );

  set = vi.fn(async (key: string, value: unknown): Promise<void> => {
    this.store[key] = value;
  });

  save = vi.fn(async (): Promise<void> => {});
}
