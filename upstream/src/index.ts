import express from 'express';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

app.get('/v1/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/v1/quote/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  res.json({
    symbol,
    price: parseFloat((Math.random() * 450 + 50).toFixed(2)),
    change: parseFloat((Math.random() * 10 - 5).toFixed(2)),
    volume: Math.floor(Math.random() * 9_900_000 + 100_000),
  });
});

const HOST = process.env.HOST ?? '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Upstream API listening on http://${HOST}:${PORT}`);
});
