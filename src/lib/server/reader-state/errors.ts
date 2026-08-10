export class ReaderStateNotFoundError extends Error {
  readonly code = 'reader_state_not_found';

  constructor() {
    super('Reader state resource not found');
    this.name = 'ReaderStateNotFoundError';
  }
}

export class InvalidReaderLocationError extends Error {
  readonly code = 'invalid_reader_location';

  constructor() {
    super('Reader location is invalid');
    this.name = 'InvalidReaderLocationError';
  }
}

export class ActiveRevisionChangedError extends Error {
  readonly code = 'active_revision_changed';

  constructor() {
    super('The active publication changed');
    this.name = 'ActiveRevisionChangedError';
  }
}

export class StaleReaderStateError<Value> extends Error {
  readonly code = 'STALE_VERSION';

  constructor(readonly current: Value) {
    super('Reader state version is stale');
    this.name = 'StaleReaderStateError';
  }
}
