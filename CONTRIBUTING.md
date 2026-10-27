# Como contribuir

Obrigado pelo interesse no WI//DIAG! Estas regras mantêm o projeto organizado e o histórico seguro.

## Fluxo

1. Faça um fork e crie uma branch a partir da `main`: `feat/…`, `fix/…` ou `docs/…`.
2. Mantenha o PR pequeno e focado em uma coisa só.
3. Abra o PR para a `main` dizendo o que muda e como testar.
4. A `main` só recebe código por PR. Todo PR precisa da aprovação de um code owner (@felipe-dpmedeiros ou @EnzoHessel) e do build passando. Ninguém faz push direto, nem force push, na `main`.

## Antes de abrir o PR

```bash
npm install
npm run typecheck
npm run demo         # terminal, com o ambiente fictício
npm run web:demo     # navegador 3D, com o ambiente fictício
```

O GitHub Actions roda o typecheck e gera o app desktop para macOS, Windows e Linux em cada PR.

## Dados de rede

Não publique dados reais de Wi-Fi (SSIDs, BSSIDs, IPs ou MACs) em issues, PRs, logs ou prints. Use o modo demo, que gera um ambiente fictício.

## Segurança

Vulnerabilidades vão por relato privado, nunca em issue pública: veja o [SECURITY.md](SECURITY.md).

## Licença

Ao enviar um PR, você concorda que a contribuição seja distribuída sob a [Apache-2.0](LICENSE), como o resto do projeto.
