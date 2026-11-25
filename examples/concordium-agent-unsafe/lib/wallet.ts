import { AccountAddress, buildBasicAccountSigner, CcdAmount, Transaction } from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

const grpc = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const signer = buildBasicAccountSigner(process.env.AGENT_PRIVATE_KEY!);
const sender = AccountAddress.fromBase58(process.env.AGENT_ACCOUNT!);

export async function pay(to: string, microCcd: bigint) {
  const { nonce } = await grpc.getNextAccountNonce(sender);
  const tx = Transaction.transfer({ toAddress: AccountAddress.fromBase58(to), amount: CcdAmount.fromMicroCcd(microCcd) })
    .addMetadata({ sender, nonce }).build();
  return grpc.sendTransaction(await Transaction.signAndFinalize(tx, signer));
}
