import { randomUUID } from 'node:crypto';
import { error, fail, isHttpError, isRedirect, type ActionFailure } from '@sveltejs/kit';
import { z, ZodError } from 'zod';
import { AuthorizationError, requireCapability, type Actor } from '$lib/server/auth/admin-policy';
import { safeAuditRequestMetadata } from '$lib/server/audit/request-metadata';
import { CatalogDomainError } from '$lib/server/catalog/errors';
import { toAdminTitleDto } from '$lib/server/catalog/titles';

const requestIdSchema = z.string().trim().min(1).max(200);
const uuidSchema = z.uuid();

export class CatalogRouteInputError extends Error {
  constructor(readonly message: string) {
    super(message);
    this.name = 'CatalogRouteInputError';
  }
}

export function requireCatalogPage(actor: Actor): void {
  try {
    requireCapability(actor, 'catalog.manage');
  } catch (cause: unknown) {
    if (cause instanceof AuthorizationError) error(cause.status, cause.status === 401 ? 'Sign in required' : 'Forbidden');
    throw cause;
  }
}

export function requireRouteUuid(value: string | undefined): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) error(404, 'Not found');
  return parsed.data;
}

export async function readScalarForm(request: Request): Promise<Record<string, string>> {
  const form = await request.formData();
  const output: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value !== 'string' || Object.hasOwn(output, name)) {
      throw new CatalogRouteInputError('Form fields are invalid');
    }
    output[name] = value;
  }
  return output;
}

export function commandContext(request: Request, routeId: string | null) {
  const incoming = requestIdSchema.safeParse(request.headers.get('x-request-id'));
  return {
    correlationId: incoming.success ? incoming.data : randomUUID(),
    requestMetadata: safeAuditRequestMetadata(request, routeId)
  };
}

const badRequestCodes = new Set([
  'invalid_upload_format',
  'invalid_preview_boundary',
  'invalid_panel_page',
  'incomplete_guided_view'
]);
const notFoundCodes = new Set([
  'title_not_found',
  'presentation_not_found',
  'cover_suggestion_not_found'
]);

export function catalogActionFailure(cause: unknown): ActionFailure<{ code: string; message: string }> {
  if (isRedirect(cause) || isHttpError(cause)) throw cause;
  if (cause instanceof AuthorizationError) {
    return fail(cause.status, {
      code: cause.code,
      message: cause.status === 401 ? 'Sign in required' : 'Forbidden'
    });
  }
  if (cause instanceof ZodError || cause instanceof CatalogRouteInputError) {
    return fail(400, { code: 'invalid_input', message: 'Check the submitted fields' });
  }
  if (cause instanceof CatalogDomainError) {
    if (notFoundCodes.has(cause.code)) {
      return fail(404, { code: cause.code, message: 'The requested catalog record was not found' });
    }
    if (badRequestCodes.has(cause.code)) {
      return fail(400, { code: cause.code, message: 'The submitted catalog settings are invalid' });
    }
    return fail(409, { code: cause.code, message: 'The catalog changed or the action is not currently available' });
  }
  const databaseCode = typeof cause === 'object' && cause !== null && 'code' in cause
    ? String((cause as { code: unknown }).code)
    : '';
  if (databaseCode === '23505') {
    return fail(409, { code: 'catalog_conflict', message: 'That value is already in use' });
  }
  throw cause;
}

export const safeAdminTitle = toAdminTitleDto;
