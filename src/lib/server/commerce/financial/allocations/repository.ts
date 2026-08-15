import { sql, type SQL } from 'drizzle-orm';
import type { DatabaseExecutor, DatabaseTransaction } from '$lib/server/db/transaction';
import type {
  CurrentEffectiveAllocationItem, CurrentEffectiveAllocationProjection,
  FinancialComponent, PersistFinancialAllocationPlanInput
} from '../types';
import { PermanentFinancialError } from '../errors';
import { FINANCIAL_ALLOCATION_ALGORITHM_VERSION, FINANCIAL_CLASSIFIER_VERSION } from '../constants';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FP = /^[a-f0-9]{64}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const SAFE_MONEY = 99_999_999;
const COMPONENTS = new Set<FinancialComponent>(['sale_subtotal','sale_tax','processing_fee','refund_subtotal','refund_tax','refund_fee','refund_failure_reversal','dispute_subtotal','dispute_tax','dispute_fee','dispute_reinstatement','provider_fee_tax','fee_credit','other']);
const ISSUE_CODES = new Set(['missing_source','allocation_incomplete','allocation_fork','allocation_mismatch','classification_fork','correction_rebase_required','currency_mismatch','immutable_mismatch','source_linkage_mismatch','unsupported_category']);

type Result = { rows?: unknown[] };
async function rows(executor: DatabaseExecutor, query: SQL): Promise<unknown[]> {
  return ((await executor.execute(query)) as Result).rows ?? [];
}
function fail(code: 'source_linkage_mismatch'|'allocation_mismatch'|'currency_mismatch'): never { throw new PermanentFinancialError(code); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && ownKeys.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key));
}
function money(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= -SAFE_MONEY && (value as number) <= SAFE_MONEY; }
function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left); const b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}
function isBoundedAllocationSetCollision(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; constraint?: unknown; cause?: unknown };
  if (candidate.code === '23505' && (
    candidate.constraint === 'financial_allocation_sets_identity_unique' ||
    candidate.constraint === 'financial_allocation_sets_reversal_root_unique'
  )) return true;
  return candidate.cause !== error && isBoundedAllocationSetCollision(candidate.cause);
}

interface AuthorizedProjectionVersion {
  readonly classifierVersion: number;
  readonly allocationAlgorithmVersion: number;
}

function validate(
  input: PersistFinancialAllocationPlanInput,
  authorized: AuthorizedProjectionVersion
): void {
  if (!exact(input, ['plan','sourceKind','sourceId','classificationVersion','correlationId'])) fail('source_linkage_mismatch');
  const plan = input.plan;
  if (!exact(plan, ['allocationIdentity','balanceTransactionId','basis','scope','currency','expectedEffectMinor','algorithmVersion','sourceFingerprint','supersedesSetId','reversalOfSetId','items'])) fail('source_linkage_mismatch');
  if (!['payment','refund','dispute','payout','adjustment'].includes(input.sourceKind) || !UUID.test(input.sourceId) ||
      input.classificationVersion !== authorized.classifierVersion ||
      typeof input.correlationId !== 'string' || input.correlationId.length < 1 || input.correlationId.length > 100 ||
      typeof plan.allocationIdentity !== 'string' || plan.allocationIdentity.length < 1 || plan.allocationIdentity.length > 255 ||
      !UUID.test(plan.balanceTransactionId) || !['gross_amount','fee'].includes(plan.basis) || !['title','account','unresolved'].includes(plan.scope) ||
      !CURRENCY.test(plan.currency) || !money(plan.expectedEffectMinor) ||
      plan.algorithmVersion !== authorized.allocationAlgorithmVersion ||
      !FP.test(plan.sourceFingerprint) || (plan.supersedesSetId !== null && !UUID.test(plan.supersedesSetId)) ||
      (plan.reversalOfSetId !== null && !UUID.test(plan.reversalOfSetId)) || !Array.isArray(plan.items) || plan.items.length > 100) fail('source_linkage_mismatch');
  if (plan.supersedesSetId !== null && plan.supersedesSetId === plan.reversalOfSetId) fail('source_linkage_mismatch');
  const decisions = new Set<string>(); const ties = new Set<string>(); let total = 0n;
  for (const item of plan.items) {
    if (!exact(item, ['orderItemId','component','effectMinor','currency','tieBreakKey']) || typeof item.orderItemId !== 'string' || !UUID.test(item.orderItemId) ||
        !COMPONENTS.has(item.component as FinancialComponent) || !money(item.effectMinor) || item.currency !== plan.currency ||
        typeof item.tieBreakKey !== 'string' || item.tieBreakKey.length < 1 || item.tieBreakKey.length > 255) fail('allocation_mismatch');
    const decision = `${item.orderItemId}:${item.component}`;
    if (decisions.has(decision) || ties.has(item.tieBreakKey)) fail('allocation_mismatch');
    decisions.add(decision); ties.add(item.tieBreakKey); total += BigInt(item.effectMinor);
  }
  if ((plan.scope === 'title' && ((plan.items.length === 0 && plan.expectedEffectMinor !== 0) || total !== BigInt(plan.expectedEffectMinor))) ||
      (plan.scope !== 'title' && plan.items.length !== 0)) fail('allocation_mismatch');
  if (input.sourceKind === 'adjustment' && (input.sourceId !== plan.balanceTransactionId || plan.scope !== 'account')) fail('source_linkage_mismatch');
  if (input.sourceKind === 'payout' && plan.scope !== 'account') fail('source_linkage_mismatch');
}

interface SetRow { id: string; allocationIdentity: string; balanceTransactionId: string; sourceKind: string; sourceId: string; basis: string; scope: string; expectedEffectMinor: number; currency: string; algorithmVersion: number; classifierVersion: number; sourceFingerprint: string; supersedesSetId: string|null; reversalOfSetId: string|null }
async function persistFinancialAllocationPlanForVersionLocked(
  tx: DatabaseTransaction,
  input: PersistFinancialAllocationPlanInput,
  authorized: AuthorizedProjectionVersion
): Promise<{setId:string;disposition:'inserted'|'unchanged'}> {
  validate(input, authorized); const p=input.plan;
  await rows(tx, sql`select pg_advisory_xact_lock(hashtextextended(${`pale-orbit:financial:allocation:${p.balanceTransactionId}:${p.basis}`}, 0))`);
  const bt = (await rows(tx, sql`select id, amount_minor as "amountMinor", fee_minor as "feeMinor", currency, fingerprint_sha256 as fingerprint, source_family as "providerSourceFamily", source_id as "providerSourceId" from stripe_balance_transactions where id=${p.balanceTransactionId} for update`))[0] as {amountMinor:number;feeMinor:number;currency:string;fingerprint:string;providerSourceFamily:string|null;providerSourceId:string|null}|undefined;
  if (!bt || bt.fingerprint!==p.sourceFingerprint) fail('source_linkage_mismatch');
  if (bt.currency!==p.currency) fail('currency_mismatch');
  if ((p.basis==='gross_amount'?bt.amountMinor:-bt.feeMinor)!==p.expectedEffectMinor) fail('allocation_mismatch');
  const classifications=await rows(tx, sql`select id, classification from financial_classification_versions where subject_type='balance_transaction' and subject_id=${p.balanceTransactionId} and classifier_version=${input.classificationVersion} and source_fingerprint_sha256=${p.sourceFingerprint} and classification <> 'unknown' for update`) as Array<{id:string;classification:string}>;
  if (classifications.length!==1) fail('source_linkage_mismatch');
  const classification=classifications[0]!.classification;
  const detailClassification = (await rows(tx, sql`
    select count(distinct fd.id)::integer as "detailCount",
      count(cv.id) filter (where cv.classification <> 'unknown')::integer as "classifiedCount",
      count(cv.id) filter (where cv.classification = 'unknown')::integer as "unknownCount",
      (select coalesce(sum(detail.amount_minor), 0)::text from stripe_balance_transaction_fee_details detail where detail.balance_transaction_id=${p.balanceTransactionId}) as "detailAmountSum",
      (select count(*)::integer from stripe_balance_transaction_fee_details detail where detail.balance_transaction_id=${p.balanceTransactionId} and detail.currency <> ${bt.currency}) as "currencyMismatchCount"
    from stripe_balance_transaction_fee_details fd
    left join financial_classification_versions cv
      on cv.subject_type = 'fee_detail' and cv.subject_id = fd.id
      and cv.classifier_version = ${input.classificationVersion}
      and cv.source_fingerprint_sha256 = fd.fingerprint_sha256
    where fd.balance_transaction_id = ${p.balanceTransactionId}
  `))[0] as {detailCount:number;classifiedCount:number;unknownCount:number;detailAmountSum:string;currencyMismatchCount:number}|undefined;
  if (!detailClassification || detailClassification.classifiedCount !== detailClassification.detailCount ||
      detailClassification.unknownCount !== 0 || detailClassification.currencyMismatchCount !== 0 ||
      BigInt(detailClassification.detailAmountSum) !== BigInt(bt.feeMinor)) fail('source_linkage_mismatch');
  let linked: unknown[];
  if (input.sourceKind === 'payment') linked = await rows(tx, sql`select id, order_id as "orderId" from payments where id=${input.sourceId} and stripe_latest_charge_id=${bt.providerSourceId} and ${bt.providerSourceFamily}='charge'`);
  else if (input.sourceKind === 'refund') linked = await rows(tx, sql`select refund.id, payment.order_id as "orderId" from refunds refund join payments payment on payment.id=refund.payment_id where refund.id=${input.sourceId} and refund.stripe_refund_id=${bt.providerSourceId} and ${bt.providerSourceFamily}='refund'`);
  else if (input.sourceKind === 'dispute') linked = await rows(tx, sql`select dispute.id, payment.order_id as "orderId" from disputes dispute join payments payment on payment.id=dispute.payment_id where dispute.id=${input.sourceId} and dispute.stripe_dispute_id=${bt.providerSourceId} and ${bt.providerSourceFamily}='dispute'`);
  else if (input.sourceKind === 'payout') linked = await rows(tx, sql`select id from stripe_payouts where id=${input.sourceId} and provider_id=${bt.providerSourceId} and ${bt.providerSourceFamily}='payout'`);
  else linked = input.sourceId === p.balanceTransactionId && p.scope === 'account' ? [{ id: input.sourceId }] : [];
  if (linked.length !== 1) fail('source_linkage_mismatch');
  if (p.scope === 'title') {
    const orderId = (linked[0] as {orderId?: unknown}).orderId;
    if (typeof orderId !== 'string' || !UUID.test(orderId)) fail('source_linkage_mismatch');
    const itemIds = [...new Set(p.items.map((item) => item.orderItemId))];
    if (itemIds.length > 0) {
      const owned = await rows(tx, sql`select id from order_items where order_id=${orderId} and id in ${itemIds}`);
      if (owned.length !== itemIds.length) fail('source_linkage_mismatch');
    }
  }
  const existing=(await rows(tx, sql`select id, allocation_identity as "allocationIdentity", balance_transaction_id as "balanceTransactionId", source_kind as "sourceKind", source_internal_id as "sourceId", basis, scope, expected_effect_minor as "expectedEffectMinor", currency, algorithm_version as "algorithmVersion", classifier_version as "classifierVersion", source_fingerprint_sha256 as "sourceFingerprint", supersedes_set_id as "supersedesSetId", reversal_of_set_id as "reversalOfSetId" from financial_allocation_sets where allocation_identity=${p.allocationIdentity} for update`))[0] as SetRow|undefined;
  if (existing) {
    const same=existing.balanceTransactionId===p.balanceTransactionId&&existing.sourceKind===input.sourceKind&&existing.sourceId===input.sourceId&&existing.basis===p.basis&&existing.scope===p.scope&&existing.expectedEffectMinor===p.expectedEffectMinor&&existing.currency===p.currency&&existing.algorithmVersion===p.algorithmVersion&&existing.classifierVersion===input.classificationVersion&&existing.sourceFingerprint===p.sourceFingerprint&&existing.supersedesSetId===p.supersedesSetId&&existing.reversalOfSetId===p.reversalOfSetId;
    if(!same) fail('source_linkage_mismatch');
    const stored=await rows(tx, sql`select order_item_id as "orderItemId", component, effect_minor as "effectMinor", currency, tie_break_key as "tieBreakKey" from financial_item_allocations where allocation_set_id=${existing.id} for update`);
    stored.sort((left,right)=>{const a=left as typeof p.items[number];const b=right as typeof p.items[number];return compareCodePoints(a.tieBreakKey,b.tieBreakKey)||compareCodePoints(a.orderItemId,b.orderItemId)||compareCodePoints(a.component,b.component);});
    const wanted=[...p.items].sort((a,b)=>compareCodePoints(a.tieBreakKey,b.tieBreakKey)||compareCodePoints(a.orderItemId,b.orderItemId)||compareCodePoints(a.component,b.component));
    const sameItems = stored.length === wanted.length && stored.every((value, index) => {
      const actual = value as typeof p.items[number]; const expected = wanted[index]!;
      return actual.orderItemId === expected.orderItemId && actual.component === expected.component &&
        actual.effectMinor === expected.effectMinor && actual.currency === expected.currency &&
        actual.tieBreakKey === expected.tieBreakKey;
    });
    if(!sameItems) fail('allocation_mismatch');
    return {setId:existing.id,disposition:'unchanged'};
  }
  const currentTips = await rows(tx, sql`
    select candidate.id from financial_allocation_sets candidate
    where candidate.balance_transaction_id=${p.balanceTransactionId} and candidate.basis=${p.basis}
      and candidate.source_fingerprint_sha256=${p.sourceFingerprint}
      and not exists(select 1 from financial_allocation_sets successor where successor.supersedes_set_id=candidate.id)
    for update
  `);
  if (currentTips.length > 1 || (p.supersedesSetId === null ? currentTips.length !== 0 :
      currentTips.length !== 1 || (currentTips[0] as {id?:unknown}).id !== p.supersedesSetId)) fail('source_linkage_mismatch');
  let reversalTarget: {id:string;supersedesSetId:string|null}|undefined;
  if(p.reversalOfSetId){
    await rows(tx,sql`select pg_advisory_xact_lock(hashtextextended(${`pale-orbit:financial:allocation-reversal:${p.reversalOfSetId}`}, 0))`);
    const reversal=await rows(tx,sql`select target.id, target.supersedes_set_id as "supersedesSetId", (select root.id from financial_allocation_sets root where root.reversal_of_set_id=target.id and root.supersedes_set_id is null order by root.id limit 1) as "existingRootId" from financial_allocation_sets target where target.id=${p.reversalOfSetId} and target.source_kind=${input.sourceKind} and target.source_internal_id=${input.sourceId} and target.basis=${p.basis} and target.currency=${p.currency} and target.reversal_of_set_id is null and target.classifier_version=${input.classificationVersion} and target.algorithm_version=${p.algorithmVersion} for update of target`) as Array<{id:string;supersedesSetId:string|null;existingRootId:string|null}>;
    if(reversal.length!==1 || (p.supersedesSetId===null && (reversal[0] as {existingRootId?:unknown}).existingRootId != null)) fail('source_linkage_mismatch');
    reversalTarget=reversal[0];
  }
  if(p.supersedesSetId){
    const tips=await rows(tx,sql`select id, source_kind as "sourceKind", source_internal_id as "sourceId", scope, reversal_of_set_id as "reversalOfSetId", classifier_version as "classifierVersion", algorithm_version as "algorithmVersion" from financial_allocation_sets predecessor where id=${p.supersedesSetId} and balance_transaction_id=${p.balanceTransactionId} and basis=${p.basis} and currency=${p.currency} and expected_effect_minor=${p.expectedEffectMinor} and source_fingerprint_sha256=${p.sourceFingerprint} and not exists(select 1 from financial_allocation_sets successor where successor.supersedes_set_id=predecessor.id) for update`) as Array<{id:string;sourceKind:string;sourceId:string;scope:string;reversalOfSetId:string|null;classifierVersion:number;algorithmVersion:number}>;
    const predecessor=tips[0];
    if(tips.length!==1 || !predecessor || predecessor.classifierVersion>input.classificationVersion ||
      predecessor.algorithmVersion>p.algorithmVersion) fail('source_linkage_mismatch');
    const sameOwner=predecessor.sourceKind===input.sourceKind&&predecessor.sourceId===input.sourceId;
    const sameReversal=predecessor.reversalOfSetId===p.reversalOfSetId;
    const advancedReversal=sameOwner&&predecessor.reversalOfSetId!==null&&
      p.reversalOfSetId!==null&&reversalTarget?.supersedesSetId===predecessor.reversalOfSetId;
    const nullReversalTakeover=p.reversalOfSetId===null&&(
      (input.sourceKind==='payment'&&classification==='charge'&&bt.amountMinor>0)||
      (input.sourceKind==='refund'&&(
        (classification==='refund'&&bt.amountMinor<0)||
        (classification==='refund_failure'&&bt.amountMinor>0)
      ))||
      (input.sourceKind==='dispute'&&(
        (classification==='dispute_withdrawal'&&bt.amountMinor<0)||
        (['dispute_reinstatement','fee_credit'].includes(classification)&&bt.amountMinor>0)
      ))
    );
    const positiveReversalTakeover=p.reversalOfSetId!==null&&p.basis==='gross_amount'&&
      p.expectedEffectMinor>0&&bt.amountMinor>0&&(
        (input.sourceKind==='refund'&&classification==='refund_failure')||
        (input.sourceKind==='dispute'&&classification==='dispute_reinstatement')
      );
    const accountTakeover=predecessor.sourceKind==='adjustment'&&
      predecessor.sourceId===p.balanceTransactionId&&predecessor.scope==='account'&&
      predecessor.reversalOfSetId===null&&(nullReversalTakeover||positiveReversalTakeover);
    if(!((sameOwner&&(sameReversal||advancedReversal))||accountTakeover)) {
      fail('source_linkage_mismatch');
    }
  }
  let inserted: {id:string}|undefined;
  try {
    inserted=(await rows(tx,sql`insert into financial_allocation_sets(allocation_identity,balance_transaction_id,source_kind,source_internal_id,basis,scope,expected_effect_minor,currency,algorithm_version,classifier_version,source_fingerprint_sha256,supersedes_set_id,reversal_of_set_id) values(${p.allocationIdentity},${p.balanceTransactionId},${input.sourceKind},${input.sourceId},${p.basis},${p.scope},${p.expectedEffectMinor},${p.currency},${p.algorithmVersion},${input.classificationVersion},${p.sourceFingerprint},${p.supersedesSetId},${p.reversalOfSetId}) returning id`))[0] as {id:string}|undefined;
  } catch (error) {
    if (isBoundedAllocationSetCollision(error)) fail('source_linkage_mismatch');
    throw error;
  }
  if(!inserted) throw new Error('allocation set insert returned no row');
  for(const item of [...p.items].sort((a,b)=>compareCodePoints(a.tieBreakKey,b.tieBreakKey)||compareCodePoints(a.orderItemId,b.orderItemId)||compareCodePoints(a.component,b.component))) await rows(tx,sql`insert into financial_item_allocations(allocation_set_id,order_item_id,component,effect_minor,currency,tie_break_key) values(${inserted.id},${item.orderItemId},${item.component},${item.effectMinor},${item.currency},${item.tieBreakKey})`);
  return {setId:inserted.id,disposition:'inserted'};
}

export async function persistFinancialAllocationPlanLocked(
  tx: DatabaseTransaction,
  input: PersistFinancialAllocationPlanInput
): Promise<{setId:string;disposition:'inserted'|'unchanged'}> {
  return persistFinancialAllocationPlanForVersionLocked(tx, input, {
    classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
    allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
  });
}

export async function persistFinancialAllocationReplayPlanLocked(
  tx: DatabaseTransaction,
  input: PersistFinancialAllocationPlanInput,
  authorized: AuthorizedProjectionVersion
): Promise<{setId:string;disposition:'inserted'|'unchanged'}> {
  if (!exact(authorized, ['classifierVersion', 'allocationAlgorithmVersion']) ||
    !Number.isSafeInteger(authorized.classifierVersion) || authorized.classifierVersion < 1 ||
    authorized.classifierVersion > 2_147_483_647 ||
    !Number.isSafeInteger(authorized.allocationAlgorithmVersion) ||
    authorized.allocationAlgorithmVersion < 1 ||
    authorized.allocationAlgorithmVersion > 2_147_483_647) fail('source_linkage_mismatch');
  return persistFinancialAllocationPlanForVersionLocked(tx, input, authorized);
}

export async function loadCurrentEffectiveAllocationProjection(executor: DatabaseExecutor,input:{balanceTransactionIds:readonly string[]}):Promise<readonly CurrentEffectiveAllocationProjection[]> {
  if(!exact(input,['balanceTransactionIds'])||!Array.isArray(input.balanceTransactionIds)||input.balanceTransactionIds.length>100||input.balanceTransactionIds.some(id=>!UUID.test(id))||new Set(input.balanceTransactionIds).size!==input.balanceTransactionIds.length) fail('source_linkage_mismatch');
  const ids=[...input.balanceTransactionIds].sort(); if(ids.length===0)return [];
  const heads=await rows(executor,sql`select balance_transaction_id as "balanceTransactionId", basis, base_set_id as "baseSetId", compatible_correction_tip_id as "compatibleCorrectionTipId", scope, currency, expected_effect_minor as "expectedEffectMinor", is_complete as "isComplete", missing_source_count as "missingSourceCount", proposed_issue_code as "proposedIssueCode" from current_financial_projection_heads where balance_transaction_id in ${ids} order by balance_transaction_id, case basis when 'gross_amount' then 0 else 1 end`);
  const items=await rows(executor,sql`select balance_transaction_id as "balanceTransactionId", basis, base_set_id as "baseSetId", compatible_correction_tip_id as "compatibleCorrectionTipId", order_item_id as "orderItemId", component, effect_minor as "effectMinor", currency from current_financial_projection_items where balance_transaction_id in ${ids} order by balance_transaction_id, case basis when 'gross_amount' then 0 else 1 end, order_item_id, component`);
  type Head={balanceTransactionId:string;basis:'gross_amount'|'fee';baseSetId:string|null;compatibleCorrectionTipId:string|null;scope:'title'|'account'|'unresolved'|null;currency:string|null;expectedEffectMinor:number|null;isComplete:boolean;proposedIssueCode:string|null};
  type Item={balanceTransactionId:string;basis:'gross_amount'|'fee';baseSetId:string;compatibleCorrectionTipId:string|null;orderItemId:string;component:FinancialComponent;effectMinor:number;currency:string};
  const byKey=new Map<string,Head>(); const duplicateHeads=new Set<string>();
  for(const head of heads as Head[]){const key=`${head.balanceTransactionId}:${head.basis}`;if(byKey.has(key))duplicateHeads.add(key);else byKey.set(key,head);}
  const out:CurrentEffectiveAllocationProjection[]=[];
  for(const id of ids) for(const basis of ['gross_amount','fee'] as const){const key=`${id}:${basis}`;if(duplicateHeads.has(key)){out.push({status:'exception',balanceTransactionId:id,basis,safeCode:'allocation_fork'});continue;}const h=byKey.get(key);if(!h){out.push({status:'missing',balanceTransactionId:id,basis,safeCode:'missing_source'});continue;}if(!h.isComplete){const rawCode=h.proposedIssueCode;const code=rawCode!==null&&ISSUE_CODES.has(rawCode)?rawCode:'allocation_mismatch';out.push({status:code==='missing_source'||code==='allocation_incomplete'?'missing':'exception',balanceTransactionId:id,basis,safeCode:code} as CurrentEffectiveAllocationProjection);continue;}const selected=(items as Item[]).filter(i=>i.balanceTransactionId===id&&i.basis===basis);const decisions=new Set<string>();const invalidItem=selected.some(i=>{const decision=`${i.orderItemId}:${i.component}`;const invalid=i.baseSetId!==h.baseSetId||i.compatibleCorrectionTipId!==h.compatibleCorrectionTipId||!UUID.test(i.orderItemId)||!COMPONENTS.has(i.component)||!money(i.effectMinor)||i.currency!==h.currency||decisions.has(decision);decisions.add(decision);return invalid;});const titleSumInvalid=h.scope==='title'&&h.expectedEffectMinor!==null&&BigInt(h.expectedEffectMinor)!==selected.reduce((s,i)=>s+BigInt(i.effectMinor),0n);if(h.baseSetId===null||!UUID.test(h.baseSetId)||h.scope===null||!['title','account'].includes(h.scope)||h.currency===null||!CURRENCY.test(h.currency)||!money(h.expectedEffectMinor)||invalidItem||titleSumInvalid||(h.scope==='title'&&selected.length===0&&h.expectedEffectMinor!==0)||(h.scope==='account'&&selected.length!==0)){out.push({status:'exception',balanceTransactionId:id,basis,safeCode:'allocation_mismatch'});continue;}out.push({status:'complete',balanceTransactionId:id,basis,baseSetId:h.baseSetId,compatibleCorrectionTipId:h.compatibleCorrectionTipId,scope:h.scope as 'title'|'account',currency:h.currency,expectedEffectMinor:h.expectedEffectMinor,items:selected.map(({orderItemId,component,effectMinor,currency})=>({orderItemId,component,effectMinor,currency} as CurrentEffectiveAllocationItem))});}
  return out;
}
