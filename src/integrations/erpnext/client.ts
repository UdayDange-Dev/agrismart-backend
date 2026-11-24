import { z } from 'zod';
import type { Logger } from 'pino';
import { runtimeWriteBlock, WRITES_DENIED, type WritePolicy } from './writeGuard.js';

export type ErpNextErrorKind =
  | 'timeout'
  | 'network'
  | 'auth'
  | 'not_found'
  | 'validation'
  | 'upstream'
  | 'invalid_response'
  /** Refused locally by the write guard; nothing was sent. */
  | 'write_blocked';

/** Errors never carry request headers, credentials or raw upstream bodies. */
export class ErpNextError extends Error {
  constructor(
    public readonly kind: ErpNextErrorKind,
    message: string,
    public readonly status?: number,
    /** From a Retry-After header on 429/503 responses, capped. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ErpNextError';
  }
}

export interface ErpNextClientOptions {
  baseUrl: URL;
  apiKey: string;
  apiSecret: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Whether insert/update are permitted (see writeGuard.ts). Omitted = read-only client. */
  writes?: WritePolicy;
  /** Receives warnings such as a list truncated at the row cap. */
  logger?: Pick<Logger, 'warn'>;
}

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** Parses Retry-After (delta-seconds or HTTP-date) into a bounded delay, or undefined. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  let ms: number;
  if (/^\d{1,9}$/.test(trimmed)) ms = Number(trimmed) * 1000;
  else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    ms = at - now;
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

export type Filter = [string, string, unknown];

export interface ImageResult {
  contentType: string;
  body: Buffer;
}

const MAX_JSON_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
/** Only public ERPNext files; private files and absolute URLs are never fetched. */
const PUBLIC_FILE_PATH = /^\/files\/[A-Za-z0-9._\-()%+ ]{1,200}$/;
const DOCTYPE_NAME = /^[A-Za-z][A-Za-z -]{1,60}$/;

const listResponse = z.object({ data: z.array(z.record(z.string(), z.unknown())) });
const docResponse = z.object({ data: z.record(z.string(), z.unknown()) });

export class ErpNextClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ErpNextClientOptions) {
    this.origin = opts.baseUrl.origin;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  static isPublicFilePath(path: unknown): path is string {
    return typeof path === 'string' && PUBLIC_FILE_PATH.test(path) && !path.includes('..');
  }

  private buildUrl(path: string, params?: Record<string, string>): URL {
    const url = new URL(path, this.origin);
    // Defence in depth: requests can only ever go to the configured, allowlisted origin.
    if (url.origin !== this.origin) throw new ErpNextError('validation', 'Refusing request to unexpected origin');
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    return url;
  }

  private authHeader(): string {
    return `token ${this.opts.apiKey}:${this.opts.apiSecret}`;
  }

  /** Maps a fetch or body-read failure to a timeout or network error. */
  private static transportError(err: unknown): ErpNextError {
    if (err instanceof ErpNextError) return err;
    const name = (err as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new ErpNextError('timeout', 'ERPNext request timed out');
    }
    return new ErpNextError('network', 'ERPNext is unreachable');
  }

  /** Reads a response body; the request timeout also covers the body, so a stall is a timeout. */
  private static async readBody<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (err) {
      throw ErpNextClient.transportError(err);
    }
  }

  private async request(url: URL, init: RequestInit & { authenticated: boolean }): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Accept', init.authenticated ? 'application/json' : 'image/*');
    if (init.authenticated) headers.set('Authorization', this.authHeader());
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers,
        redirect: 'error', // never follow redirects off the allowlisted host
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      throw ErpNextClient.transportError(err);
    }
    if (res.ok) return res;
    // Drain body without surfacing it; it may contain internal tracebacks.
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 401 || res.status === 403) throw new ErpNextError('auth', 'ERPNext rejected the credentials or permissions', res.status);
    if (res.status === 404) throw new ErpNextError('not_found', 'ERPNext resource not found', res.status);
    if (res.status === 429 || res.status === 503) {
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      throw new ErpNextError('upstream', res.status === 429 ? 'ERPNext rate limit reached' : 'ERPNext is unavailable', res.status, retryAfterMs);
    }
    if (res.status === 409 || res.status === 417 || res.status === 400) {
      throw new ErpNextError('validation', 'ERPNext rejected the request data', res.status);
    }
    throw new ErpNextError('upstream', 'ERPNext returned an error', res.status);
  }

  /** Refuses a write before anything is sent, unless both the policy and the runtime allow it. */
  private assertWritable(): void {
    const policy = this.opts.writes ?? WRITES_DENIED;
    const blocked = !policy.allowed ? policy.reason : runtimeWriteBlock(this.opts.baseUrl);
    if (blocked) throw new ErpNextError('write_blocked', `ERPNext write refused: ${blocked}`);
  }

  private async readJson(res: Response): Promise<unknown> {
    const length = Number(res.headers.get('content-length') ?? '0');
    if (length > MAX_JSON_BYTES) throw new ErpNextError('invalid_response', 'ERPNext response too large');
    const text = await ErpNextClient.readBody(() => res.text());
    if (text.length > MAX_JSON_BYTES) throw new ErpNextError('invalid_response', 'ERPNext response too large');
    try {
      return JSON.parse(text);
    } catch {
      throw new ErpNextError('invalid_response', 'ERPNext returned malformed JSON');
    }
  }

  private resourcePath(doctype: string, name?: string): string {
    if (!DOCTYPE_NAME.test(doctype)) throw new ErpNextError('validation', 'Invalid doctype');
    const base = `/api/resource/${encodeURIComponent(doctype)}`;
    return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
  }

  async getList(
    doctype: string,
    options: { fields: string[]; filters?: Filter[]; limit?: number; start?: number; orderBy?: string },
  ): Promise<Record<string, unknown>[]> {
    const url = this.buildUrl(this.resourcePath(doctype), {
      fields: JSON.stringify(options.fields),
      filters: JSON.stringify(options.filters ?? []),
      limit_page_length: String(options.limit ?? 500),
      limit_start: String(options.start ?? 0),
      ...(options.orderBy ? { order_by: options.orderBy } : {}),
    });
    const res = await this.request(url, { method: 'GET', authenticated: true });
    const parsed = listResponse.safeParse(await this.readJson(res));
    if (!parsed.success) throw new ErpNextError('invalid_response', `Unexpected ${doctype} list response shape`);
    return parsed.data.data;
  }

  /** Fetches every page up to a hard cap to bound memory and upstream load. */
  async getAll(
    doctype: string,
    options: { fields: string[]; filters?: Filter[]; pageSize?: number; maxRows?: number; orderBy?: string },
  ): Promise<Record<string, unknown>[]> {
    const pageSize = options.pageSize ?? 500;
    const maxRows = options.maxRows ?? 10000;
    const rows: Record<string, unknown>[] = [];
    let lastPageFull = false;
    for (let start = 0; start < maxRows; start += pageSize) {
      // Stable ordering so pages do not shift if records change during the load.
      const page = await this.getList(doctype, { orderBy: 'name asc', ...options, limit: pageSize, start });
      rows.push(...page);
      lastPageFull = page.length === pageSize;
      if (!lastPageFull) break;
    }
    // Stopped by the cap on a full page: one extra row tells whether anything was left out.
    const truncated =
      rows.length > maxRows ||
      (lastPageFull &&
        (await this.getList(doctype, { orderBy: 'name asc', ...options, limit: 1, start: rows.length })).length > 0);
    if (truncated) {
      this.opts.logger?.warn({ doctype, maxRows }, 'ERPNext list truncated at the row cap; later rows were not loaded');
    }
    return rows.slice(0, maxRows);
  }

  async getDoc(doctype: string, name: string): Promise<Record<string, unknown>> {
    const res = await this.request(this.buildUrl(this.resourcePath(doctype, name)), { method: 'GET', authenticated: true });
    const parsed = docResponse.safeParse(await this.readJson(res));
    if (!parsed.success) throw new ErpNextError('invalid_response', `Unexpected ${doctype} response shape`);
    return parsed.data.data;
  }

  /** Read-only call of a whitelisted Frappe method via GET (e.g. `frappe.auth.get_logged_user`). */
  async getMethod(method: string): Promise<unknown> {
    if (!/^[a-z_]+(\.[a-z_]+)+$/.test(method)) throw new ErpNextError('validation', 'Invalid method name');
    const res = await this.request(this.buildUrl(`/api/method/${method}`), { method: 'GET', authenticated: true });
    const parsed = z.object({ message: z.unknown() }).safeParse(await this.readJson(res));
    if (!parsed.success) throw new ErpNextError('invalid_response', 'Unexpected method response shape');
    return parsed.data.message;
  }

  async insert(doctype: string, doc: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertWritable();
    const res = await this.request(this.buildUrl(this.resourcePath(doctype)), {
      method: 'POST',
      authenticated: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    });
    const parsed = docResponse.safeParse(await this.readJson(res));
    if (!parsed.success) throw new ErpNextError('invalid_response', `Unexpected ${doctype} insert response shape`);
    return parsed.data.data;
  }

  /** Updates the given fields of an existing document (PUT). Other fields are left unchanged. */
  async update(doctype: string, name: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertWritable();
    const res = await this.request(this.buildUrl(this.resourcePath(doctype, name)), {
      method: 'PUT',
      authenticated: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    const parsed = docResponse.safeParse(await this.readJson(res));
    if (!parsed.success) throw new ErpNextError('invalid_response', `Unexpected ${doctype} update response shape`);
    return parsed.data.data;
  }

  /** Fetch a public product image. Only `/files/...` paths from ERPNext data are accepted. */
  async fetchPublicImage(path: string): Promise<ImageResult> {
    if (!ErpNextClient.isPublicFilePath(path)) throw new ErpNextError('validation', 'Image path not allowed');
    const res = await this.request(this.buildUrl(path), { method: 'GET', authenticated: false });
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      await res.body?.cancel().catch(() => undefined);
      throw new ErpNextError('invalid_response', 'Unsupported image type');
    }
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_IMAGE_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      throw new ErpNextError('invalid_response', 'Image too large');
    }
    const body = Buffer.from(await ErpNextClient.readBody(() => res.arrayBuffer()));
    if (body.length > MAX_IMAGE_BYTES) throw new ErpNextError('invalid_response', 'Image too large');
    return { contentType, body };
  }
}
