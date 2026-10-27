# Portal de Navios

API que **prevê a entrada de contêineres a partir das atracações** informadas pela API **Portal de Navios do DSS** (TMS, módulo `tms_integr_portal_navios`).

Segundo a documentação do DSS, essas atracações são capturadas dos portais dos terminais (BTP, Santos Brasil e Embraport). Como complemento, dá para **importar a planilha da BTP** (botão Download do Portal do Cliente BTP), que traz chegada e saída reais, navio *na barra*, berço, RAP e serviço. Os contêineres monitorados ficam num cadastro próprio (PostgreSQL).

## Como funciona

1. O DSS devolve as atracações por terminal: chegada e atracação previstas, atracação real, saída prevista, deadline, abertura de gate e liberação de dry e reefer. Todas as datas vêm em UTC (`AAAA-MM-DD HH:MM:SS`); a API devolve em ISO 8601 com `Z`.
2. Entram na janela da previsão:
   - as atracações previstas entre agora (com 1 dia de tolerância para atrasos) e o fim do período;
   - os navios atracados cuja saída prevista ainda não passou.
3. Você cadastra cada contêiner com **o nome do navio como aparece no DSS** e, se quiser, **a viagem**. Com a viagem, o contêiner só entra naquela viagem; sem ela, entra em qualquer viagem do navio.
4. A previsão mostra, para cada atracação, quais contêineres monitorados vêm nela, agrupados por dia. Contêineres sem atracação na janela aparecem em `semAtracacaoNaJanela`, para conferir nome e viagem.

## Planilha da BTP

No [Portal do Cliente BTP › Lista de atracação](https://portaldocliente.btp.com.br/sistemas/processos-logisticos/ConsultasLivres/listaatracacaoindex), clique em **Download** e importe o arquivo pela página inicial (ou `POST /api/btp/planilha`).

- **Formatos:** `.xlsx`, `.xls` exportado como tabela HTML (formato comum em sites) e `.csv`. O `.xls` binário antigo (Excel 97-2003) é recusado com a orientação de salvar como `.xlsx` ou CSV.
- **Colunas** reconhecidas pelo título, em qualquer ordem: RAP, Navio, Viagem, Agência, Dt. Prev. Chegada, Dt. Chegada, Dt. Prev. Atrac., Dt. Atracação, Dt. Prev. Saída, Dt. Saída, Abertura de Gate Dry, Abertura de Gate Reefer, Dead-Line, Serviço e Berço.
- **Horário:** a BTP usa o horário de Brasília; as datas são convertidas para UTC, como as do DSS.
- **Status**, com a mesma regra da tela da BTP: tem saída → *desatracado*; tem atracação → *atracado*; tem chegada → *na barra*; só previsões → *previsto*.
- **Na previsão,** a planilha mais recente complementa cada atracação do terminal BTP (status, berço, RAP, chegada e saída reais). Se o DSS estiver indisponível, a previsão usa a planilha como fonte e mostra um aviso.
- **Comparação** (`GET /api/btp/comparacao`): cruza a planilha com as atracações `btp` do DSS por navio e viagem e aponta diferenças acima de `TOLERANCIA_HORAS` (1 h), navios com viagem diferente e navios que só aparecem de um lado.

O site da BTP não tem API, usa proteção contra robôs (Incapsula) e reCAPTCHA. Por isso a importação é feita com o arquivo baixado, e não lendo o site automaticamente.

## Publicação no Render

O serviço `portal-de-navios` publica automaticamente a cada commit na branch `main`. Variáveis em **portal-de-navios › Environment**:

| Variável | Obrigatória | Para quê |
|---|---|---|
| `DSS_URL` (ou `NAVIOS_OF_DSS`) | sim | Endereço do endpoint: `https://costalog.dssinformatica.com.br/wsdss/navios/listarNavios` |
| `DSS_USUARIO`, `DSS_SENHA` | sim | Login do DSS (Basic Auth). Também podem ir embutidos na URL: `https://usuario:senha@host/caminho` |
| `DSS_TOKEN` | não | Use no lugar de usuário/senha se o DSS autenticar por token (`Authorization: Bearer`) |
| `DATABASE_URL` | recomendada | *Internal Database URL* do `portal-de-navios-db`. Sem ela, os contêineres ficam em memória e somem quando o serviço reinicia |
| `TERMINAL_PADRAO` | não | Terminal usado quando a previsão é pedida sem filtro (ex.: `btp`) |
| `DIAS_PADRAO` | não | Tamanho padrão da janela (7 dias) |
| `TOLERANCIA_HORAS` | não | Diferença entre DSS e planilha da BTP que vira divergência (1 h) |
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
| POST | `/api/btp/planilha?nome=arquivo.xlsx` | Importa a planilha da BTP (o corpo é o próprio arquivo, até 10 MB) |
| GET | `/api/btp/lineup` | Última planilha importada (registros em UTC e contagem por status) |
| GET | `/api/btp/comparacao?tolerancia=1` | Planilha da BTP × DSS |
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
  db/schema.sql          tabelas conteineres e importacoes_btp
  db/index.js            armazenamento PostgreSQL ou memória
  services/dss.js        API Portal de Navios do DSS
  services/btp.js        planilha da BTP: colunas, datas, status e comparação com o DSS
  services/planilha.js   leitura de .xlsx, .xls (HTML) e .csv sem dependências
  services/previsao.js   previsão de entrada
  services/http.js       chamada HTTP com tempo limite
public/index.html        página para usar a API
test/arquivos/           planilhas de exemplo da BTP nos formatos aceitos
render.yaml              blueprint do Render
```
