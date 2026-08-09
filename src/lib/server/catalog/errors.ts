export type CatalogDomainErrorCode =
  | 'title_not_found'
  | 'parent_revision_not_in_title'
  | 'invalid_upload_format'
  | 'revision_conflict'
  | 'cover_suggestion_not_found'
  | 'revision_not_editable'
  | 'presentation_not_found'
  | 'stale_presentation'
  | 'invalid_preview_boundary'
  | 'invalid_panel_page'
  | 'incomplete_guided_view'
  | 'publication_precondition'
  | 'retry_source_unavailable';

export class CatalogDomainError extends Error {
  constructor(readonly code: CatalogDomainErrorCode) {
    super(code);
    this.name = 'CatalogDomainError';
  }
}
