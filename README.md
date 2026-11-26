# APIX Verifier on Concordium

**An AI agent that other agents pay to check their code, and that records the verdict on Concordium.**

AI agents now write code that holds keys and moves money. Most of that code is never read by a
human. APIX Verifier checks it, and makes the result something any other agent can trust without
trusting us: the verdict is signed by an account with a verified human behind it, paid for with
x402, and recorded on-chain.

Built for the [Concordium Trusted Agents Hackathon](https://www.encodeclub.com/programmes/concordium-trusted-agents-hackathon) (Encode Club, Nov–Dec 2026), on the APIX verification engine by Emtée Studio.

## How it works

```
 Client agent                     APIX Verifier (agent #1480, badge JyP9XfKkFPMSms2qdYnyD)        Concordium testnet
      │  POST /verify {repo}                 │                                                    │
      │─────────────────────────────────────>│                                                    │
      │  402 Payment Required: 1 CCD         │                                                    │
      │<─────────────────────────────────────│                                                    │
      │  signs the transfer (x402 exact)     │                                                    │
      │─────────────────────────────────────>│ verifies + co-signs as sponsor (fees paid by APIX) │
      │                                      │───────────────────────────────────────────────────>│ payment
      │                                      │ downloads the repo, runs the checks               │
      │                                      │ records verdict + report hash (RegisterData)       │
      │                                      │───────────────────────────────────────────────────>│ attestation
      │  verdict, report, both tx links      │                                                    │
      │<─────────────────────────────────────│                                                    │
```

Any third party can then check, from the chain alone, that a given app was verified, by whom,
with what result, at which commit, and that the report they hold is the one that was attested.
`apix concordium trust` does exactly that before an agent deals with an app: it answers ALLOW only
if the app's current commit is attested PASS by an attester it trusts (and, if the attestation names
an agent, that agent's Verified by Concordium badge is valid).

## Concordium components used

| Component | How APIX uses it |
|---|---|
| **Agent Registry (CIS-8004)** | APIX Verifier is registered as agent #1480 with an A2A Agent Card whose SHA-256 is pinned on-chain |
| **Verified by Concordium badge** | `JyP9XfKkFPMSms2qdYnyD` (valid: `apix concordium check JyP9XfKkFPMSms2qdYnyD`). The owner account is backed by a Concordium identity |
| **Agent Registry MCP server** | Builds every registry payload (`build_agent_card`, `build_register`, `build-set-agent-uri`, `check-badge`); signing stays local |
| **x402 payments** | Official `@x402/concordium` package (exact scheme): APIX runs its own facilitator |
| **Sponsored transactions** | The client signs only its transfer; APIX's sponsor account adds its signature and pays the fee |
| **Identity-backed accounts** | Owner, attester and client accounts each come from a Concordium identity (testnet identity provider) |
| **RegisterData** | Each attestation: verdict, report SHA-256, code tree hash, commit, optional client badge (≤ 256 bytes, no smart contract) |

## Live on testnet

| What | Link |
|---|---|
| Agent registration (APIX Verifier #1480) | [65e88803…](https://ccdexplorer.io/testnet/transaction/65e88803135e618ca7661106105cf20a70361c7fc234d422894cbf16a9165171) |
| Badge second pass (card with token address pinned) | [ecfbff7c…](https://ccdexplorer.io/testnet/transaction/ecfbff7ca580283cc2be1cd0a5ddcae29b8c2f84ab8fd512af702a59ef758bd8) |
| x402 payment for [concordium-agent-unsafe](https://github.com/tdeu/concordium-agent-unsafe) | [eef5a3e9…](https://ccdexplorer.io/testnet/transaction/eef5a3e99afb946c00a69194161647db992b482d70dffdacad70ff08006b33f9) |
| Attestation **FAIL** for concordium-agent-unsafe (commit 5a5f4d18c89d) | [40989ddc…](https://ccdexplorer.io/testnet/transaction/40989ddc4b25a22939d5562a3f8960e51f58479360bbc117f344bd0f671eb9d8) |
| x402 payment for [concordium-agent-safe](https://github.com/tdeu/concordium-agent-safe) | [be59db8d…](https://ccdexplorer.io/testnet/transaction/be59db8d1cac43bd35deeb137587ed52463eeeb8f0dad6bcef876246f5001f3f) |
| Attestation **PASS** for concordium-agent-safe (commit d40a1900e1f1) | [e56174bd…](https://ccdexplorer.io/testnet/transaction/e56174bd517f1dd32b9dcf25bf156c029def0f2fb4a9256704b3b2a78b8e92f8) |
| Client agent registration (APIX Demo Client Agent #1522, badge `JyP9YTHyNUJRd71gBmtEL`) | [12271e02…](https://ccdexplorer.io/testnet/transaction/12271e02374a285f59870eb3ba8d6e2bbaef2db63ba1bdd0bc094ed3ad32a740) |
| Full flow: client agent pays for a check of concordium-agent-safe | [f0158302…](https://ccdexplorer.io/testnet/transaction/f015830254fa89e9eeeb09a50b7e1c0be82754966fc1ab4a8db20f1a77363ae7) |
| Full flow: attestation **PASS** naming the client agent's badge (`apix concordium trust … --require-badge` → ALLOW) | [82efcc71…](https://ccdexplorer.io/testnet/transaction/82efcc712a08d20288467cabf05bbd47125e63455d09ad6a72eeca075a946841) |
| Agent Cards | [APIX Verifier](https://apix-agent-card.vercel.app/.well-known/agent-card.json), [client agent](https://apix-agent-card.vercel.app/client/agent-card.json) |

## What the checks look for

`apix verify` reads the code (it never runs it) and checks eight things:

- keys or Concordium wallet exports committed to the repository
- env files with secrets committed
- secrets exposed through public env variables (`NEXT_PUBLIC_…`)
- browser code that builds a signer from a key
- server routes that sign and send transactions without checking the caller, or with an uncapped amount
- AI tools that can move funds with no amount limit or allowlist
- mainnet hardcoded in code that spends
- whether there is Concordium code to check at all

Each failure comes with a plain-words fix. The report is canonical JSON; its SHA-256 is what goes on-chain.

## Quick start

Requires Node 22.12+ and Concordium testnet accounts exported from Concordium Wallet for Web
(keep the `.export` files outside any git repository: the CLI refuses keys inside one).

```bash
npm install
npm run build

# Check a project locally
node dist/cli/index.js verify examples/concordium-agent-unsafe

# Run the verifier service with x402 (attester receives payments and signs attestations,
# sponsor pays the transaction fees)
node dist/cli/index.js concordium serve \
  --key /keys/attester.export --sponsor-key /keys/sponsor.export --price 1 \
  --badge JyP9XfKkFPMSms2qdYnyD --card https://apix-agent-card.vercel.app/.well-known/agent-card.json

# Act as a client agent: pay and get a verdict
node dist/cli/index.js concordium request https://github.com/tdeu/concordium-agent-safe \
  --key /keys/client.export --max 2

# Check any attestation from the chain
node dist/cli/index.js concordium attestation <txHash> --attester <attester account> --report <report.json>

# Before dealing with an app: ALLOW only if its *current* commit is attested PASS
# by the trusted attester (read from the chain; the service only gives the pointer)
node dist/cli/index.js concordium trust https://github.com/tdeu/concordium-agent-safe \
  --attester 34hyqL9dYjS1rnLfacRKVFPTZouPACo2waETtVqiVjFuRDpFJc --verifier http://localhost:8402
```

Registering your own agent: `apix concordium card` → host the file → `apix concordium register` →
`apix concordium card --token-id <id>` → re-host → `apix concordium pin`.

## Path to production

To be completed: mainnet deployment, hosted service, fees and pricing, trusted attester keys.

## Repository

- `src/verify`: the checks and the report format
- `src/concordium`: registry, badge, attestations, x402 payments, the HTTP service
- `src/cli`: the `apix` command
- `examples/`: the two demo agents (also published as their own repos)

MIT licence. Emtée Studio.
