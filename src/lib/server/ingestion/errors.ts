export type IngestionFailureCode =
  | 'upload_limit'
  | 'archive_structure'
  | 'archive_unsafe_path'
  | 'archive_path_collision'
  | 'archive_symlink'
  | 'archive_encrypted'
  | 'archive_unsupported_compression'
  | 'archive_entry_count'
  | 'archive_expanded_size'
  | 'archive_entry_size'
  | 'archive_compression_ratio'
  | 'archive_size_mismatch'
  | 'archive_crc_mismatch'
  | 'archive_closed'
  | 'xml_limit'
  | 'xml_syntax'
  | 'xml_unsafe_declaration'
  | 'epub_mimetype'
  | 'epub_container'
  | 'epub_package'
  | 'epub_spine'
  | 'epub_navigation'
  | 'epub_content'
  | 'unsupported_format'
  | 'unsupported_media'
  | 'unsupported_fixed_layout'
  | 'unsupported_script'
  | 'unsupported_drm'
  | 'unsupported_svg'
  | 'image_decode'
  | 'image_pixels'
  | 'comic_ambiguous_page_order'
  | 'comic_empty'
  | 'ingestion_timeout'
  | 'ingestion_aborted'
  | 'missing_staged_source'
  | 'storage_transient'
  | 'database_transient';

export class IngestionError extends Error {
  constructor(
    readonly code: IngestionFailureCode,
    readonly safeMessage: string,
    readonly retryable: boolean,
    options?: ErrorOptions
  ) {
    super(safeMessage, options);
    this.name = 'IngestionError';
  }
}

export interface IngestionWarning {
  code: string;
  safeMessage: string;
}
