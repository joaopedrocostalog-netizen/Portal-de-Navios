# Portal de Navios

API que **prevê a entrada de contêineres no porto a partir da chegada dos navios**.

| Fonte | O que entrega |
|---|---|
| [Shipxy](https://apidocs.shipxy.com) (Shipfinder) | Navios com chegada prevista ao porto (ETA pelo AIS), posição de um navio, busca de portos |
| PostgreSQL (próprio) | Contêineres monitorados: navio em que vêm, carga perigosa, histórico |
| eTracking | **Nenhuma fonte ligada.** A VesselFinder foi removida por ser paga. Há um ponto de encaixe pronto em `src/services/etracking.js` para ligar outra fonte |

Sem a chave da Shipxy, tudo responde em **modo demonstração** (`"fonte": "demo"`, navios com nome `DEMO …`).

## Como funciona

1. A Shipxy devolve os navios com chegada prevista ao porto nos próximos dias.
2. Você cadastra cada contêiner informando **o navio em que ele vem** (nome, MMSI ou IMO).
3. A previsão junta as duas coisas: para cada navio chegando, quais contêineres monitorados estão nele, agrupados por dia.

Se no futuro uma fonte de eTracking for ligada, a previsão também compara o ETA do contêiner com o ETA do navio e aponta divergências.

## Publicação no Render

O serviço `portal-de-navios` publica automaticamente a cada commit na branch `main`. Variáveis em **portal-de-navios › Environment**:

| Variável | Obrigatória | Para quê |
|---|---|---|
| `SHIPXY_API_KEY` | sim | Chave da Shipxy |
| `DATABASE_URL` | recomendada | *Internal Database URL* do `portal-de-navios-db`. Sem ela, os contêineres ficam em memória e somem quando o serviço reinicia |
| `PORTO_PADRAO` | não | Código de porto **da Shipxy** (padrão `BRSSZ`). A Shipxy usa códigos próprios, que podem diferir do UN/LOCODE. Descubra com `/api/portos?busca=santos` |
| `PORTO_NOME` | não | Nome do porto buscado no diagnóstico da inicialização (padrão `Santos`) |
| `VERIFICAR_FONTES` | não | `false` desliga as consultas de diagnóstico à Shipxy feitas ao iniciar |
| `DIAS_PADRAO`, `TOLERANCIA_DIVERGENCIA_HORAS`, `INTERVALO_TEMPO_REAL_MS`, `CORS_ORIGIN` | não | Ajustes finos |

### Diagnóstico na inicialização

Ao iniciar, o servidor escreve no log (aba **Logs** do Render):
- os **nomes** das variáveis de configuração presentes (nunca os valores);
- o resultado de `SearchPort` para `PORTO_PADRAO` e `PORTO_NOME` (mostra o código certo do porto na Shipxy);
- o resultado de `GetETAShips` para os próximos 7 dias. Se a chave não tiver a permissão avançada, aparece a mensagem de erro da Shipxy.

## Endpoints

Todas as rotas aceitam `?incluirBruto=true` para anexar a resposta original da Shipxy (para conferir o que ela devolve).

| Método | Rota | Para quê |
|---|---|---|
| GET | `/api/health` | Status, banco em uso e fontes configuradas |
| GET | `/api/previsao-entrada?porto=BRSSZ&dias=7` | **Principal.** Navios chegando + contêineres monitorados em cada um |
| GET | `/api/navios/chegadas?porto=BRSSZ&dias=7` | Só os navios previstos (Shipxy `GetETAShips`) |
| GET | `/api/navios/{mmsi}` | Posição atual de um navio (Shipxy `GetSingleShip`) |
| GET | `/api/portos?busca=santos` | Código do porto na Shipxy (`SearchPort`) |
| POST | `/api/conteineres` | Cadastra ou atualiza um contêiner monitorado |
| GET | `/api/conteineres` | Lista os monitorados (`?situacao=monitorando`) |
| GET | `/api/conteineres/{numero}` | Detalhe + histórico de eventos |
| DELETE | `/api/conteineres/{numero}` | Para de monitorar |
| GET | `/api/conteineres/{numero}/rastreio` | eTracking avulso. Responde **501** enquanto não houver fonte ligada |
| POST | `/api/conteineres/{numero}/sincronizar` | Atualiza pelo eTracking. Responde **501** enquanto não houver fonte ligada |
| WS | `/ws` | Atualizações em tempo real |

### Cadastrar contêiner

```bash
curl -X POST https://portal-de-navios.onrender.com/api/conteineres \
  -H 'content-type: application/json' \
  -d '{"numero":"MSCU1234566","armador":"MSCU","navioNome":"MSC ANNA","navioMmsi":"123456789","perigoso":false}'
```

Campos: `numero` (obrigatório, 4 letras + 7 dígitos), `armador` (SCAC ou `AUTO`), `navioNome`, `navioMmsi`, `navioImo`, `descricao`, `perigoso`, `classeRisco`, `situacao`. Enviar de novo o mesmo número atualiza o cadastro. A resposta informa se o dígito verificador ISO 6346 confere (`digitoVerificadorValido`).

Na página inicial, o botão **Usar navio** da previsão preenche os dados do navio no formulário de cadastro.

### Previsão (resposta resumida)

```json
{
  "porto": "BRSSZ",
  "janela": { "inicio": "…", "fim": "…", "dias": 7 },
  "fontes": { "navios": "shipxy" },
  "resumo": {
    "totalNavios": 12,
    "naviosComConteineresMonitorados": 2,
    "totalConteineresPrevistos": 5,
    "totalDivergencias": 0,
    "porDia": { "2026-10-27": { "navios": 3, "conteineres": 2 } }
  },
  "navios": [
    {
      "mmsi": "123456789", "imo": "9876543", "nome": "MSC ANNA", "eta": "2026-10-27T12:00:00.000Z",
      "posicao": { "lat": -24.2, "lon": -45.9, "velocidade": 14.2, "rumo": 40, "atualizadoEm": "…" },
      "totalConteineres": 2,
      "conteineres": [{ "numero": "MSCU1234566", "armador": "MSCU", "perigoso": false }]
    }
  ],
  "semNavioNaLista": [],
  "divergencias": []
}
```

### Tempo real (WebSocket)

```js
const ws = new WebSocket('wss://portal-de-navios.onrender.com/ws');
ws.onopen = () => ws.send(JSON.stringify({ acao: 'acompanhar-porto', porto: 'BRSSZ', dias: 7 }));
// ou { acao: 'acompanhar-navio', mmsi: '123456789' } / { acao: 'parar', chave: 'porto:BRSSZ:7' }
ws.onmessage = (m) => console.log(JSON.parse(m.data)); // { tipo: 'atualizacao', chave, em, dados }
```

Cada assunto é consultado uma vez por `INTERVALO_TEMPO_REAL_MS`, não importa quantos clientes estejam ouvindo, para economizar consultas à Shipxy.

## Ligar uma fonte de eTracking

Edite `src/services/etracking.js`: faça `configurada()` retornar `true` quando a chave existir e implemente `rastrear(numero, armador)` devolvendo os dados no formato descrito no topo do arquivo. O resto (cadastro, histórico de eventos, comparação de ETA na previsão) já usa essa função.

## Rodar localmente

Requer Node 20+.

```bash
npm install
cp .env.example .env   # opcional: preencha a chave
npm start              # http://localhost:3000
npm test
```

Sem `DATABASE_URL`, os dados ficam em memória. Sem `SHIPXY_API_KEY`, o servidor também cadastra 4 contêineres de exemplo para a previsão já mostrar resultado.

## Estrutura

```
src/
  server.js                 inicia HTTP + WebSocket e faz o diagnóstico da Shipxy
  app.js                    rotas da API (http nativo do Node)
  realtime.js               WebSocket /ws
  config.js                 variáveis de ambiente
  util.js                   validações, datas, dígito verificador ISO 6346
  db/schema.sql             tabelas conteineres e eventos_conteiner
  db/index.js               armazenamento PostgreSQL ou memória
  services/shipxy.js        navios e portos (Shipxy)
  services/etracking.js     ponto de encaixe do eTracking (sem fonte ligada)
  services/conteineres.js   sincronização com o eTracking
  services/previsao.js      previsão de entrada (combina tudo)
  services/demo.js          dados de demonstração
public/index.html           página para testar a API
render.yaml                 blueprint do Render
```
