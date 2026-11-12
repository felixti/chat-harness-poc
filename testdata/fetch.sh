#!/usr/bin/env bash
# Downloads the public test files used in manual E2E tests (binaries are not committed).
set -euo pipefail
cd "$(dirname "$0")"
get(){ curl -fsSL -A "chat-harness-poc-testdata" -o "$1" "$2"; echo "ok $1"; }
get financial-sample.xlsx "https://go.microsoft.com/fwlink/?LinkID=521962"
get attention-is-all-you-need.pdf "https://arxiv.org/pdf/1706.03762"
get bcb-rpm-2026-09.pdf "https://www.bcb.gov.br/content/ri/relatorioinflacao/202609/rpm202609p.pdf"
B=https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/arquivos-lpc/2026
get anp-precos-resumo-2026-11-07.xlsx "$B/resumo_semanal_lpc_2026_11_01-2026_11_07.xlsx"
get anp-precos-revendas-2026-11-07.xlsx "$B/revendas_lpc_2026_11_01-2026_11_07.xlsx"
