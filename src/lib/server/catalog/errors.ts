export type CatalogDomainErrorCode =
  | 'title_not_found'
  | 'parent_revision_not_in_title'
  | 'invalid_upload_format'
  | 'revision_conflict';

export class CatalogDomainError extends Error {
  constructor(readonly code: CatalogDomainErrorCode) {
    super(code);
    this.name = 'CatalogDomainError';
  }
}
