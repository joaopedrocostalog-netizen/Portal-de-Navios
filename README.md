# Portal de Navios

API que **prevê a entrada de contêineres no porto a partir da chegada dos navios** e confere essa previsão com o **eTracking** de cada contêiner.

| Fonte | O que entrega aqui | Origem da ideia |
|---|---|---|
| [Shipxy](https://apidocs.shipxy.com) | Navios com chegada prevista ao porto (ETA pelo AIS) e posição atual de um navio | Shipxy MCP Server |
| [VesselFinder Container Tracking](https://apis.io/apis/vesselfinder/vesselfinder-containers-api/) | eTracking do contêiner: navio, eventos, ETA no destino | VesselFinder wrapper |
| PostgreSQL (próprio) | Cadastro dos contêineres monitorados, carga perigosa e histórico de eventos | PortManager |

Sem chaves configuradas, cada fonte responde em **modo demonstração** (`"fonte": "demo"`, navios com nome `DEMO …`). Assim dá para publicar e testar antes de contratar as APIs.

## Publicar no Render

1. No [Render](https://dashboard.render.com): **New › Blueprint** e escolha este repositório. O arquivo `render.yaml` cria:
   - o web service `portal-de-navios` (Node 20, plano free, `/api/health` como health check);
   - o banco `portal-de-navios-db` (PostgreSQL, plano free), já ligado pela variável `DATABASE_URL`.
2. O Render pede `SHIPXY_API_KEY` e `VESSELFINDER_API_KEY`. Preencha agora ou depois.
3. Para adicionar ou trocar as chaves depois: **portal-de-navios › Environment › Edit**. O Render faz um novo deploy sozinho.
4. Abra a URL do serviço: a página inicial mostra quais fontes estão ativas e permite testar tudo.

Avisos do plano free do Render: o serviço "dorme" depois de um tempo sem acesso (a primeira chamada demora), e o Postgres gratuito tem prazo de validade. Confira os limites no painel antes de usar em produção.

## Endpoints

Todas as rotas aceitam `?incluirBruto=true` para anexar a resposta original da fonte. Serve para **confirmar o que cada API devolve**.

| Método | Rota | Para quê |
|---|---|---|
| GET | `/api/health` | Status, banco em uso e quais fontes estão configuradas |
| GET | `/api/previsao-entrada?porto=BRSSZ&dias=7` | **Principal.** Navios chegando + contêineres monitorados em cada um + divergências de ETA |
| GET | `/api/navios/chegadas?porto=BRSSZ&dias=7` | Só os navios previstos (Shipxy `GetETAShips`) |
| GET | `/api/navios/{mmsi}` | Posição atual de um navio (Shipxy `GetSingleShip`) |
| GET | `/api/conteineres/{numero}/rastreio?armador=AUTO` | Consulta o eTracking **sem gravar** |
| POST | `/api/conteineres` | Cadastra contêiner para monitorar (e já sincroniza com o eTracking) |
| GET | `/api/conteineres` | Lista os monitorados (`?situacao=monitorando`) |
| GET | `/api/conteineres/{numero}` | Detalhe + histórico de eventos |
| POST | `/api/conteineres/{numero}/sincronizar` | Atualiza o contêiner com o eTracking |
| DELETE | `/api/conteineres/{numero}` | Para de monitorar |
| WS | `/ws` | Atualizações em tempo real (ver abaixo) |

### Como a previsão é montada

1. A Shipxy devolve os navios com ETA para o porto na janela pedida.
2. Cada contêiner monitorado é ligado a um navio por **MMSI**, **IMO** ou **nome** (o eTracking preenche esses dados ao sincronizar).
3. O ETA do eTracking é comparado com o ETA do navio. Diferença acima de `TOLERANCIA_DIVERGENCIA_HORAS` (24 h por padrão) entra em `divergencias`.
4. Contêineres que o eTracking diz chegar a este porto na janela, mas cujo navio não está na lista da Shipxy, aparecem em `semNavioNaLista` (navio trocado, transbordo ou ETA desatualizado).

Resposta resumida:

```json
{
  "porto": "BRSSZ",
  "janela": { "inicio": "2026-10-26T18:00:00.000Z", "fim": "2026-11-02T18:00:00.000Z", "dias": 7 },
  "fontes": { "navios": "shipxy" },
  "resumo": {
    "totalNavios": 3,
    "naviosComConteineresMonitorados": 2,
    "totalConteineresPrevistos": 4,
    "totalDivergencias": 1,
    "porDia": { "2026-10-27": { "navios": 1, "conteineres": 2 } }
  },
  "navios": [
    {
      "mmsi": "710000001", "imo": "9000001", "nome": "NOME DO NAVIO",
      "eta": "2026-10-27T12:00:00.000Z",
      "posicao": { "lat": -24.2, "lon": -45.9, "velocidade": 14.2, "rumo": 40, "atualizadoEm": "…" },
      "totalConteineres": 2,
      "conteineres": [
        { "numero": "MSCU1234566", "armador": "MSCU", "perigoso": false,
          "etaEtracking": "2026-10-27T14:00:00.000Z", "diferencaHorasParaEtaNavio": 2 }
      ]
    }
  ],
  "semNavioNaLista": [],
  "divergencias": [
    { "conteiner": "HLXU8001005", "navio": "NOME DO NAVIO",
      "etaNavioAis": "…", "etaEtracking": "…", "diferencaHoras": 30 }
  ]
}
```

### Cadastrar contêiner

```bash
curl -X POST https://SEU-SERVICO.onrender.com/api/conteineres \
  -H 'content-type: application/json' \
  -d '{"numero":"MSCU1234566","armador":"MSCU","descricao":"Peças","perigoso":false}'
```

Campos: `numero` (obrigatório, 4 letras + 7 dígitos), `armador` (SCAC ou `AUTO`), `descricao`, `perigoso`, `classeRisco`, `navioMmsi`, `navioImo`, `navioNome`, `sincronizar` (padrão `true`). A resposta informa se o dígito verificador ISO 6346 confere (`digitoVerificadorValido`).

### eTracking em fila (HTTP 202)

A VesselFinder às vezes processa a consulta em segundo plano. Nesse caso a API devolve **202** com `tenteNovamenteEmSegundos` (mínimo 60) e o cabeçalho `Retry-After`. Repita a mesma chamada depois desse tempo.

### Tempo real (WebSocket)

```js
const ws = new WebSocket('wss://SEU-SERVICO.onrender.com/ws');
ws.onopen = () => ws.send(JSON.stringify({ acao: 'acompanhar-porto', porto: 'BRSSZ', dias: 7 }));
// ou { acao: 'acompanhar-navio', mmsi: '710000001' } / { acao: 'parar', chave: 'porto:BRSSZ:7' }
ws.onmessage = (m) => console.log(JSON.parse(m.data)); // { tipo: 'atualizacao', chave, em, dados }
```

Cada assunto é consultado uma vez por `INTERVALO_TEMPO_REAL_MS`, não importa quantos clientes estejam ouvindo, para não gastar créditos das APIs.

## O que conferir quando as chaves chegarem

O código segue a documentação pública das duas APIs, mas alguns pontos só dá para confirmar com uma chave real. Use `?incluirBruto=true` e compare:

- **Shipxy**: o `GetETAShips` é serviço avançado (a chave precisa dessa permissão). O código trata `status: 0` como sucesso e qualquer outro valor como erro, mostrando o `msg`. Confira também a unidade de `sog` (velocidade) e se o `port_code` aceita o UN/LOCODE brasileiro (ex.: `BRSSZ`).
- **VesselFinder**: confira o formato de `general.destination` (o locode do destino é extraído dele para calcular o ETA) e de `schedule[].timestamp`.

## Rodar localmente

Requer Node 20+.

```bash
npm install
cp .env.example .env   # opcional: preencha as chaves
npm start              # http://localhost:3000
npm test
```

Sem `DATABASE_URL`, os dados ficam em memória e o servidor cadastra 4 contêineres de exemplo para a previsão já mostrar resultado.

## Estrutura

```
src/
  server.js              inicia HTTP + WebSocket
  app.js                 rotas da API (http nativo do Node)
  realtime.js            WebSocket /ws
  config.js              variáveis de ambiente
  util.js                validações, datas, dígito verificador ISO 6346
  db/schema.sql          tabelas conteineres e eventos_conteiner
  db/index.js            armazenamento PostgreSQL ou memória
  services/shipxy.js     navios (Shipxy)
  services/vesselfinder.js  eTracking (VesselFinder)
  services/conteineres.js   sincronização com o eTracking
  services/previsao.js   previsão de entrada (combina tudo)
  services/demo.js       dados de demonstração
public/index.html        página para testar a API
render.yaml              blueprint do Render
```
