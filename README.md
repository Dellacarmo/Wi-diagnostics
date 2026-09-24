# Wi-Diagnostics

Sistema de diagnóstico e visualização de redes Wi‑Fi.

O projeto realiza varreduras de redes próximas, acompanha a qualidade do sinal, estima a posição relativa dos pontos de acesso e exibe os dados em um painel 3D.

## Recursos

- Varredura de redes Wi‑Fi
- Monitoramento de sinal, canal, SSID e BSSID
- Estimativa da posição dos pontos de acesso
- Visualização 3D com Three.js
- Monitoramento de eventos via syslog/UDP
- Atualizações em tempo real via WebSocket
- Exportação de relatórios em PDF, DOCX e XLSX

## Tecnologias

- Python
- JavaScript
- HTML e CSS
- Electron
- Three.js
- WebSocket

## Estrutura

```text
.
├── electron/       # Aplicação Electron
├── python/         # Scanner, monitoramento e geração de relatórios
├── src/            # Interface web e visualização 3D
├── monitor.py      # Entrada do backend Python
├── start.js        # Inicialização em modo web
└── package.json
```

## Instalação

Requisitos:

- Python 3.8 ou superior
- Node.js 16 ou superior
- npm

Instale as dependências:

```bash
npm install
pip install -r python/requirements.txt
```

## Execução

Para iniciar o projeto em modo web:

```bash
npm start
```

Para iniciar a aplicação desktop:

```bash
npm run electron
```

Para executar somente o backend:

```bash
python monitor.py
```

O servidor WebSocket usa, por padrão, `127.0.0.1:8765`.

## Observação

As posições dos pontos de acesso são estimadas com base no sinal RSSI. Portanto, a visualização representa posições relativas e não substitui uma triangulação real.
