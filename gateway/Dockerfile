FROM ubuntu:24.04

RUN apt-get update && apt-get install -y curl ca-certificates && rm -rf /var/lib/apt/lists/*

ARG PAY_VERSION=0.16.0
RUN curl -fsSL \
    "https://github.com/solana-foundation/pay/releases/download/pay-v${PAY_VERSION}/pay-x86_64-unknown-linux-gnu.tar.gz" \
    | tar -xz -C /usr/local/bin \
    && chmod +x /usr/local/bin/pay

WORKDIR /app
COPY provider.test.yml provider.yml

EXPOSE 1402

CMD ["pay", "--sandbox", "server", "start", "provider.yml"]
