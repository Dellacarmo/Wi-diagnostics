# WI//DIAG

Visualizador de Wi-Fi com duas interfaces sobre o mesmo engine em Bun:

- **CLI (terminal)**: radar RF com varredura de fósforo, telemetria do link, tabela de redes, analisador de espectro, eventos e inspetor por rede, tudo em tela cheia.
- **Web 3D**: o "espaço RF" ao redor do seu computador, com chuva digital, piso-radar, campo de sinal estimado, feixes e pacotes animados, inspetor e analisador de espectro.

```bash
npm install          # instala Bun (local), Three.js e o resto
npm run cli          # painel no terminal
npm run web          # visualização 3D no navegador (http://127.0.0.1:3333)
npm run demo         # painel com ambiente sintético (sem hardware)
```

Com o Bun instalado globalmente, use `bun run cli`, `bun run web` etc., e `npm link` deixa o comando `wi` no PATH.

## O que ele mede

| Camada | Dados |
| --- | --- |
| Rádio | RSSI filtrado (Kalman), pico, desvio, ruído e SNR, canal, largura, faixa de espectro ocupada, DFS, PHY, geração Wi-Fi, taxa PHY teórica, intervalo de beacon |
| Segurança | Protocolo (Aberta → WPA3/OWE) e nota de A a F |
| Identidade | SSID, BSSID, fabricante (OUI), MAC aleatório, rádios do mesmo AP agrupados |
| Espaço | Distância estimada com faixa de incerteza, azimute provável e altura |
| Espectro | Ocupação por canal, interferência co-canal/parcial, SIR, melhor canal por banda |
| Link | RSSI/SNR ao vivo, taxa TX, MCS, IP/IPv6, gateway, MAC/fabricante do roteador, DNS |
| Rede | Latência, jitter e perda para o gateway e para a internet (1.1.1.1), diagnóstico do link |
| Eventos | Novas redes, redes perdidas, roaming, troca de canal, queda de sinal, picos de latência, internet fora do ar, syslog do roteador |

### Como a posição é estimada

Com um único receptor parado, só a **distância** é observável: ela vem do RSSI pelo modelo log-distância, com referência a 1 m por banda e expoente de perda por ambiente (`--env open|residential|office|dense`, alterável ao vivo). A faixa mostrada combina o sombreamento típico do ambiente com a variação medida do sinal.

O **azimute** não é observável com uma antena. Ele é inferido assim: rádios do mesmo AP compartilham a direção, redes cujo sinal oscila junto (correlação de Pearson) são aproximadas, e uma semente determinística mantém o layout estável. Por isso a UI mostra o anel de distância e um setor provável, não um ponto exato.

O **campo RF** no piso 3D é a previsão do modelo a partir dessas posições estimadas, com curvas de nível em -50, -60, -70 e -80 dBm. Com uma rede selecionada, ele mostra só a cobertura dela.

## CLI

```
wi                      painel ao vivo
wi web                  visualização 3D (abre o navegador)
wi scan [--json]        varredura única (tabela ou JSON)
wi authorize            macOS: libera SSID/BSSID
wi oui update           baixa a base de fabricantes da IEEE

--demo  --web  --port <n>  --no-open  --env <modelo>  --interval <s>  --iface <nome>  --syslog [porta]
```

Teclas do painel: `↑↓` seleciona, `⏎` detalhes, `f` filtra banda, `s` ordena, `b` banda do espectro, `e` modelo de ambiente, `w` abre a web 3D, `m` chuva digital, `p` pausa, `q` sai.

## Web 3D

Teclas: `1` `2` `3` câmeras (órbita, radar, solo), `H` modo cinema, `F` campo RF, `R` chuva, `B` feixes, `L` rótulos, `N` e `D` recolhem painéis, `/` busca, `↑↓` navega entre redes, `Esc` limpa a seleção, espaço liga/desliga a auto-rotação.

Clique num nó, numa linha da lista ou numa curva do espectro para abrir o inspetor. O menu de exportação gera PNG da cena, CSV, JSON e, se as dependências Python estiverem instaladas, relatórios PDF, DOCX e XLSX.

## Plataformas

| SO | Fonte | Observações |
| --- | --- | --- |
| macOS | Helper Swift/CoreWLAN, compilado no primeiro uso (precisa das Command Line Tools) | Sem permissão de Localização o macOS oculta SSID/BSSID. Rode `bun run authorize` e aceite o pedido. Sem `swiftc`, cai para o `system_profiler`, bem mais limitado. |
| Linux | `nmcli` (NetworkManager), e `iw` para o link | SSID/BSSID completos |
| Windows | `netsh wlan` | Saída em inglês ou português |

Sem nenhuma fonte disponível, o engine usa o modo demo e avisa na interface.

## Estrutura

```text
engine/            núcleo em TypeScript (Bun)
  sources/         macOS (Swift/CoreWLAN), Linux, Windows, demo
  rf.ts            modelo de propagação, canais, Kalman, classificação
  tracker.ts       identidade entre varreduras (inclusive sem BSSID)
  layout.ts        posição provável
  spectrum.ts      ocupação, interferência, melhor canal
  netinfo.ts       IP, gateway, DNS, ping
  engine.ts        orquestração, eventos, snapshots
cli/               CLI e painel de terminal
server/            servidor HTTP + WebSocket (Bun.serve)
web/               frontend 3D (Three.js)
electron/          janela desktop (npm run electron)
python/            CLI Python original e gerador de relatórios
```

## CLI Python original

O backend Python continua disponível (`npm run legacy` ou `python monitor.py`) e é usado como ponte para os relatórios PDF/DOCX/XLSX:

```bash
pip install -r python/requirements.txt
```
