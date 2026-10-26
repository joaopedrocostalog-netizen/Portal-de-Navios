# Portal de Navios

API que **prevê a entrada de contêineres no porto a partir da chegada dos navios**.

| Fonte | O que entrega |
|---|---|
| **DSS (TMS) – Portal de Navios** | Fonte principal. Atracações por terminal: previsão de chegada e atracação, deadline, abertura de gate, liberação de dry e reefer (módulo `tms_integr_portal_navios`) |
| [Shipxy](https://apidocs.shipxy.com) (Shipfinder) | ETA e posição dos navios pelo AIS, para conferir a previsão do DSS; busca de portos |
| PostgreSQL (próprio) | Contêineres monitorados: navio em que vêm, carga perigosa, histórico |
| eTracking | **Nenhuma fonte ligada.** A VesselFinder foi removida por ser paga. Há um ponto de encaixe pronto em `src/services/etracking.js` para ligar outra fonte |

Sem DSS e sem Shipxy, tudo responde em **modo demonstração** (`"fonte": "demo"`, navios com nome `DEMO …`).

## Como funciona

1. O DSS devolve as atracações (todas as datas em UTC; a API devolve em ISO 8601 com `Z`).
2. A Shipxy devolve os navios com ETA para o porto pelo AIS. Cada atracação do DSS é cruzada com o AIS **pelo nome do navio**, o que traz MMSI, IMO, posição e o ETA real. Se a chegada prevista no DSS e o ETA do AIS diferirem mais que `TOLERANCIA_DIVERGENCIA_HORAS` (24 h), a previsão aponta uma **divergência** para conferir.
3. Você cadastra cada contêiner informando **o navio em que ele vem** (nome, MMSI ou IMO), e a previsão mostra, para cada atracação, quais contêineres monitorados estão nela, agrupados por dia.

Entram na janela as atracações previstas entre agora (com 1 dia de tolerância para atrasos) e o fim do período, e os navios atracados que ainda não têm saída prevista vencida. Navios que a Shipxy vê chegando ao porto mas que não estão no DSS (outros terminais) aparecem à parte em `naviosSomenteAis`.

Se uma das fontes falhar, a previsão segue com a outra e explica o problema em `avisos`. Sem DSS, a lista da Shipxy vira a lista principal.

## Publicação no Render

O serviço `portal-de-navios` publica automaticamente a cada commit na branch `main`. Variáveis em **portal-de-navios › Environment**:

| Variável | Obrigatória | Para quê |
|---|---|---|
| `NAVIOS_OF_DSS` (ou `DSS_URL`) | sim | Endereço completo do endpoint Portal de Navios do DSS (`https://…`) |
| `DSS_USUARIO`, `DSS_SENHA` | sim | Login do DSS (Basic Auth). Também podem ir embutidos na URL: `https://usuario:senha@host/caminho` |
| `DSS_TOKEN` | não | Use no lugar de usuário/senha se o DSS autenticar por token (`Authorization: Bearer`) |
| `SHIPXY_API_KEY` | recomendada | Chave **de servidor** da Shipxy (console em api.shipxy.com). Sem ela, a previsão usa só o DSS |
| `DATABASE_URL` | recomendada | *Internal Database URL* do `portal-de-navios-db`. Sem ela, os contêineres ficam em memória e somem quando o serviço reinicia |
| `PORTO_PADRAO` | não | Código de porto **da Shipxy** (padrão `BRSSZ`). A Shipxy usa códigos próprios, que podem diferir do UN/LOCODE. Descubra com `/api/portos?busca=santos` |
| `PORTO_NOME` | não | Nome do porto buscado no diagnóstico da inicialização (padrão `Santos`) |
| `VERIFICAR_FONTES` | não | `false` desliga as consultas de diagnóstico ao DSS e à Shipxy feitas ao iniciar |
| `DIAS_PADRAO`, `TOLERANCIA_DIVERGENCIA_HORAS`, `INTERVALO_TEMPO_REAL_MS`, `CORS_ORIGIN` | não | Ajustes finos |

### Diagnóstico na inicialização

Ao iniciar, o servidor escreve no log (aba **Logs** do Render):
- os **nomes** das variáveis de configuração presentes (nunca os valores) e se `NAVIOS_OF_DSS` é uma URL (mostra só host e caminho);
- o resultado de uma consulta ao DSS: quantas atracações, terminais e exemplos, ou a mensagem de erro dele (401, 403, 500);
- o resultado de `SearchPort` para `PORTO_PADRAO` e `PORTO_NOME` (mostra o código certo do porto na Shipxy);
- o resultado de `GetETAShips` para os próximos 7 dias. Se a chave não tiver a permissão avançada, aparece a mensagem de erro da Shipxy.

## Endpoints

Todas as rotas aceitam `?incluirBruto=true` para anexar a resposta original do DSS e da Shipxy (para conferir o que cada uma devolve).

| Método | Rota | Para quê |
|---|---|---|
| GET | `/api/health` | Status, banco em uso e fontes configuradas |
| GET | `/api/previsao-entrada?porto=BRSSZ&dias=7&terminal=btp` | **Principal.** Atracações do DSS + ETA do AIS + contêineres monitorados em cada navio. `terminal` é opcional |
| GET | `/api/dss/atracacoes?terminal=btp` | Atracações do DSS normalizadas (use `incluirBruto=true` para ver a resposta original) |
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
  "terminal": "btp",
  "janela": { "inicio": "…", "fim": "…", "dias": 7 },
  "fontes": { "atracacoes": "dss", "ais": "shipxy" },
  "avisos": [],
  "resumo": {
    "totalNavios": 8,
    "naviosComConteineresMonitorados": 2,
    "naviosSomenteAis": 4,
    "totalConteineresPrevistos": 5,
    "totalDivergencias": 1,
    "porDia": { "2026-10-27": { "navios": 3, "conteineres": 2 } }
  },
  "navios": [
    {
      "fonte": "dss",
      "nome": "MSC ANNA", "viagem": "123S", "armador": "MSC", "terminal": "btp",
      "situacao": "previsto",
      "eta": "2026-10-27T12:00:00.000Z",
      "datas": {
        "deadline": "…", "prevChegada": "2026-10-27T12:00:00.000Z", "prevAtracacao": "…", "atracacao": null,
        "prevSaida": "…", "prevAberturaGate": "…", "aberturaGate": "…",
        "prevLiberacaoDry": "…", "liberacaoDry": null, "prevLiberacaoReefer": "…", "liberacaoReefer": null
      },
      "mmsi": "123456789", "imo": "9876543",
      "ais": { "mmsi": "123456789", "imo": "9876543", "eta": "2026-10-27T11:00:00.000Z", "destino": "SANTOS", "posicao": { "lat": -24.2, "lon": -45.9 } },
      "diferencaHorasAisParaDss": -1,
      "totalConteineres": 2,
      "conteineres": [{ "numero": "MSCU1234566", "armador": "MSCU", "perigoso": false }]
    }
  ],
  "naviosSomenteAis": [],
  "semNavioNaLista": [],
  "divergencias": [
    { "tipo": "chegada-dss-x-ais", "navio": "MAERSK ESSEN", "viagem": "045W",
      "chegadaDss": "…", "etaAis": "…", "diferencaHoras": 40 }
  ]
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
  services/dss.js           atracações (DSS – Portal de Navios do TMS)
  services/shipxy.js        navios e portos (Shipxy)
  services/etracking.js     ponto de encaixe do eTracking (sem fonte ligada)
  services/conteineres.js   sincronização com o eTracking
  services/previsao.js      previsão de entrada (combina tudo)
  services/demo.js          dados de demonstração
public/index.html           página para testar a API
render.yaml                 blueprint do Render
```
