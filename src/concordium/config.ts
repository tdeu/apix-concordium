// src/concordium/config.ts
// Network constants for the Concordium Agent Registry.
// Testnet values come from the hosted MCP server's `contract_info` tool (queried 23 Nov 2026);
// mainnet values from docs.concordium.com (CIS-8004 reference). Re-check with `apix concordium info`.

export type ConcordiumNetwork = 'testnet' | 'mainnet';

export interface NetworkConfig {
  network: ConcordiumNetwork;
  grpcHost: string;
  grpcPort: number;
  cis8004: { index: bigint; subindex: bigint };
  cis8: { index: bigint; subindex: bigint };
  /** First 32 hex chars of the genesis hash, used in CAIP-2/10/19 ids */
  caip2: string | null;
  explorer: string;
}

export const MCP_URL = process.env.CONCORDIUM_MCP_URL ?? 'https://agent-registry-mcp.concordium.com';

export const NETWORKS: Record<ConcordiumNetwork, NetworkConfig> = {
  testnet: {
    network: 'testnet',
    grpcHost: 'grpc.testnet.concordium.com',
    grpcPort: 20000,
    cis8004: { index: 12802n, subindex: 0n },
    cis8: { index: 12801n, subindex: 0n },
    caip2: null, // not documented for testnet: read it from build_agent_card output
    explorer: 'https://ccdexplorer.io/testnet',
  },
  mainnet: {
    network: 'mainnet',
    grpcHost: 'grpc.mainnet.concordium.software',
    grpcPort: 20000,
    cis8004: { index: 10082n, subindex: 0n },
    cis8: { index: 10081n, subindex: 0n },
    caip2: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb',
    explorer: 'https://ccdexplorer.io/mainnet',
  },
};

export function networkConfig(network: string = 'testnet'): NetworkConfig {
  if (network !== 'testnet' && network !== 'mainnet') {
    throw new Error(`Unknown Concordium network "${network}". Use testnet or mainnet.`);
  }
  return NETWORKS[network];
}

export function txLink(cfg: NetworkConfig, txHash: string): string {
  return `${cfg.explorer}/transaction/${txHash}`;
}
