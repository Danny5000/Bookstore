import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  SALES_CURSOR_MAX_DECODED_BYTES,
  SALES_CURSOR_MAX_ENCODED_LENGTH,
  SALES_CURSOR_ORDER,
  SALES_PAGE_SIZE,
  SalesReportingInputError,
  decodeSalesCursor,
  encodeSalesCursor,
  fingerprintSalesFilters,
  parseSalesOverviewFilters,
  type SalesCursor,
  type SalesOverviewFilters
} from './filters';

const NOW = new Date('2026-08-20T15:24:10.000Z');
const titleId = 'abcdef00-0000-4000-8000-000000000001';

function salesUrl(query = ''): URL {
  return new URL(`https://books.example.test/admin/sales${query ? `?${query}` : ''}`);
}

function expectSafeBadRequest(action: () => unknown): void {
  expect(action).toThrow(new SalesReportingInputError());
  try {
    action();
  } catch (cause: unknown) {
    expect(cause).toMatchObject({ code: 'invalid_request', status: 400 });
    expect(String(cause)).not.toContain(titleId);
  }
}

describe('sales overview filters', () => {
  it('defaults to the prior 30 complete UTC days and a fixed page size', () => {
    expect(parseSalesOverviewFilters(salesUrl(), NOW)).toEqual({
      range: '30',
      from: new Date('2026-07-21T00:00:00.000Z'),
      to: new Date('2026-08-20T00:00:00.000Z'),
      sort: 'gross_desc',
      pageSize: SALES_PAGE_SIZE
    });
    expect(SALES_PAGE_SIZE).toBe(50);
  });

  it.each([
    ['7', '2026-08-13T00:00:00.000Z'],
    ['30', '2026-07-21T00:00:00.000Z'],
    ['90', '2026-05-22T00:00:00.000Z']
  ] as const)('normalizes range=%s to a half-open complete-day interval', (range, from) => {
    expect(parseSalesOverviewFilters(salesUrl(`range=${range}`), NOW)).toMatchObject({
      range,
      from: new Date(from),
      to: new Date('2026-08-20T00:00:00.000Z')
    });
  });

  it('normalizes inclusive custom UTC dates to a half-open interval', () => {
    expect(parseSalesOverviewFilters(
      salesUrl('range=custom&from=2024-02-29&to=2024-03-01'),
      NOW
    )).toEqual({
      range: 'custom',
      from: new Date('2024-02-29T00:00:00.000Z'),
      to: new Date('2024-03-02T00:00:00.000Z'),
      sort: 'gross_desc',
      pageSize: 50
    });
  });

  it('uses no paid-at predicate for all time', () => {
    expect(parseSalesOverviewFilters(salesUrl('range=all'), NOW)).toEqual({
      range: 'all',
      sort: 'gross_desc',
      pageSize: 50
    });
  });

  it('accepts every strict single-value filter in canonical form', () => {
    const url = salesUrl(
      `range=all&titleId=${titleId}&format=comic&presentmentCurrency=USD&` +
      'settlementCurrency=pending&state=exception&sort=title_asc'
    );
    expect(parseSalesOverviewFilters(url, NOW)).toEqual({
      range: 'all',
      titleId,
      format: 'comic',
      presentmentCurrency: 'USD',
      settlementCurrency: 'pending',
      state: 'exception',
      sort: 'title_asc',
      pageSize: 50
    });
  });

  it.each([
    [null, 'pending', true],
    [null, 'fee_reconciled', true],
    [null, 'payout_reconciled', true],
    [null, 'exception', true],
    ['pending', 'pending', true],
    ['pending', 'fee_reconciled', false],
    ['pending', 'payout_reconciled', false],
    ['pending', 'exception', true],
    ['USD', 'pending', true],
    ['USD', 'fee_reconciled', true],
    ['USD', 'payout_reconciled', true],
    ['USD', 'exception', true]
  ] as const)(
    'applies the settlement/state compatibility matrix for %s + %s',
    (settlementCurrency, state, compatible) => {
      const settlementFilter = settlementCurrency === null
        ? ''
        : `&settlementCurrency=${settlementCurrency}`;
      const action = () => parseSalesOverviewFilters(
        salesUrl(`range=all${settlementFilter}&state=${state}`),
        NOW
      );

      if (compatible) {
        const parsed = action();
        expect(parsed).toMatchObject({ state });
        if (settlementCurrency === null) {
          expect(parsed).not.toHaveProperty('settlementCurrency');
        } else {
          expect(parsed).toHaveProperty('settlementCurrency', settlementCurrency);
        }
      } else {
        expectSafeBadRequest(action);
      }
    }
  );

  it.each([
    ['unknown parameter', 'range=30&customerId=private'],
    ['duplicate parameter', 'range=7&range=30'],
    ['blank range', 'range='],
    ['unknown range', 'range=365'],
    ['preset with from', 'range=30&from=2026-01-01'],
    ['preset with to', 'range=7&to=2026-01-01'],
    ['all with dates', 'range=all&from=2026-01-01&to=2026-02-01'],
    ['custom missing from', 'range=custom&to=2026-02-01'],
    ['custom missing to', 'range=custom&from=2026-01-01'],
    ['custom inverted', 'range=custom&from=2026-02-02&to=2026-02-01'],
    ['invalid calendar date', 'range=custom&from=2026-02-30&to=2026-03-01'],
    ['noncanonical date', 'range=custom&from=2026-2-01&to=2026-03-01'],
    ['bad title UUID', 'titleId=not-a-uuid'],
    ['noncanonical title UUID', `titleId=${titleId.toUpperCase()}`],
    ['bad format', 'format=audio'],
    ['lowercase presentment currency', 'presentmentCurrency=usd'],
    ['bad presentment currency', 'presentmentCurrency=ABC'],
    ['unsupported presentment currency semantics', 'presentmentCurrency=IRR'],
    ['bad settlement currency', 'settlementCurrency=ABC'],
    ['unsupported settlement currency semantics', 'settlementCurrency=ISK'],
    ['bad state', 'state=resolved'],
    ['bad sort', 'sort=newest'],
    ['unsafe control value', 'presentmentCurrency=%00USD'],
    ['extra page size', 'pageSize=5000']
  ])('rejects %s with a safe 400', (_label, query) => {
    expectSafeBadRequest(() => parseSalesOverviewFilters(salesUrl(query), NOW));
  });

  it('rejects an invalid clock without reflecting it', () => {
    expectSafeBadRequest(() => parseSalesOverviewFilters(salesUrl(), new Date('invalid')));
  });
});

describe('sales cursor codec and filter fingerprint', () => {
  function baseFilters(): SalesOverviewFilters {
    return parseSalesOverviewFilters(
      salesUrl(`range=all&titleId=${titleId}&presentmentCurrency=USD&sort=gross_desc`),
      NOW
    );
  }

  function cursorFor(filters = baseFilters()): SalesCursor {
    return {
      filterFingerprint: fingerprintSalesFilters(filters),
      primary: -1_234,
      titleId,
      presentmentCurrency: 'USD',
      settlementCurrency: ''
    };
  }

  it('round-trips the stable primary/title/currency tuple in canonical base64url', () => {
    const cursor = cursorFor();
    const encoded = encodeSalesCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(encoded.length).toBeLessThanOrEqual(SALES_CURSOR_MAX_ENCODED_LENGTH);
    expect(decodeSalesCursor(encoded, cursor.filterFingerprint)).toEqual(cursor);
    expect(SALES_CURSOR_ORDER).toEqual([
      'primary', 'titleId', 'presentmentCurrency', 'settlementCurrency'
    ]);
  });

  it('exports the exact encoded and decoded cursor bounds', () => {
    expect(SALES_CURSOR_MAX_ENCODED_LENGTH).toBe(2_674);
    expect(SALES_CURSOR_MAX_DECODED_BYTES).toBe(2_005);
  });

  it('losslessly accepts the exact worst-case 300-code-unit catalog title boundary', () => {
    const filters = parseSalesOverviewFilters(salesUrl('range=all&sort=title_asc'), NOW);
    const cursor: SalesCursor = {
      filterFingerprint: fingerprintSalesFilters(filters),
      primary: '\u0001'.repeat(300),
      titleId,
      presentmentCurrency: 'BHD',
      settlementCurrency: 'USD'
    };
    const json = JSON.stringify(cursor);
    const decodedBytes = Buffer.from(json, 'utf8');
    const encoded = decodedBytes.toString('base64url');

    expect(Object.keys(JSON.parse(json))).toEqual([
      'filterFingerprint',
      'primary',
      'titleId',
      'presentmentCurrency',
      'settlementCurrency'
    ]);
    expect(decodedBytes.length).toBe(SALES_CURSOR_MAX_DECODED_BYTES);
    expect(encoded.length).toBe(SALES_CURSOR_MAX_ENCODED_LENGTH);
    expect(encodeSalesCursor(cursor)).toBe(encoded);
    expect(decodeSalesCursor(encoded, cursor.filterFingerprint)).toEqual(cursor);
    expect(
      parseSalesOverviewFilters(
        salesUrl(`range=all&sort=title_asc&cursor=${encoded}`),
        NOW
      ).cursor
    ).toEqual(cursor);
  });

  it('round-trips a 300-code-unit ASCII catalog title', () => {
    const filters = parseSalesOverviewFilters(salesUrl('range=all&sort=title_asc'), NOW);
    const cursor: SalesCursor = {
      filterFingerprint: fingerprintSalesFilters(filters),
      primary: 'A'.repeat(300),
      titleId,
      presentmentCurrency: 'USD',
      settlementCurrency: ''
    };

    expect(decodeSalesCursor(encodeSalesCursor(cursor), cursor.filterFingerprint)).toEqual(cursor);
  });

  it('rejects 2,675 encoded characters before attempting base64url decoding', () => {
    const bufferFrom = vi.spyOn(Buffer, 'from');

    try {
      expectSafeBadRequest(() =>
        decodeSalesCursor(
          'A'.repeat(SALES_CURSOR_MAX_ENCODED_LENGTH + 1),
          cursorFor().filterFingerprint
        )
      );
      expect(bufferFrom).not.toHaveBeenCalled();
    } finally {
      bufferFrom.mockRestore();
    }
  });

  it('rejects 301 UTF-16 title code units even below the encoded byte ceiling', () => {
    const cursor: SalesCursor = {
      ...cursorFor(),
      primary: 'A'.repeat(301)
    };
    const encoded = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
    expect(encoded.length).toBeLessThan(SALES_CURSOR_MAX_ENCODED_LENGTH);
    expectSafeBadRequest(() => encodeSalesCursor(cursor));
  });

  it('accepts a bounded title primary for title_asc ordering', () => {
    const filters = parseSalesOverviewFilters(salesUrl('range=all&sort=title_asc'), NOW);
    const cursor: SalesCursor = {
      filterFingerprint: fingerprintSalesFilters(filters),
      primary: 'A Pale Orbit',
      titleId,
      presentmentCurrency: 'BHD',
      settlementCurrency: 'USD'
    };
    expect(decodeSalesCursor(encodeSalesCursor(cursor), cursor.filterFingerprint)).toEqual(cursor);
  });

  it.each([
    ['gross_desc', 'A Pale Orbit'],
    ['title_asc', -1_234]
  ] as const)(
    'rejects a %s cursor whose primary has the other sort runtime type',
    (sort, primary) => {
      const filters = parseSalesOverviewFilters(salesUrl(`range=all&sort=${sort}`), NOW);
      const cursor: SalesCursor = {
        filterFingerprint: fingerprintSalesFilters(filters),
        primary,
        titleId,
        presentmentCurrency: 'USD',
        settlementCurrency: ''
      };
      const url = salesUrl(`range=all&sort=${sort}&cursor=${encodeSalesCursor(cursor)}`);

      expectSafeBadRequest(() => parseSalesOverviewFilters(url, NOW));
    }
  );

  it.each([
    ['leading whitespace', ' Pale Orbit'],
    ['trailing whitespace', 'Pale Orbit ']
  ] as const)(
    'losslessly round-trips an exact stored title with %s',
    (_label, primary) => {
      const filters = parseSalesOverviewFilters(salesUrl('range=all&sort=title_asc'), NOW);
      const cursor: SalesCursor = {
        filterFingerprint: fingerprintSalesFilters(filters),
        primary,
        titleId,
        presentmentCurrency: 'USD',
        settlementCurrency: ''
      };
      const encoded = encodeSalesCursor(cursor);

      expect(decodeSalesCursor(encoded, cursor.filterFingerprint)).toEqual(cursor);
      expect(
        parseSalesOverviewFilters(
          salesUrl(`range=all&sort=title_asc&cursor=${encoded}`),
          NOW
        ).cursor
      ).toEqual(cursor);
    }
  );

  it('preserves a valid decomposed stored title primary', () => {
    const filters = parseSalesOverviewFilters(salesUrl('range=all&sort=title_asc'), NOW);
    const cursor: SalesCursor = {
      filterFingerprint: fingerprintSalesFilters(filters),
      primary: 'Cafe\u0301',
      titleId,
      presentmentCurrency: 'USD',
      settlementCurrency: ''
    };

    const encoded = encodeSalesCursor(cursor);
    expect(decodeSalesCursor(encoded, cursor.filterFingerprint)).toEqual(cursor);
  });

  it.each([
    [
      'whitespace JSON',
      JSON.stringify(cursorFor(), null, 2)
    ],
    [
      'reordered JSON properties',
      JSON.stringify({
        primary: cursorFor().primary,
        filterFingerprint: cursorFor().filterFingerprint,
        titleId: cursorFor().titleId,
        presentmentCurrency: cursorFor().presentmentCurrency,
        settlementCurrency: cursorFor().settlementCurrency
      })
    ],
    [
      'alternate numeric notation',
      JSON.stringify(cursorFor()).replace('"primary":-1234', '"primary":-1.234e3')
    ]
  ] as const)(
    'rejects a cursor encoded from %s when canonical re-encoding differs',
    (_label, json) => {
      const encoded = Buffer.from(json, 'utf8').toString('base64url');
      expectSafeBadRequest(() =>
        decodeSalesCursor(encoded, cursorFor().filterFingerprint)
      );
    }
  );

  it('binds a cursor to the complete normalized filter fingerprint', () => {
    const filters = baseFilters();
    const encoded = encodeSalesCursor(cursorFor(filters));
    const changed = parseSalesOverviewFilters(
      salesUrl(`range=all&titleId=${titleId}&presentmentCurrency=EUR&sort=gross_desc`),
      NOW
    );
    expectSafeBadRequest(() =>
      decodeSalesCursor(encoded, fingerprintSalesFilters(changed))
    );
  });

  it('parses a correctly bound cursor but excludes it from its own fingerprint', () => {
    const filters = baseFilters();
    const fingerprint = fingerprintSalesFilters(filters);
    const url = salesUrl(
      `range=all&titleId=${titleId}&presentmentCurrency=USD&sort=gross_desc&` +
      `cursor=${encodeSalesCursor(cursorFor(filters))}`
    );
    const parsed = parseSalesOverviewFilters(url, NOW);
    expect(parsed.cursor).toEqual(cursorFor(filters));
    expect(fingerprintSalesFilters(parsed)).toBe(fingerprint);
  });

  it.each([
    ['range', { range: '30' }],
    ['from', { from: new Date('2026-08-02T00:00:00.000Z') }],
    ['to', { to: new Date('2026-08-12T00:00:00.000Z') }],
    ['titleId', { titleId: 'abcdef00-0000-4000-8000-000000000002' }],
    ['format', { format: 'comic' }],
    ['presentmentCurrency', { presentmentCurrency: 'EUR' }],
    ['settlementCurrency', { settlementCurrency: 'USD' }],
    ['state', { state: 'payout_reconciled' }],
    ['sort', { sort: 'title_asc' }],
    ['pageSize', { pageSize: 51 as typeof SALES_PAGE_SIZE }]
  ] as const)(
    'changes the fingerprint when only %s changes',
    (_dimension, change) => {
      const baseline: SalesOverviewFilters = {
        range: 'custom',
        from: new Date('2026-08-01T00:00:00.000Z'),
        to: new Date('2026-08-11T00:00:00.000Z'),
        titleId,
        format: 'prose',
        presentmentCurrency: 'USD',
        settlementCurrency: 'EUR',
        state: 'fee_reconciled',
        sort: 'gross_desc',
        pageSize: SALES_PAGE_SIZE
      };
      const changed = { ...baseline, ...change } as SalesOverviewFilters;

      expect(fingerprintSalesFilters(baseline)).toMatch(/^[a-f0-9]{64}$/u);
      expect(fingerprintSalesFilters(changed)).not.toBe(fingerprintSalesFilters(baseline));
    }
  );

  it('fingerprints equal normalized values deterministically and deliberately excludes cursor', () => {
    const baseline = baseFilters();
    const same = baseFilters();
    const fingerprint = fingerprintSalesFilters(baseline);

    expect(fingerprintSalesFilters(same)).toBe(fingerprint);
    expect(fingerprintSalesFilters({ ...baseline, cursor: cursorFor(baseline) })).toBe(fingerprint);
  });

  it.each([
    ['malformed base64url', 'not+base64url'],
    ['noncanonical padding', `${Buffer.from('{}').toString('base64url')}=`],
    ['invalid JSON', Buffer.from('{').toString('base64url')],
    ['extra payload key', Buffer.from(JSON.stringify({
      ...cursorFor(), customerId: randomUUID()
    })).toString('base64url')],
    ['uppercase cursor UUID', Buffer.from(JSON.stringify({
      ...cursorFor(), titleId: titleId.toUpperCase()
    })).toString('base64url')],
    ['unsafe numeric primary', Buffer.from(JSON.stringify({
      ...cursorFor(), primary: Number.MAX_SAFE_INTEGER + 1
    })).toString('base64url')],
    ['bad cursor currency', Buffer.from(JSON.stringify({
      ...cursorFor(), presentmentCurrency: 'ABC'
    })).toString('base64url')]
  ])('rejects %s with a safe 400', (_label, value) => {
    expectSafeBadRequest(() =>
      decodeSalesCursor(value, cursorFor().filterFingerprint)
    );
  });
});
