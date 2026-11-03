import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from './connection.ts';
import type { Statement, Request } from './worker.ts';
const database = openDatabase(workerData.filename as string);
function execute(statement: Statement) {
  const prepared = database.sqlite.prepare(statement.sql);
  const parameters = statement.params ?? [];
  if (prepared.reader) {
    const rows = prepared.all(...parameters);
    if (statement.expect !== undefined && rows.length !== statement.expect)
      throw new Error(statement.code ?? 'PRECONDITION_FAILED');
    return rows;
  }
  const result = prepared.run(...parameters);
  if (statement.expect !== undefined && result.changes !== statement.expect)
    throw new Error(statement.code ?? 'PRECONDITION_FAILED');
  return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
}
parentPort!.postMessage({ ready: true, version: database.version });
parentPort!.on('message', (request: Request) => {
  try {
    let result: unknown;
    if (request.close) {
      database.close();
      parentPort!.postMessage({ id: request.id, result: null });
      parentPort!.close();
      return;
    }
    if (request.transaction) {
      const action = database.sqlite.transaction(() => request.statements.map(execute));
      result = action.immediate();
    } else result = execute(request.statements[0]!);
    parentPort!.postMessage({ id: request.id, result });
  } catch (error) {
    parentPort!.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : 'DATABASE_ERROR',
    });
  }
});
