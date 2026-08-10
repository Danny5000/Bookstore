import { eq } from 'drizzle-orm';
import type { Actor } from '$lib/server/auth/admin-policy';
import { orders, type OrderRow } from '$lib/server/db/schema';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import type { OrderStatusDto } from '$lib/types/commerce';
import { OrderNotFoundError } from './errors';
import {
  isOrderStatusCredentialExpired,
  matchesOrderStatusToken
} from './status-cookie';

export interface AuthorizeOrderStatusInput {
  actor: Actor;
  statusToken: string | null;
  now?: Date;
}

export interface GetOrderStatusInput extends AuthorizeOrderStatusInput {
  orderId: string;
}

function isAuthorized(order: OrderRow, input: AuthorizeOrderStatusInput): boolean {
  if (input.actor.type === 'user' && order.initiatingUserId === input.actor.id) return true;
  return input.statusToken !== null &&
    !isOrderStatusCredentialExpired(order.checkoutExpiresAt, input.now ?? new Date()) &&
    matchesOrderStatusToken(input.statusToken, order.statusTokenSha256);
}

function statusDto(order: OrderRow): OrderStatusDto {
  if (
    order.status === 'checkout_pending' ||
    order.status === 'checkout_open' ||
    order.status === 'payment_pending'
  ) return { status: 'pending' };
  if (order.status === 'paid') {
    return order.initiatingUserId === null
      ? {
          status: 'paid_guest',
          claimMessage: 'Check your email for a secure link to claim this purchase.'
        }
      : { status: 'paid', libraryUrl: '/library' };
  }
  const messages: Record<'failed' | 'expired' | 'exception', string> = {
    failed: 'Payment was not completed. Your cart is still available.',
    expired: 'Checkout expired. Return to your cart to try again.',
    exception: 'This purchase needs review. Contact support if its status does not update.'
  };
  return { status: order.status, message: messages[order.status] };
}

export function authorizeOrderStatus(
  order: OrderRow,
  input: AuthorizeOrderStatusInput
): OrderStatusDto {
  if (!isAuthorized(order, input)) throw new OrderNotFoundError();
  return statusDto(order);
}

export async function getAuthorizedOrderStatus(
  database: DatabaseExecutor,
  input: GetOrderStatusInput
): Promise<OrderStatusDto> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.orderId)) {
    throw new OrderNotFoundError();
  }
  const [order] = await database
    .select()
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1);
  if (!order) throw new OrderNotFoundError();
  return authorizeOrderStatus(order, input);
}
