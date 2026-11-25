import OpenAI from 'openai';
import { pay } from './wallet';

const openai = new OpenAI();
export const tools = [{ type: 'function', function: { name: 'pay', description: 'Pay a merchant', parameters: {} } }];
export async function runTool(args: { to: string; amount: string }) {
  return pay(args.to, BigInt(args.amount));
}
