# pay.sh Agent POC

A minimal end-to-end demo of the HTTP 402 + Pay.sh gateway pattern. An upstream Express API serves mock stock quotes with no payment logic whatsoever; the Pay.sh gateway sits in front and meters requests declaratively; a shell-script agent autonomously pays and fetches.

## What is pay.sh?

**pay.sh** is an open-source tool from the Solana Foundation that adds a payment layer to HTTP. Its own description: *"the missing payment layer for HTTP"*.

In practice it does two things:

- **Client side** — wraps common HTTP tools (`curl`, `wget`, `http`) and AI coding agents (`claude`, `codex`). When any of these hit an HTTP 402, `pay` intercepts the payment challenge, signs a USDC micropayment from a local wallet, and retries the original request automatically — no accounts, no sign-up. The AI agent wrappers (`pay claude ...`, `pay codex ...`) extend this to agentic workflows: when an AI agent makes HTTP calls as part of a task, `pay` sits transparently in the middle handling any payments so the agent can access paid APIs without stopping to ask a human for credentials.
- **Server side** — runs a gateway in front of any existing HTTP API. You declare which endpoints cost money and how much in a `provider.yml` file; the gateway enforces payment without any changes to the upstream code.

It supports two HTTP 402 payment standards: **MPP** (its native protocol) and **x402** (Coinbase's standard). See the [MPP vs x402](#mpp-vs-x402) section below for the difference.

**Official links:**
- Website & catalog: [pay.sh](https://pay.sh)
- GitHub (CLI + gateway): [solana-foundation/pay](https://github.com/solana-foundation/pay)
- API catalog: [solana-foundation/pay-skills](https://github.com/solana-foundation/pay-skills)
- Hosted payment debugger: [debugger.pay.sh](https://debugger.pay.sh)

---

## Why not just use Stripe?

Stripe and similar card-based processors are the right choice for consumer checkouts — buying a subscription, paying for a SaaS seat, processing an order. For **per-API-call micropayments between machines**, they fall apart quickly.

### The economics don't work at micro scale

Stripe charges **2.9% + \$0.30 per transaction**. That fixed \$0.30 floor means any call priced below roughly \$1.00 loses money on fees alone before you've made a cent. A \$0.001 quote lookup would cost 300× its price just to process.

USDC on Solana costs around **\$0.0005 per transaction** regardless of the amount transferred. Charging \$0.001 per call is viable. So is \$0.0001. The economics scale down as far as you want.

| | Stripe | pay.sh (USDC / Solana) |
|---|---|---|
| Minimum practical charge | ~$0.50 | $0.000001 |
| Fee per transaction | 2.9% + $0.30 | ~$0.0005 flat |
| Settlement time | 2–7 business days | ~400ms |
| Account required to pay | Yes (card + billing address) | No |
| Works for automated agents | No — needs stored credentials | Yes — native to HTTP |
| Geographic restrictions | Yes | No |
| Chargebacks | Yes | No — payments are final |
| Programmable splits | No (manual payouts) | Yes — declared in `provider.yml` |

### The integration model is wrong for agents

Stripe assumes a **human** initiates a payment. A person enters card details, authenticates, and authorises a charge. That works for a checkout page. It doesn't work for an AI agent that discovers a new API at runtime and needs to pay for it in the same HTTP round-trip with no human present.

HTTP 402 + MPP/x402 is designed for exactly this: the payment challenge, signing, and proof all happen inside a single retry cycle. The agent handles it the same way it handles a redirect — automatically, programmatically, without any stored credentials or pre-authorised billing relationship.

### Where Stripe is still the right answer

This isn't a universal replacement. Stripe is still better when:

- You're selling to **consumers** who don't have a crypto wallet
- You need **fiat currency** (USD, EUR) to hit a bank account directly
- You need **chargeback protection** — disputes and fraud recovery
- You're building a **subscription** or **metered billing** product on top of existing Stripe infrastructure
- Your regulatory environment requires it

### The bigger picture

The pattern this POC demonstrates — HTTP 402 as a machine-readable paywall — is increasingly how API access will work as AI agents become primary consumers of web services. An agent that can autonomously discover, evaluate, and pay for an API endpoint is fundamentally more capable than one that has to wait for a human to provision credentials.

Stripe is built for the world where humans buy things. HTTP 402 + stablecoins is built for the world where agents do.

---

## How It Works

### The three moving parts

```
┌─────────────────┐      ┌──────────────────────┐      ┌─────────────────┐
│  client/run.sh  │      │   Pay.sh Gateway      │      │  upstream API   │
│                 │      │   (provider.yml)       │      │  (Express/TS)   │
│  pay --sandbox  │      │                        │      │                 │
│  curl <url>     │      │  port 1402             │      │  port 3000      │
│                 │      │  • checks payment      │      │  • /v1/quote/:s │
│  your "agent"   │      │  • proxies to upstream │      │  • /v1/health   │
│                 │      │  • no business logic   │      │  • no payment   │
└─────────────────┘      └──────────────────────┘      │    code at all  │
                                                         └─────────────────┘
```

The key idea: **the upstream API knows nothing about payments**. It's a plain HTTP server. The gateway sits in front of it and enforces payment rules declared in `provider.yml` — no code changes to the upstream required.

---

### Flow 1: Paid endpoint (`/v1/quote/:symbol`)

```
Client                  Gateway (1402)          Solana Localnet       Upstream (3000)
  │                          │                        │                     │
  │── GET /v1/quote/AAPL ──▶ │                        │                     │
  │                          │ (metered endpoint,      │                     │
  │                          │  no payment proof yet)  │                     │
  │ ◀── HTTP 402 ────────────│                        │                     │
  │     + payment challenge  │                        │                     │
  │       (amount, address,  │                        │                     │
  │        accepted tokens)  │                        │                     │
  │                          │                        │                     │
  │  [pay CLI reads the 402, │                        │                     │
  │   builds a $0.001 USDC   │                        │                     │
  │   Solana transaction,    │                        │                     │
  │   signs with local       │                        │                     │
  │   wallet, broadcasts it] │                        │                     │
  │                          │                        │                     │
  │── GET /v1/quote/AAPL ──▶ │                        │                     │
  │   Authorization:          │── verify tx ─────────▶ │                     │
  │     Payment id=… proof=… │                        │                     │
  │                          │ ◀── confirmed ──────────│                     │
  │                          │── proxy GET ──────────────────────────────▶ │
  │                          │ ◀── 200 + JSON ───────────────────────────── │
  │ ◀── 200 + JSON ──────────│                        │                     │
```

**What just happened in plain terms:**

1. The agent sends a normal HTTP GET. No payment included.
2. The gateway returns **HTTP 402 Payment Required** — a standard HTTP status code — with a JSON body describing what's owed: the token (USDC), the amount ($0.001), the recipient's Solana address, and which payment protocols are accepted.
3. The `pay` CLI automatically handles the 402: it builds a Solana transaction transferring $0.001 USDC to the gateway's wallet, signs it with the local wallet, and broadcasts it to the Solana network.
4. The CLI retries the original request, this time attaching the payment ID and signed transaction in an `Authorization: Payment` header.
5. The gateway verifies the transaction is valid and confirmed on-chain, then forwards the request to the upstream.
6. The upstream responds with JSON. The upstream never saw the payment — it just got a plain HTTP request.

---

### Flow 2: Free endpoint (`/v1/health`)

```
Client                  Gateway (1402)                        Upstream (3000)
  │                          │                                      │
  │── GET /v1/health ───────▶│                                      │
  │                          │ (no metering block in provider.yml)  │
  │                          │── proxy GET /v1/health ─────────────▶│
  │                          │◀── 200 {"status":"ok"} ──────────────│
  │◀── 200 {"status":"ok"} ──│                                      │
```

No 402 issued. The gateway proxies straight through because `provider.yml` has no `metering` block on this path.

---

### The crypto part, simply explained

- **Network**: Solana (localnet in this POC — a local test blockchain, no real money)
- **Token**: USDC — a stablecoin pegged 1:1 to the US dollar, issued as a Solana SPL token
- **Transaction**: a standard Solana token transfer of $0.001 USDC from the client's wallet to the gateway's recipient address
- **Confirmation**: Solana confirms transactions in ~400ms, so the retry feels near-instant
- **Sandbox mode** (`--sandbox`): the `pay` CLI uses a local Solana validator with test funds — no real wallet or real USDC involved

The payment proof is a base64-encoded signed Solana transaction sent in the `Authorization` header. The gateway decodes it, checks the amount, recipient, and on-chain status, then either lets the request through or rejects it.

### MPP vs x402

This gateway uses **MPP (Machine Payments Protocol)**. There is a second HTTP 402 standard in this ecosystem called **x402** (developed by Coinbase). Both do the same thing — gate an HTTP endpoint behind a micropayment — but they use different headers:

| | MPP | x402 |
|---|---|---|
| 402 challenge | `www-authenticate: Payment ...` | `X-PAYMENT-REQUIRED: ...` |
| Payment proof | `Authorization: Payment id=… proof=…` | `X-PAYMENT: ...` |
| Spec home | [solana-foundation/pay](https://github.com/solana-foundation/pay) | [coinbase/x402](https://github.com/coinbase/x402) |

The `pay` CLI supports both — it detects which protocol the gateway is using from the 402 response and handles it automatically. If you see `www-authenticate` in the network tab, that's MPP; if you see `X-PAYMENT-REQUIRED`, that's x402. The flow and economics are identical either way.

---

## Prerequisites

- **Node.js** 20+ and npm
- **Pay.sh CLI** (`pay`) — install via Homebrew: `brew install pay`
  - After install, run `pay setup` to configure your local wallet

## Install

```bash
# Install upstream dependencies
cd upstream && npm install && cd ..
```

## Three-Terminal Workflow

Open three terminal windows in the project root.

### Terminal 1 — Upstream API

```bash
cd upstream
npm run dev
# Listening on http://127.0.0.1:3000
```

### Terminal 2 — Pay.sh Gateway

```bash
pay --sandbox server start provider.yml
# Gateway listening on http://127.0.0.1:1402
# Debugger UI at http://127.0.0.1:1402/__debugger
```

### Terminal 3 — Agent Client

```bash
./client/run.sh
```

The client calls `/v1/quote/AAPL`, `/v1/quote/TSLA`, and `/v1/quote/SOL` in sequence. Each call triggers a 402 challenge, automatic USDC payment, and returns the quote JSON.

## Custom Ports

```bash
# Upstream on a different port (also update forward_url in provider.yml)
PORT=3001 npm run dev

# Agent against a different gateway URL
GATEWAY_URL=http://127.0.0.1:9402 ./client/run.sh
```

## Success Criteria

| Test | Expected |
|------|----------|
| `curl http://127.0.0.1:1402/v1/quote/AAPL` | HTTP 402 with payment challenge body |
| `pay --sandbox curl http://127.0.0.1:1402/v1/quote/AAPL` | HTTP 200 with quote JSON (payment logged) |
| `./client/run.sh` | AAPL, TSLA, SOL quotes returned in sequence |
| `curl http://127.0.0.1:1402/v1/health` | HTTP 200 `{"status":"ok"}` — no 402 |
| Debugger UI at `http://127.0.0.1:1402/__debugger` | Payment history visible |

## Going to Production

Three things change between sandbox and a live deployment: the Solana network, how the gateway is hosted, and the RPC provider. Everything else — the upstream API, the `provider.yml` structure, the client pattern — stays the same.

### 1. Solana network & wallet

| | Sandbox | Production |
|---|---|---|
| `operator.network` in `provider.yml` | `localnet` | `mainnet` |
| `--sandbox` flag | required | remove it |
| USDC | test funds, auto-generated | real USDC on Solana mainnet |
| Recipient wallet | auto-generated per run | a keypair you own and control |

For production you need a real Solana wallet as the payment recipient. Generate one with the Solana CLI (`solana-keygen new`) or any Solana wallet app. Store the private key securely (never in the repo) and reference the public address in `provider.yml` under `recipients`.

### 2. Solana RPC provider (third-party service required)

The gateway needs an RPC endpoint to verify on-chain payments. The public Solana RPC nodes are rate-limited and unsuitable for production traffic. You'll need a paid RPC provider:

| Provider | Notes |
|---|---|
| [Helius](https://helius.dev) | generous free tier, good for getting started |
| [QuickNode](https://quicknode.com) | pay-per-request or fixed plans |
| [Triton](https://triton.one) | high-reliability, used by many protocols |

Set the RPC URL via environment variable when starting the gateway:

```bash
RPC_URL=https://mainnet.helius-rpc.com/?api-key=<key> pay server start provider.yml
```

### 3. Hosting & TLS

The upstream API and the gateway are both long-running processes. Deploy them anywhere you'd run a Node.js or Rust binary (Fly.io, Railway, AWS, GCP, etc.). The gateway **must be behind HTTPS** in production — clients embed the gateway URL in payment proofs, so the domain needs to be stable and TLS-terminated.

A minimal production setup looks like:

```
Internet → Caddy / nginx (TLS termination)
              → Pay.sh gateway  (port 1402)
                    → Upstream API  (port 3000, private)
```

### 4. Client wallet setup

Anyone calling your API with `pay curl` needs to have run `pay setup` with a funded mainnet wallet. For automated agents running server-side, this means a wallet with a USDC balance and a stored keypair. The `pay setup` flow handles key generation and storage in the OS keychain — run it once on the server as the service account user.

### 5. Catalog listing (optional but recommended)

Register your API in the [pay-skills catalog](https://github.com/solana-foundation/pay-skills) so `pay`-aware agents can discover and pay for it automatically. You add a `PAY.md` file to the repo describing your endpoints, pricing, and category. Once merged, `pay search` and the MCP server will surface your API to any agent looking for the capability.

---

## Mobile App Integration

The `pay` CLI handles the full 402 cycle automatically, but a mobile app needs to do the same thing in code — using the user's own wallet (Phantom, Solflare, etc.) to sign and broadcast the USDC payment. The app never holds a private key; it just prepares a transaction and hands it to the wallet to sign.

### Flow

```
Mobile App              Gateway (HTTPS)         Solana Mainnet        Upstream API
     │                        │                       │                     │
     │── GET /v1/quote/AAPL ─▶│                       │                     │
     │                        │                       │                     │
     │◀── HTTP 402 ───────────│                       │                     │
     │    www-authenticate:   │                       │                     │
     │      amount: 1000      │                       │                     │
     │      currency: <mint>  │                       │                     │
     │      recipient: <addr> │                       │                     │
     │      blockhash: <hash> │                       │                     │
     │                        │                       │                     │
     │  [app builds a USDC    │                       │                     │
     │   transfer tx using    │                       │                     │
     │   the provided data,   │                       │                     │
     │   asks wallet to sign] │                       │                     │
     │                        │                       │                     │
     │── GET /v1/quote/AAPL ─▶│                       │                     │
     │   Authorization:       │── verify tx ─────────▶│                     │
     │     Payment proof=<tx> │◀── confirmed ──────────│                     │
     │                        │── proxy ──────────────────────────────────▶│
     │◀── 200 + JSON ─────────│                       │                     │
```

### Parsing the 402 challenge

The gateway returns a `www-authenticate` header in this format:

```
Payment id="<id>", realm="MPP Payment", method="solana", intent="charge",
  request="<base64_json>", expires="<timestamp>"
```

The `request` field is a base64-encoded JSON payload (confirmed from this gateway's live response):

```json
{
  "amount": "1000",
  "currency": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "description": "Get quote",
  "methodDetails": {
    "decimals": 6,
    "network": "mainnet",
    "recentBlockhash": "<hash_provided_by_gateway>",
    "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  },
  "recipient": "<gateway_recipient_address>"
}
```

`amount` is in the token's smallest unit — USDC has 6 decimals, so `1000` = $0.001. The gateway also provides the `recentBlockhash` so you don't need a separate RPC call to fetch one.

Parse it like this:

```typescript
function parse402(response: Response) {
  const header = response.headers.get('www-authenticate') ?? '';
  const idMatch = header.match(/id="([^"]+)"/);
  const requestMatch = header.match(/request="([^"]+)"/);
  if (!idMatch || !requestMatch) throw new Error('Not an MPP 402');

  const paymentId = idMatch[1];
  const challenge = JSON.parse(atob(requestMatch[1]));
  return { paymentId, challenge };
}
```

### Building and signing the transaction

Use `@solana/web3.js` and `@solana/spl-token` to construct the USDC transfer, then hand it to the user's wallet via the Mobile Wallet Adapter:

```typescript
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferInstruction } from '@solana/spl-token';

async function buildPaymentTx(challenge: any, payerPublicKey: PublicKey): Promise<Transaction> {
  const mint = new PublicKey(challenge.currency);
  const recipient = new PublicKey(challenge.recipient);

  // Find the token accounts for payer and recipient
  const senderATA = await getAssociatedTokenAddress(mint, payerPublicKey);
  const recipientATA = await getAssociatedTokenAddress(mint, recipient);

  const tx = new Transaction();
  tx.recentBlockhash = challenge.methodDetails.recentBlockhash;
  tx.feePayer = payerPublicKey;

  tx.add(
    createTransferInstruction(
      senderATA,
      recipientATA,
      payerPublicKey,
      BigInt(challenge.amount), // already in smallest unit
    )
  );

  return tx;
}
```

### Signing with the user's mobile wallet

On iOS and Android, use the [Mobile Wallet Adapter](https://github.com/solana-mobile/mobile-wallet-adapter) to request a signature without the app ever seeing the private key:

```typescript
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';

async function signAndPay(tx: Transaction): Promise<string> {
  return await transact(async (wallet) => {
    // Prompts the user's wallet app (Phantom, Solflare, etc.) to sign
    const [signed] = await wallet.signTransactions({ transactions: [tx] });

    // Broadcast the signed transaction
    const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=<key>');
    return await connection.sendRawTransaction(signed.serialize());
  });
}
```

The user sees a standard wallet approval screen showing the $0.001 USDC transfer — the same flow as any other Solana payment.

### Retrying with the payment proof

Once the transaction is signed and sent, retry the original request with an `Authorization` header containing the payment ID and the serialized signed transaction as proof:

```typescript
async function callWithPayment(url: string): Promise<any> {
  // First attempt
  const res = await fetch(url);
  if (res.status !== 402) return res.json();

  // Parse challenge, build tx, get user to sign
  const { paymentId, challenge } = parse402(res);
  const tx = await buildPaymentTx(challenge, userPublicKey);
  const txSignature = await signAndPay(tx);

  // Retry with proof — serialize the signed tx to base64
  const signedTx = await connection.getTransaction(txSignature, { commitment: 'confirmed' });
  const proofB64 = Buffer.from(signedTx!.transaction.message.serialize()).toString('base64');

  const paid = await fetch(url, {
    headers: {
      Authorization: `Payment id="${paymentId}", proof="${proofB64}"`,
    },
  });
  return paid.json();
}
```

### Required packages

```bash
npm install @solana/web3.js @solana/spl-token
npm install @solana-mobile/mobile-wallet-adapter-protocol-web3js  # React Native only
```

For a web app (browser), swap the Mobile Wallet Adapter for `@solana/wallet-adapter-react`, which supports browser extension wallets (Phantom's browser extension, Backpack, etc.) using the same signing interface.

### What the user experiences

From the user's perspective it's a single tap — their wallet pops up showing "Pay $0.001 USDC to [app name]", they approve, and the app gets its data. The payment, the retry, and the proof attachment all happen invisibly in the background between the approval and the result appearing on screen.

---

## Project Structure

```
pay.sh/
├── upstream/          # TypeScript/Express API — zero payment code
│   ├── src/index.ts
│   ├── package.json
│   └── tsconfig.json
├── client/
│   └── run.sh         # Shell agent — pays with pay --sandbox curl
├── provider.yml       # Pay.sh gateway config — metering + routing
└── README.md
```
