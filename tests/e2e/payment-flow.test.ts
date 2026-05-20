import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Network, Wait } from 'testcontainers';
import { execSync } from 'child_process';
import path from 'path';
import type { StartedTestContainer, StartedNetwork } from 'testcontainers';

// Resolve to the repo root so we can reference each service's Dockerfile regardless
// of where the test process is launched from.
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// Shared across all tests in this file — initialised in beforeAll, torn down in afterAll.
let network: StartedNetwork;
let upstreamContainer: StartedTestContainer;
let gatewayContainer: StartedTestContainer;
// The host port that Testcontainers randomly maps to the gateway's internal 1402.
let gatewayPort: number;

describe('E2E Payment Flow', () => {
  // ---------------------------------------------------------------------------
  // Stack setup
  //
  // Testcontainers builds both Docker images from source and starts them on a
  // shared bridge network. Using a dedicated network means the gateway can
  // reach the upstream by the alias "upstream" (i.e. http://upstream:3000),
  // exactly as it would in production — no special DNS or host-file tricks.
  //
  // The wait strategies poll the container logs so we don't run any test until
  // both services are actually ready to accept requests.
  // ---------------------------------------------------------------------------
  beforeAll(async () => {
    // Isolated bridge network — containers on it can talk to each other by alias;
    // nothing outside this test run can accidentally share it.
    network = await new Network().start();

    // Labels make the ephemeral containers identifiable in Docker Desktop
    // (Inspect → Labels) while the tests are running.
    const e2eLabels = { 'com.paysh.suite': 'e2e', 'com.paysh.project': 'pay.sh' };

    // Build and start the upstream Node.js API (upstream/Dockerfile).
    // The network alias "upstream" is what the gateway uses in provider.test.yml
    // to forward paid requests: routing.url: http://upstream:3000
    upstreamContainer = await (await GenericContainer
      .fromDockerfile(path.join(PROJECT_ROOT, 'upstream'))
      .build())
      .withNetwork(network)
      .withNetworkAliases('upstream')
      .withLabels({ ...e2eLabels, 'com.paysh.service': 'upstream' })
      .withWaitStrategy(Wait.forLogMessage('Upstream API listening'))
      .start();

    // Build and start the pay.sh gateway (gateway/Dockerfile).
    // The gateway enforces HTTP 402 payment challenges in front of the upstream.
    // Port 1402 is exposed so tests can hit the gateway from the host, and
    // Testcontainers assigns a random host port to avoid clashes with anything
    // already listening locally.
    gatewayContainer = await (await GenericContainer
      .fromDockerfile(path.join(PROJECT_ROOT, 'gateway'))
      .build())
      .withNetwork(network)
      .withExposedPorts(1402)
      .withLabels({ ...e2eLabels, 'com.paysh.service': 'gateway' })
      .withWaitStrategy(Wait.forLogMessage('Running Payment debugger'))
      .start();

    // Resolve the random host port once; all tests reference this variable.
    gatewayPort = gatewayContainer.getMappedPort(1402);
  });

  // Stop containers and tear down the network after all tests complete.
  // Testcontainers also registers a Ryuk reaper container as a safety net that
  // cleans up if the process exits unexpectedly.
  afterAll(async () => {
    await gatewayContainer?.stop();
    await upstreamContainer?.stop();
    await network?.stop();
  });

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  // The /health endpoint is declared free in provider.yml, so the gateway
  // should pass it straight through to the upstream without demanding payment.
  it('GET /v1/health returns 200 without payment', async () => {
    const res = await fetch(`http://localhost:${gatewayPort}/v1/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ status: 'ok' });
  });

  // The /quote endpoint costs money. A plain HTTP client that sends no payment
  // proof should be rejected with 402. The response contains everything a paying
  // client needs to construct and sign a valid micropayment:
  //
  //   www-authenticate: Payment id="...", realm="MPP Payment", method="solana",
  //                     intent="charge", request="<base64-json>", expires="..."
  //
  // The base64 `request` field decodes to a JSON object (the "payment token")
  // that specifies the exact amount, token mint, recipient wallet, and a recent
  // Solana blockhash to prevent replay attacks. The response body also carries
  // human-readable pricing metadata for display purposes.
  it('GET /v1/quote/AAPL returns 402 without payment', async () => {
    const res = await fetch(`http://localhost:${gatewayPort}/v1/quote/AAPL`);

    // ── Status & content-type ────────────────────────────────────────────────
    expect(res.status).toBe(402);
    // The body is machine-readable JSON, not an HTML error page
    expect(res.headers.get('content-type')).toMatch(/application\/json/);

    // ── www-authenticate header structure ────────────────────────────────────
    const auth = res.headers.get('www-authenticate');
    expect(auth).not.toBeNull();

    // The scheme is "Payment" and the realm identifies it as MPP
    expect(auth).toMatch(/^Payment /);
    expect(auth).toMatch(/realm="MPP Payment"/);

    // The payment method is Solana (not EVM, not Lightning, etc.)
    expect(auth).toMatch(/method="solana"/);

    // This is a charge (as opposed to a subscription or pre-auth)
    expect(auth).toMatch(/intent="charge"/);

    // Each challenge has a unique ID so the gateway can match the payment proof
    // back to this specific request when the client retries
    expect(auth).toMatch(/id="[^"]+"/);

    // The challenge expires — clients must pay before this timestamp or start
    // a fresh challenge
    expect(auth).toMatch(/expires="20\d{2}-/); // ISO 8601 year prefix

    // ── Decode the payment token ─────────────────────────────────────────────
    // The `request` parameter is a base64-encoded JSON blob that tells the
    // client exactly what to sign and send on-chain.
    const requestMatch = auth!.match(/request="([^"]+)"/);
    expect(requestMatch).not.toBeNull();
    const paymentToken = JSON.parse(
      Buffer.from(requestMatch![1], 'base64').toString('utf8')
    ) as Record<string, unknown>;

    // Amount is in the token's smallest unit (micro-USDC: 6 decimal places),
    // so 1000 here = $0.001 USDC
    expect(paymentToken.amount).toBe('1000');

    // Currency is the on-chain token mint address (Solana base58 public key)
    expect(typeof paymentToken.currency).toBe('string');
    expect((paymentToken.currency as string).length).toBeGreaterThanOrEqual(32);

    // Human-readable description surfaced from provider.yml
    expect(paymentToken.description).toMatch(/USDC/);

    // methodDetails carries the on-chain specifics needed to build the transaction
    const md = paymentToken.methodDetails as Record<string, unknown>;

    // USDC always has 6 decimal places on Solana
    expect(md.decimals).toBe(6);

    // Sandbox gateway runs against localnet (no real money involved)
    expect(md.network).toBe('localnet');

    // A recent blockhash is included so the signed transaction cannot be
    // replayed after ~90 seconds (Solana's blockhash expiry window)
    expect(typeof md.recentBlockhash).toBe('string');
    expect((md.recentBlockhash as string).length).toBeGreaterThan(0);

    // The SPL token program is the standard Solana fungible token runtime
    expect(md.tokenProgram).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    // Recipient is the gateway's Solana wallet — this is where the USDC lands
    expect(typeof paymentToken.recipient).toBe('string');
    expect((paymentToken.recipient as string).length).toBeGreaterThanOrEqual(32);

    // ── Response body ────────────────────────────────────────────────────────
    // The body gives human-readable context and machine-readable pricing so
    // clients can display cost information before committing to payment.
    const body = await res.json() as Record<string, unknown>;

    expect(body.error).toBe('payment_required');
    expect(body.message).toBe('This endpoint requires payment.');

    // Protocol field confirms this gateway speaks MPP (not x402 or another scheme)
    const payment = body.payment as Record<string, unknown>;
    expect(payment.protocol).toBe('mpp');

    // Pricing is expressed per-request in USD so clients can show the cost to
    // the user before automatically paying
    const pricing = body.pricing as { dimensions: Array<Record<string, unknown>> };
    const dimension = pricing.dimensions[0];
    expect(dimension.price_usd).toBe(0.001);
    expect(dimension.unit).toBe('requests');
  });

  // The full happy path: `pay --sandbox curl` acts as a paying client.
  // It receives the 402, reads the payment challenge, signs a USDC micropayment
  // on the Solana test network (sandbox = no real money), then retries the
  // request with a payment proof header. The gateway validates the proof and
  // proxies the request to the upstream, which returns the stock quote JSON.
  it('pay --sandbox curl returns quote JSON after payment', () => {
    const url = `http://localhost:${gatewayPort}/v1/quote/AAPL`;
    const output = execSync(`pay --sandbox curl "${url}"`, {
      encoding: 'utf8',
      timeout: 60000,
    });
    const data = JSON.parse(output.trim()) as Record<string, unknown>;
    expect(data).toHaveProperty('symbol');
  });
});
