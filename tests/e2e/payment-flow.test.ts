import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Network, Wait } from 'testcontainers';
import { execSync } from 'child_process';
import path from 'path';
import type { StartedTestContainer, StartedNetwork } from 'testcontainers';

const PROJECT_ROOT = path.resolve(__dirname, '../..');

let network: StartedNetwork;
let upstreamContainer: StartedTestContainer;
let gatewayContainer: StartedTestContainer;
let gatewayPort: number;

describe('E2E Payment Flow', () => {
  beforeAll(async () => {
    network = await new Network().start();

    const e2eLabels = { 'com.paysh.suite': 'e2e', 'com.paysh.project': 'pay.sh' };

    upstreamContainer = await (await GenericContainer
      .fromDockerfile(path.join(PROJECT_ROOT, 'upstream'))
      .build())
      .withNetwork(network)
      .withNetworkAliases('upstream')
      .withLabels({ ...e2eLabels, 'com.paysh.service': 'upstream' })
      .withWaitStrategy(Wait.forLogMessage('Upstream API listening'))
      .start();

    gatewayContainer = await (await GenericContainer
      .fromDockerfile(path.join(PROJECT_ROOT, 'gateway'))
      .build())
      .withNetwork(network)
      .withExposedPorts(1402)
      .withLabels({ ...e2eLabels, 'com.paysh.service': 'gateway' })
      .withWaitStrategy(Wait.forLogMessage('Running Payment debugger'))
      .start();

    gatewayPort = gatewayContainer.getMappedPort(1402);
  });

  afterAll(async () => {
    await gatewayContainer?.stop();
    await upstreamContainer?.stop();
    await network?.stop();
  });

  it('GET /v1/health returns 200 without payment', async () => {
    const res = await fetch(`http://localhost:${gatewayPort}/v1/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ status: 'ok' });
  });

  it('GET /v1/quote/AAPL returns 402 without payment', async () => {
    const res = await fetch(`http://localhost:${gatewayPort}/v1/quote/AAPL`);
    expect(res.status).toBe(402);
    const auth = res.headers.get('www-authenticate');
    expect(auth).toMatch(/Payment/);
  });

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
