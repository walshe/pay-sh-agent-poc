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
  // proof should be rejected with 402 and told how to pay via the
  // www-authenticate header (this is the HTTP 402 / MPP handshake).
  it('GET /v1/quote/AAPL returns 402 without payment', async () => {
    const res = await fetch(`http://localhost:${gatewayPort}/v1/quote/AAPL`);
    expect(res.status).toBe(402);
    const auth = res.headers.get('www-authenticate');
    expect(auth).toMatch(/Payment/);
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
