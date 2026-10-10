/**
 * Minimal ambient typings for `mssql` (v12 ships no declaration files and there
 * is no `@types/mssql`); only the surface used by `checks.ts` is declared.
 */
declare module 'mssql' {
  /** Statement result subset read by the probe. */
  export interface MssqlQueryResult {
    rowsAffected: number[]
  }

  export interface MssqlRequest {
    query(command: string): Promise<MssqlQueryResult>
  }

  /** Pool keys read when each connection is built; both default to 15 s. */
  export interface MssqlPoolConfig {
    connectionTimeout?: number
    requestTimeout?: number
  }

  export class ConnectionPool {
    constructor(config: string | Record<string, unknown>)
    readonly config: MssqlPoolConfig
    connect(): Promise<unknown>
    close(): Promise<unknown>
    request(): MssqlRequest
    on(event: 'error', listener: (error: Error) => void): unknown
  }
}
