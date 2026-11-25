import { AccountAddress, buildBasicAccountSigner, CcdAmount, Transaction } from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

const NETWORK_HOST = process.env.CONCORDIUM_GRPC_HOST ?? 'grpc.testnet.concordium.com';
const grpc = new ConcordiumGRPCNodeClient(NETWORK_HOST, 20000, credentials.createSsl());
const signer = buildBasicAccountSigner(process.env.AGENT_PRIVATE_KEY!);
const sender = AccountAddress.fromBase58(process.env.AGENT_ACCOUNT!);

/** Hard limits the model cannot change */
export const MAX_PAYMENT_MICRO_CCD = 5_000_000n;
export const ALLOWED_MERCHANTS = new Set((process.env.ALLOWED_MERCHANTS ?? '').split(',').filter(Boolean));

export async function pay(to: string, microCcd: bigint) {
  if (microCcd > MAX_PAYMENT_MICRO_CCD) throw new Error('Payment above the limit');
  if (!ALLOWED_MERCHANTS.has(to)) throw new Error('Merchant not allowed');
  const { nonce } = await grpc.getNextAccountNonce(sender);
  const tx = Transaction.transfer({ toAddress: AccountAddress.fromBase58(to), amount: CcdAmount.fromMicroCcd(microCcd) })
    .addMetadata({ sender, nonce }).build();
  return grpc.sendTransaction(await Transaction.signAndFinalize(tx, signer));
}
