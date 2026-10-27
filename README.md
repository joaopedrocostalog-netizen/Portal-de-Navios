# Portal de Navios

API que **prevê a entrada de contêineres a partir das atracações** informadas pela API **Portal de Navios do DSS** (TMS, módulo `tms_integr_portal_navios`).

O DSS é a única fonte de dados externa. Os contêineres monitorados ficam num cadastro próprio (PostgreSQL).

## Como funciona

1. O DSS devolve as atracações por terminal: chegada e atracação previstas, atracação real, saída prevista, deadline, abertura de gate e liberação de dry e reefer. Todas as datas vêm em UTC (`AAAA-MM-DD HH:MM:SS`); a API devolve em ISO 8601 com `Z`.
2. Entram na janela da previsão:
   - as atracações previstas entre agora (com 1 dia de tolerância para atrasos) e o fim do período;
   - os navios atracados cuja saída prevista ainda não passou.
3. Você cadastra cada contêiner com **o nome do navio como aparece no DSS** e, se quiser, **a viagem**. Com a viagem, o contêiner só entra naquela viagem; sem ela, entra em qualquer viagem do navio.
4. A previsão mostra, para cada atracação, quais contêineres monitorados vêm nela, agrupados por dia. Contêineres sem atracação na janela aparecem em `semAtracacaoNaJanela`, para conferir nome e viagem.

## Publicação no Render

O serviço `portal-de-navios` publica automaticamente a cada commit na branch `main`. Variáveis em **portal-de-navios › Environment**:

| Variável | Obrigatória | Para quê |
|---|---|---|
| `NAVIOS_OF_DSS` (ou `DSS_URL`) | sim | Endereço completo do endpoint Portal de Navios do DSS (`https://…`). No Swagger: **Try it out › Execute › Request URL** |
| `DSS_USUARIO`, `DSS_SENHA` | sim | Login do DSS (Basic Auth). Também podem ir embutidos na URL: `https://usuario:senha@host/caminho` |
| `DSS_TOKEN` | não | Use no lugar de usuário/senha se o DSS autenticar por token (`Authorization: Bearer`) |
| `DATABASE_URL` | recomendada | *Internal Database URL* do `portal-de-navios-db`. Sem ela, os contêineres ficam em memória e somem quando o serviço reinicia |
| `TERMINAL_PADRAO` | não | Terminal usado quando a previsão é pedida sem filtro (ex.: `btp`) |
| `DIAS_PADRAO` | não | Tamanho padrão da janela (7 dias) |
| `VERIFICAR_FONTES` | não | `false` desliga a consulta de diagnóstico ao DSS feita ao iniciar |
| `INTERVALO_TEMPO_REAL_MS`, `TIMEOUT_HTTP_MS`, `CORS_ORIGIN` | não | Ajustes finos |

### Diagnóstico na inicialização

Ao iniciar, o servidor escreve no log (aba **Logs** do Render):
- os **nomes** das variáveis de configuração presentes (nunca os valores);
- se `NAVIOS_OF_DSS` é uma URL (mostra só host e caminho) e o tipo de autenticação usado;
- o resultado de uma consulta ao DSS: quantas atracações, terminais e exemplos, ou a mensagem de erro dele (401, 403, 500).

## Endpoints

| Método | Rota | Para quê |
|---|---|---|
| GET | `/api/health` | Status, banco em uso e se o DSS está configurado |
| GET | `/api/previsao-entrada?dias=7&terminal=btp` | **Principal.** Atracações na janela + contêineres monitorados em cada uma |
| GET | `/api/dss/atracacoes?terminal=btp` | Todas as atracações do DSS, normalizadas |
| POST | `/api/conteineres` | Cadastra ou atualiza um contêiner monitorado |
| GET | `/api/conteineres` | Lista os monitorados (`?situacao=monitorando`) |
| GET | `/api/conteineres/{numero}` | Detalhe de um contêiner |
| DELETE | `/api/conteineres/{numero}` | Para de monitorar |
| WS | `/ws` | Previsão em tempo real |

`/api/previsao-entrada` e `/api/dss/atracacoes` aceitam `?incluirBruto=true` para anexar a resposta original do DSS (para conferir o que ele devolve).

Erros do DSS chegam com a mensagem dele: 401 (usuário/senha), 403 (cliente sem o módulo `tms_integr_portal_navios`) e 500 (falha no TMS) viram **502** na nossa API, com `erro` e `detalhes`.

### Cadastrar contêiner

```bash
curl -X POST https://portal-de-navios.onrender.com/api/conteineres \
  -H 'content-type: application/json' \
  -d '{"numero":"MSCU1234566","armador":"MSCU","navioNome":"MSC INSA","navioViagem":"NA642R","perigoso":false}'
```

Campos: `numero` (obrigatório, 4 letras + 7 dígitos), `navioNome` (obrigatório no primeiro cadastro), `navioViagem`, `armador` (SCAC ou `AUTO`), `descricao`, `perigoso`, `classeRisco`, `situacao` (`monitorando`, `entregue` ou `arquivado`). Enviar de novo o mesmo número atualiza só os campos enviados. A resposta informa se o dígito verificador ISO 6346 confere (`digitoVerificadorValido`).

Na página inicial, o botão **Usar navio** da previsão preenche navio e viagem no formulário de cadastro.

### Previsão (resposta resumida)

```json
{
  "terminal": "btp",
  "timezone": "UTC",
  "janela": { "inicio": "…", "fim": "…", "dias": 7 },
  "fonte": "dss",
  "resumo": {
    "totalNavios": 14,
    "atracados": 6,
    "previstos": 8,
    "naviosComConteineresMonitorados": 2,
    "totalConteineresPrevistos": 3,
    "porDia": { "2026-10-28": { "navios": 3, "conteineres": 2 } }
  },
  "navios": [
    {
      "navio": "MSC INSA", "viagem": "NA642R", "armador": "MSC", "terminal": "btp",
      "situacao": "previsto",
      "chegada": "2026-10-22T16:00:00.000Z",
      "datas": {
        "deadline": "2026-10-25T12:00:00.000Z", "prevChegada": "2026-10-22T16:00:00.000Z",
        "prevAtracacao": "2026-10-27T19:00:00.000Z", "atracacao": null, "prevSaida": "2026-10-28T20:00:00.000Z",
        "prevAberturaGate": "…", "aberturaGate": "…",
        "prevLiberacaoDry": "…", "liberacaoDry": null, "prevLiberacaoReefer": "…", "liberacaoReefer": null
      },
      "totalConteineres": 1,
      "conteineres": [{ "numero": "MSCU1234566", "armador": "MSCU", "perigoso": false }]
    }
  ],
  "semAtracacaoNaJanela": []
}
```

### Tempo real (WebSocket)

```js
const ws = new WebSocket('wss://portal-de-navios.onrender.com/ws');
ws.onopen = () => ws.send(JSON.stringify({ acao: 'acompanhar-previsao', dias: 7, terminal: 'btp' }));
// para parar: { acao: 'parar', chave: 'previsao:btp:7' }
ws.onmessage = (m) => console.log(JSON.parse(m.data)); // { tipo: 'atualizacao', chave, em, dados }
```

Cada assunto é consultado uma vez por `INTERVALO_TEMPO_REAL_MS`, não importa quantos clientes estejam ouvindo, para não sobrecarregar o DSS.

## Rodar localmente

Requer Node 20+.

```bash
npm install
cp .env.example .env   # preencha NAVIOS_OF_DSS, DSS_USUARIO e DSS_SENHA
npm start              # http://localhost:3000
npm test
```

## Estrutura

```
src/
  server.js              inicia HTTP + WebSocket e faz o diagnóstico do DSS
  app.js                 rotas da API (http nativo do Node)
  realtime.js            WebSocket /ws
  config.js              variáveis de ambiente
  util.js                validações e dígito verificador ISO 6346
  db/schema.sql          tabela conteineres
  db/index.js            armazenamento PostgreSQL ou memória
  services/dss.js        API Portal de Navios do DSS
  services/previsao.js   previsão de entrada
  services/http.js       chamada HTTP com tempo limite
public/index.html        página para usar a API
render.yaml              blueprint do Render
```
