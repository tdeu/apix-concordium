import { timingSafeEqual } from 'crypto';
import { pay } from '../../../lib/wallet';

function authorized(req: Request): boolean {
  const given = Buffer.from(req.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${process.env.API_SECRET}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function POST(req: Request) {
  if (!authorized(req)) return new Response('Unauthorized', { status: 401 });
  const { to, amount } = await req.json();
  const hash = await pay(to, BigInt(amount));
  return Response.json({ hash });
}
