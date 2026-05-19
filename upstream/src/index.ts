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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Upstream API listening on http://127.0.0.1:${PORT}`);
});
