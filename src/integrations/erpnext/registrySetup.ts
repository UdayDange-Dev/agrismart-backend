import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REGISTRY_DOCTYPE, REGISTRY_FIELDS, REGISTRY_NAMING_SERIES } from '../../services/userRegistry.js';
import { ErpNextError, type ErpNextClient } from './client.js';

/**
 * Creates the ERPNext side of the E-commerce User registry from the reviewed definitions in
 * erpnext: the two roles, the custom DocType, the number cards and the workspace.
 * It only ever creates what is missing. It never updates, renames or deletes anything, so it
 * cannot change existing ERPNext records. Used by `npm run erpnext:setup-user-registry`.
 */

type Doc = Record<string, unknown>;

export interface RegistryArtifacts {
  roles: Doc[];
  doctype: Doc;
  numberCards: Doc[];
  workspace: Doc;
}

/** Field names that must never exist in the registry (credentials and session material). */
const FORBIDDEN_FIELD = /pass|hash|token|secret|session|cookie|otp|salt/i;

export function loadRegistryArtifacts(dir: string): RegistryArtifacts {
  const read = (file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown;
  const artifacts: RegistryArtifacts = {
    roles: read('roles.json') as Doc[],
    doctype: read('ecommerce-user.doctype.json') as Doc,
    numberCards: read('number-cards.json') as Doc[],
    workspace: read('workspace.json') as Doc,
  };
  validateRegistryArtifacts(artifacts);
  return artifacts;
}

/** Guards against an edited definition that would weaken the design. Throws on any problem. */
export function validateRegistryArtifacts(a: RegistryArtifacts): void {
  const problems: string[] = [];
  const d = a.doctype;
  if (d.name !== REGISTRY_DOCTYPE || d.doctype !== 'DocType') problems.push(`DocType must be named "${REGISTRY_DOCTYPE}"`);
  if (d.custom !== 1) problems.push('DocType must be a custom DocType (custom: 1)');
  // Matches the DocType on the production site (checked read-only on 2026-10-27).
  if (d.autoname !== 'naming_series:') problems.push('DocType must be named by its naming series (autoname "naming_series:")');
  const fields = (d.fields as Doc[] | undefined) ?? [];
  const byName = new Map(fields.map((f) => [String(f.fieldname), f]));
  if (byName.get('naming_series')?.options !== REGISTRY_NAMING_SERIES) problems.push(`Field naming_series must offer ${REGISTRY_NAMING_SERIES}`);
  for (const name of REGISTRY_FIELDS) if (!byName.has(name)) problems.push(`Field ${name} is missing`);
  if (byName.get('registration_date')?.fieldtype !== 'Date') problems.push('Field registration_date must be a Date');
  const statuses = String(byName.get('account_status')?.options ?? '').split('\n').filter(Boolean);
  if (statuses.join(',') !== 'Active,Inactive,Suspended') problems.push('Field account_status must offer exactly Active, Inactive, Suspended');
  for (const f of fields) if (FORBIDDEN_FIELD.test(String(f.fieldname))) problems.push(`Field ${String(f.fieldname)} must not exist`);
  const roleNames = new Set(a.roles.map((r) => String(r.role_name)));
  for (const p of (d.permissions as Doc[] | undefined) ?? []) {
    if (!roleNames.has(String(p.role))) problems.push(`Permission for unexpected role ${String(p.role)}`);
    if (p.delete === 1) problems.push(`Role ${String(p.role)} must not delete E-commerce User records`);
    if (/system manager|administrator/i.test(String(p.role))) problems.push('Do not grant System Manager or Administrator');
  }
  const integration = ((d.permissions as Doc[] | undefined) ?? []).find((p) => p.role === 'E-commerce Integration');
  if (!integration || integration.read !== 1 || integration.create !== 1 || integration.write !== 1) {
    problems.push('E-commerce Integration needs read, create and write');
  }
  for (const c of a.numberCards) if (c.document_type !== REGISTRY_DOCTYPE) problems.push(`Number card ${String(c.name)} must count ${REGISTRY_DOCTYPE}`);
  if (problems.length > 0) throw new Error(`Invalid registry definitions:\n - ${problems.join('\n - ')}`);
}

export interface SetupStep {
  doctype: string;
  name: string;
  status: 'exists' | 'missing' | 'created' | 'failed';
  detail?: string;
}

/** In dependency order: roles before the DocType's permissions, the DocType before its cards. */
export function setupItems(a: RegistryArtifacts): { doctype: string; name: string; doc: Doc }[] {
  return [
    ...a.roles.map((doc) => ({ doctype: 'Role', name: String(doc.role_name), doc })),
    { doctype: 'DocType', name: String(a.doctype.name), doc: a.doctype },
    ...a.numberCards.map((doc) => ({ doctype: 'Number Card', name: String(doc.name), doc })),
    { doctype: 'Workspace', name: String(a.workspace.name), doc: a.workspace },
  ];
}

/**
 * Checks each item (read-only) and, with `apply`, inserts the missing ones in order. Stops at the
 * first failure so later items are not created against a half-built setup.
 */
export async function runRegistrySetup(client: ErpNextClient, a: RegistryArtifacts, opts: { apply: boolean }): Promise<SetupStep[]> {
  const steps: SetupStep[] = [];
  for (const item of setupItems(a)) {
    let exists = true;
    try {
      await client.getDoc(item.doctype, item.name);
    } catch (err) {
      if (!(err instanceof ErpNextError && err.kind === 'not_found')) {
        steps.push({ doctype: item.doctype, name: item.name, status: 'failed', detail: describe(err) });
        return steps;
      }
      exists = false;
    }
    if (exists || !opts.apply) {
      steps.push({ doctype: item.doctype, name: item.name, status: exists ? 'exists' : 'missing' });
      continue;
    }
    try {
      await client.insert(item.doctype, item.doc);
      steps.push({ doctype: item.doctype, name: item.name, status: 'created' });
    } catch (err) {
      steps.push({ doctype: item.doctype, name: item.name, status: 'failed', detail: describe(err) });
      return steps;
    }
  }
  return steps;
}

const describe = (err: unknown) =>
  err instanceof ErpNextError ? `${err.kind}${err.status ? ` (HTTP ${err.status})` : ''}: ${err.message}` : 'unexpected error';
