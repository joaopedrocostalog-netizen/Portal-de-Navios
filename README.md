# Portal de Navios

Painel e API em cima da **API Portal de Navios do DSS** (TMS, módulo `tms_integr_portal_navios`): atracações dos terminais BTP, Santos Brasil e Embraport, janelas de gate para a entrada de contêineres de exportação e liberações de importação. Sem banco de dados e sem dependências externas.

## A API do DSS e como ela é usada

`GET https://costalog.dssinformatica.com.br/wsdss/navios/listarNavios` com `Authorization: Basic` (usuário de integração do DSS). Todas as datas vêm em UTC (`AAAA-MM-DD HH:MM:SS`).

| Campo do DSS | Uso no portal |
|---|---|
| `navio`, `nro_viagem`, `armador`, `terminal` | Identificação, filtros e contagens por terminal e armador |
| `data_prev_chegada` | Chegadas previstas nas próximas horas |
| `data_prev_atracacao`, `data_atracacao` | Situação do navio e atraso da atracação (real − previsto) |
| `data_prev_saida` | Navio encerrado quando a saída prevista passa; tempo previsto no berço |
| `data_prev_abertura_gate`, `data_abertura_gate` | Situação do gate e atraso da abertura |
| `data_deadline` | Fim da janela de gate; horas que faltam até o deadline |
| `data_prev_lib_dry`, `data_lib_dry` | Liberação de importação dry: liberado, previsto ou atrasado |
| `data_prev_lib_reefer`, `data_lib_reefer` | Liberação de importação reefer: idem |
| `status`, `apiVersion`, `mensagemErro`, `qtd_registros`, `timezone` | Mensagens de erro, versão e totais exibidos |

### Situações calculadas

- **Navio:** `previsto` → `atracacao_atrasada` (a atracação prevista passou e o navio não atracou) → `atracado` → `encerrado` (atracou e a saída prevista já passou).
- **Gate:** `aguardando` (antes da abertura) → `aberto` (abertura real informada ou prevista já passou, até o deadline) → `encerrado` (deadline passou). Sem datas de gate: `sem_dado`.
- **Liberação dry e reefer:** `liberado` (há data real), `previsto`, `atrasado` (a prevista passou sem data real) ou `sem_dado`.

### Erros do DSS

Os códigos 400, 401, 403 e 500 chegam com a mensagem do DSS. Por exemplo, 403 significa que o cliente está sem o módulo `tms_integr_portal_navios` habilitado. Uma resposta em HTML indica que `DSS_URL` aponta para a documentação, não para o endpoint. Se o DSS falhar depois de uma consulta boa, o portal mostra a última resposta válida com um aviso.

## Endpoints

| Rota | Para quê |
|---|---|
| `GET /` | Painel: cartões por situação, próximas 48 h (deadlines, aberturas de gate, chegadas, atracações, liberações, atrasos) e tabela completa com filtros |
| `GET /api/navios` | Atracações normalizadas com datas, situações e horas calculadas |
| `GET /api/resumo?horas=48` | Contagens por terminal, armador, situação e gate, mais as listas das próximas horas |
| `GET /api/dss/bruto` | Resposta original do DSS, sem tratamento (consulta na hora) |
| `GET /api/health` | Status |

Filtros aceitos em `/api/navios` e `/api/resumo`:
- `terminal` (`btp`, `santos_brasil`, `embraport`; aceita vários separados por vírgula);
- `armador`, `navio` (busca por parte do nome) e `viagem`;
- `situacao` e `gate`;
- `de` e `ate` (ISO 8601, sobre a data de atracação real ou prevista);
- `ordenar` (`referencia`, `chegada`, `atracacao`, `deadline` ou `navio`);
- `atualizar=true`, que ignora o cache.

Exemplo de item de `/api/navios`:

```json
{
  "navio": "MSC INSA", "viagem": "NA642R", "armador": "MSC", "terminal": "btp", "timezone": "UTC",
  "datas": {
    "prevChegada": "2026-10-22T16:00:00.000Z", "prevAtracacao": "2026-10-27T19:00:00.000Z", "atracacao": null,
    "prevSaida": "2026-10-28T20:00:00.000Z", "prevAberturaGate": "2026-10-24T13:00:00.000Z", "aberturaGate": "2026-10-24T13:00:00.000Z",
    "deadline": "2026-10-25T12:00:00.000Z", "prevLiberacaoDry": null, "liberacaoDry": null, "prevLiberacaoReefer": null, "liberacaoReefer": null
  },
  "situacao": { "navio": "previsto", "gate": "encerrado", "dry": "sem_dado", "reefer": "sem_dado" },
  "horas": { "atrasoAtracacao": null, "atrasoAberturaGate": 0, "atrasoLiberacaoDry": null, "atrasoLiberacaoReefer": null, "ateDeadline": null, "janelaGate": 23, "estadia": 25 },
  "referencia": "2026-10-27T19:00:00.000Z"
}
```

## Configuração (Render › portal-de-navios › Environment)

| Variável | Para quê |
|---|---|
| `DSS_URL` | `https://costalog.dssinformatica.com.br/wsdss/navios/listarNavios` |
| `DSS_USUARIO`, `DSS_SENHA` | Usuário de integração do DSS |
| `DSS_TOKEN` | Só se o DSS autenticar por token em vez de usuário e senha |
| `CACHE_SEGUNDOS` | Por quanto tempo a resposta do DSS é reaproveitada (60 s) |

Ao iniciar, o servidor escreve no log o endpoint (sem senha), o tipo de login e o resultado de uma consulta de teste ao DSS.

## Rodar localmente

```bash
cp .env.example .env   # preencha DSS_USUARIO e DSS_SENHA
npm start              # http://localhost:3000
npm test
```

Requer Node 20+. Não há pacotes para instalar.

## Estrutura

```
src/dss.js         cliente da API do DSS, normalização, situações, filtros e resumo
src/server.js      rotas HTTP e página
public/index.html  painel
test/dss.test.js   testes com o DSS simulado
```
