import { pay } from '../../../lib/wallet';

export async function POST(req: Request) {
  const { to, amount } = await req.json();
  const hash = await pay(to, BigInt(amount));
  return Response.json({ hash });
}
