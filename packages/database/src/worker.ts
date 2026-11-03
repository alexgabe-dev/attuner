import { Worker } from 'node:worker_threads';
export type Value = string | number | null | Uint8Array;
export type Statement = { sql: string; params?: Value[]; expect?: number; code?: string };
export type Request = {
  id: number;
  statements: Statement[];
  transaction?: boolean;
  close?: boolean;
};
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  bytes?: number;
};
export class DatabaseWorker {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private queuedBytes = 0;
  private closed = false;
  version = '';
  private constructor(filename: string) {
    this.worker = new Worker(
      new URL(
        import.meta.url.endsWith('.ts') ? './worker-entry.ts' : './worker-entry.js',
        import.meta.url,
      ),
      { workerData: { filename } },
    );
    this.worker.on(
      'message',
      (message: {
        id?: number;
        result?: unknown;
        error?: string;
        ready?: boolean;
        version?: string;
      }) => {
        if (message.ready) {
          this.version = message.version!;
          this.pending.get(0)?.resolve(null);
          this.pending.delete(0);
          return;
        }
        const pending = this.pending.get(message.id!);
        this.pending.delete(message.id!);
        this.queuedBytes -= pending?.bytes ?? 0;
        if (message.error) pending?.reject(new Error(message.error));
        else pending?.resolve(message.result);
      },
    );
    const fail = (error: Error) => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
      this.queuedBytes = 0;
    };
    this.worker.on('error', fail);
    this.worker.on('exit', () => fail(new Error('DATABASE_CLOSED')));
  }
  static async open(filename = ':memory:'): Promise<DatabaseWorker> {
    const worker = new DatabaseWorker(filename);
    await new Promise((resolve, reject) => worker.pending.set(0, { resolve, reject }));
    return worker;
  }
  private request(statements: Statement[], transaction = false, close = false): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('DATABASE_CLOSED'));
    const bytes = Buffer.byteLength(JSON.stringify(statements));
    if (
      this.pending.size >= 64 ||
      statements.length > 100128 ||
      this.queuedBytes + bytes > 33554432
    )
      return Promise.reject(new Error('DATABASE_BUSY'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.queuedBytes += bytes;
      this.pending.set(id, { resolve, reject, bytes });
      this.worker.postMessage({ id, statements, transaction, close });
    });
  }
  async query<T extends object = Record<string, unknown>>(
    sql: string,
    params: Value[] = [],
  ): Promise<T[]> {
    return (await this.request([{ sql, params }])) as T[];
  }
  async run(
    sql: string,
    params: Value[] = [],
  ): Promise<{ changes: number; lastInsertRowid: number }> {
    return (await this.request([{ sql, params }])) as { changes: number; lastInsertRowid: number };
  }
  async transaction(statements: Statement[]): Promise<unknown[]> {
    return (await this.request(statements, true)) as unknown[];
  }
  async close(): Promise<void> {
    if (this.closed) return;
    await this.request([], false, true);
    this.closed = true;
    await this.worker.terminate();
  }
}
