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
| `data_prev_lib_reefer`, `data_lib_reefer` | Liberação de importação reefer na Embraport; abertura de gate reefer na BTP e na Santos Brasil (ver correções) |
| `status`, `apiVersion`, `mensagemErro`, `qtd_registros`, `timezone` | Mensagens de erro, versão e totais exibidos |

### Correções de leitura

Os dados reais mostram que cada terminal preenche os campos do DSS de um jeito. O portal corrige na leitura e marca cada ajuste no campo `qualidade` do registro (na página: "dados ajustados", com o detalhe ao passar o mouse):

1. **Data "real" no futuro** (abertura de gate da BTP, atracação da Embraport) é tratada como prevista.
2. **BTP e Santos Brasil gravam a abertura de gate reefer em `data_lib_reefer`.** Nesses terminais, o campo vira `aberturaGateReefer`, e a liberação reefer de importação fica vazia.
3. **`data_prev_atracacao` não vem preenchida.** A espera pela atracação é medida a partir da chegada prevista.
4. **Santos Brasil grava a viagem no campo `armador`.** O armador é deduzido pelo mesmo navio em outro registro ou pelo prefixo do nome (MSC, MAERSK→MAE, CMA CGM→CMA, COSCO→COS…), com `armadorOrigem` indicando a fonte.
5. **Datas a mais de 1 ano de hoje** são descartadas e ficam em `datasSuspeitas`.
6. **Saída prevista passou sem atracação informada** (a BTP só informa atracação em parte dos navios): o navio conta como `encerrado`, e não como "aguardando atracação" há dias.

### Situações calculadas

- **Navio:**
  - `previsto`;
  - `aguardando_atracacao`: a chegada prevista passou e o navio não atracou, com as horas de espera;
  - `chegada_passou`: o mesmo caso, num terminal que não informa atracação (hoje, a Santos Brasil);
  - `atracado`;
  - `encerrado`: a saída prevista já passou.
- **Gate dry e gate reefer:** `aguardando` (antes da abertura) → `aberto` (a abertura já passou, até o deadline) → `encerrado` (deadline vencido). Sem datas: `sem_dado`.
- **Liberação de importação dry e reefer:** `liberado`, `previsto`, `atrasado` ou `sem_dado`.

### Erros do DSS

Os códigos 400, 401, 403 e 500 chegam com a mensagem do DSS. Por exemplo, 403 significa que o cliente está sem o módulo `tms_integr_portal_navios` habilitado. Uma resposta em HTML indica que `DSS_URL` aponta para a documentação, não para o endpoint. Se o DSS falhar depois de uma consulta boa, o portal mostra a última resposta válida com um aviso.

## Endpoints

| Rota | Para quê |
|---|---|
| `GET /` | Painel em abas: Visão geral (próximo deadline, indicadores, faixa das próximas 48 h, gráfico de chegadas/deadlines/saídas por dia e por terminal, o que pede atenção e agenda), Navios (tabela ou linha do tempo, com Excel), Mudanças (gráfico por dia e lista) e Qualidade dos dados |
| `GET /api/painel?dias=7` | Tudo o que a página usa, numa chamada só: lista + resumo |
| `GET /api/navios` | Atracações normalizadas com datas, situações e horas calculadas |
| `GET /api/resumo?horas=48` | Contagens por terminal, armador, situação e gate, mais as listas das próximas horas |
| `GET /api/mudancas?horas=24` | Histórico de mudanças (filtros: `navio`, `terminal`, `campo`, `chave`, `desde`, `limite`) |
| `GET /api/navio?chave=btp\|MSCINSA\|NA642R` | Detalhe do navio: datas atuais e todas as mudanças registradas |
| `GET /api/navios.xlsx` (+ filtros) | Excel da visão filtrada: aba "Navios" (todas as datas, situações e ajustes) e aba "Mudanças (7 dias)" |
| `GET /api/qualidade` | Qualidade dos dados por terminal, com achados e texto pronto para enviar ao DSS |
| `GET /api/viagens` | Viagens passadas (`navio`, `terminal`, `armador`, `de`, `ate`, `todas=true`) |
| `GET /api/confiabilidade` | Quanto cada terminal ou armador muda as previsões (`campo`, `agrupar`, `dias`) |
| `GET /api/calendario.ics` | Calendário para o Outlook (`tipos`, `chaves`, `lembrete` + filtros) |
| `GET/POST/DELETE /api/observacoes` | Observações da equipe por navio (POST com JSON `{chave, texto, autor}`) |
| `GET/POST/DELETE /api/armadores` | Tabela de armadores (POST com JSON `{tipo: "navio"\|"viagem", valor, armador, autor}`) |
| `GET /api/etracking` | Situação da integração com o eTracking |
| `GET /tv`, `GET /imprimir` | Modo TV e agenda para imprimir |
| `GET /api/alertas` | Alertas por e-mail: regras, fila, último envio e último erro |
| `GET /api/alertas/teste` | Envia um e-mail de teste para `ALERTA_PARA` (no máximo um a cada 10 min) |
| `GET /api/dss/bruto` | Resposta original do DSS, sem tratamento (consulta na hora) |
| `GET /api/health` | Status, idade do cache, total de registros e último erro do DSS |

Filtros aceitos em `/api/navios` e `/api/resumo`:
- `terminal` (`btp`, `santos_brasil`, `embraport`; aceita vários separados por vírgula);
- `armador`, `navio` (busca por parte do nome) e `viagem`;
- `situacao` e `gate`;
- `de` e `ate` (ISO 8601, sobre a data de atracação real ou prevista);
- `dias` (janela de trabalho: navios até N dias à frente, sem os encerrados e sem registros cuja data mais recente ficou mais de 2 dias para trás; a página usa 7 por padrão);
- `encerrados=true` (inclui os encerrados na janela);
- `ordenar` (`referencia`, `chegada`, `atracacao`, `deadline` ou `navio`);
- `atualizar=true`, que consulta o DSS na hora (no máximo uma vez a cada 15 s).

## Histórico de mudanças

A cada consulta ao DSS, cada atracação (chave `terminal|NAVIO|VIAGEM`) é comparada campo a campo com a consulta anterior: as 11 datas e o armador, como vieram do DSS. Só as diferenças são gravadas, por exemplo:

```json
{ "em": "2026-10-27T14:42:00Z", "navio": "MSC INSA", "viagem": "NA642R", "terminal": "btp",
  "campo": "data_deadline", "rotulo": "Deadline", "de": "2026-10-25 15:00:00", "para": "2026-10-26 11:00:00" }
```

Também ficam registrados os navios que entram na lista do DSS, saem dela ou voltam (`campo: "registro"`). A primeira consulta de todas só serve de base e não gera mudanças.

- **Painel:** bloco "Mudanças nas últimas 24 horas" (só dos navios filtrados), com quanto a data adiou ou antecipou, e o selo "mudou N×" na tabela.
- **Detalhe do navio:** clique no nome do navio para ver a sequência de datas (chegada, gates, deadline, atracação, liberações, saída), o que já passou e o que vem, e todas as mudanças registradas.
- **Onde fica:** com `DATABASE_URL`, no PostgreSQL (tabelas `navios_estado` e `navios_mudancas`, criadas sozinhas; 180 dias guardados). Sem ela, ou se o banco não responder, em memória, e o histórico recomeça a cada reinício do servidor.

## Excel, linha do tempo e qualidade dos dados

- **Exportar Excel:** o botão ao lado dos filtros baixa um `.xlsx` com exatamente o que está filtrado na tela. As datas vêm como datas do Excel, no horário de Brasília, com filtro automático e cabeçalho congelado. A segunda aba traz as mudanças de datas dos últimos 7 dias desses navios.
- **Linha do tempo:** a aba "Linha do tempo", ao lado da tabela, mostra cada navio por terminal, da chegada (ou atracação) até a saída prevista, com a janela do gate dry (abertura até o deadline), o deadline e a linha do "agora". O DSS não informa o berço, então cada linha é um navio. Clicar na barra abre o detalhe.
- **Qualidade dos dados por terminal:**
  - quanto de cada data prevista o DSS preenche;
  - quanto das datas reais é informado quando já deveria existir (a prevista passou há mais de 24 h);
  - armador válido e quantas datas mudaram em 7 dias;
  - achados por gravidade e um texto pronto para copiar e mandar ao DSS ou aos terminais.

  Tudo isso é calculado sobre todos os registros, sem os filtros da tela.

## Ferramentas da equipe

- **Meus navios:** a estrela ao lado do nome marca o navio para acompanhar. Os marcados ficam fixos no topo da lista e num quadro da Visão geral, com destaque quando alguma data mudou desde a última vez que o navio foi aberto. Ficam guardados no navegador de cada pessoa.
- **Observações por navio:** no detalhe do navio, a equipe escreve notas ("booking confirmado", "cliente avisado do atraso"). Ficam no banco (tabela `navios_observacoes`), aparecem como "N obs." na tabela, no Excel e na agenda impressa.
- **Viagens passadas:** a aba lista os navios encerrados ou que saíram da lista do DSS, com atracação real, última saída prevista, quando saíram da lista e quantas datas mudaram. O DSS não informa a saída real. O banco guarda as viagens desde 27/10/2026 (`navios_estado`, com `primeiro_em` e `removido_em`).
- **Confiabilidade das previsões** (aba Mudanças, e `GET /api/confiabilidade?campo=data_prev_chegada&agrupar=terminal&dias=30`): para cada navio, quanto a chegada, o deadline ou a saída andou da primeira à última versão no período. A barra mostra a média entre os navios em que a data mudou, por terminal ou por armador, junto com quantos mudaram. Fica mais confiável com algumas semanas de histórico.
- **Deadlines no Outlook:** o botão "Adicionar ao Outlook" gera um link de calendário (`/api/calendario.ics`) com deadlines e aberturas de gate (e, se quiser, chegadas e atracações), dos filtros atuais, só dos meus navios ou de todos, com lembrete antes do deadline. No Outlook: Calendário > Adicionar calendário > Assinar da Web. O Outlook atualiza sozinho.
- **Modo TV** (`/tv`, aceita `?terminal=btp`): tela cheia escura com relógio, próximos deadlines em contagem regressiva, chegadas de hoje e amanhã, gates abrindo e navios aguardando atracação. Mostra os dados novos logo depois de cada busca no DSS (a cada 10 min) e recarrega uma vez por dia.
- **Agenda para imprimir** (`/imprimir?dia=0|1|2&terminal=`): a agenda do dia em A4 paisagem, com observações da equipe e uma coluna para marcar o que foi feito. "Imprimir ou salvar em PDF" usa a impressão do navegador.
- **Tabela de armadores** (aba Qualidade dos dados): para os navios em que o DSS não traz armador válido, cadastre "este navio" (vale para todas as viagens, inclusive futuras) ou "só esta viagem". A viagem tem prioridade sobre o navio, e o armador do DSS, quando vier certo, sempre vence. Fica no banco (`armadores_mapa`).

Observações e tabela de armadores são gravadas por qualquer pessoa com o link do portal. Antes de divulgar o endereço, vale colocar um login.

## eTracking (pronto para ligar)

A integração já está no código e fica desligada até existir `ETRACKING_URL`. Ligada, o portal busca os contêineres no eTracking a cada `ETRACKING_MINUTOS` (10), encontra o navio de cada um pelo nome do navio + viagem (ou só pela viagem, quando ela é única) e mostra:
- a coluna "Contêineres" na tabela (total e quantos estão fora do terminal);
- no próximo deadline, quantos contêineres da Costalog ainda estão fora do terminal;
- no detalhe do navio, a lista de contêineres com booking, cliente, tipo, situação e entrada no terminal.

`GET /api/etracking` mostra se está configurado, quando consultou, o último erro e os contêineres que não acharam navio (útil para acertar os nomes).

| Variável | Para quê |
|---|---|
| `ETRACKING_URL` | Endereço que devolve os contêineres em JSON. Sem ela, a integração fica desligada |
| `ETRACKING_METODO`, `ETRACKING_CORPO` | `GET` (padrão) ou `POST` com o corpo JSON |
| `ETRACKING_TOKEN`, `ETRACKING_CABECALHO` | Token. Vai em `Authorization: Bearer ...`; outro cabeçalho, como `x-api-key`, em `ETRACKING_CABECALHO` |
| `ETRACKING_USUARIO`, `ETRACKING_SENHA` | Login Basic, se for o caso |
| `ETRACKING_LISTA` | Caminho até a lista na resposta, como `dados.conteineres`. Vazio = a primeira lista encontrada |
| `ETRACKING_CAMPOS` | JSON com o nome de cada campo na resposta: `conteiner`, `navio`, `viagem`, `booking`, `cliente`, `situacao`, `entrada`, `tipo`, `terminal`. Campos com nomes comuns (`container`, `nr_viagem`, `voyage`...) são achados sozinhos |
| `ETRACKING_ENTREGUE` | Expressão que, na situação, indica contêiner já no terminal (padrão `gate.?in\|entregue\|no terminal\|embarcado`). Uma data em `entrada` também conta |
| `ETRACKING_MINUTOS` | Intervalo entre consultas (10) |

Exemplo:

```
ETRACKING_URL=https://etracking.exemplo.com.br/api/conteineres
ETRACKING_TOKEN=...
ETRACKING_LISTA=dados
ETRACKING_CAMPOS={"conteiner":"nr_container","navio":"nm_navio","viagem":"nr_viagem","booking":"nr_booking","cliente":"nm_cliente","situacao":"ds_status","entrada":"dt_gate_in","tipo":"tp_container"}
```

## Alertas por e-mail

Três regras, avaliadas a cada consulta ao DSS, só para navios não encerrados:

| Alerta | Quando |
|---|---|
| Deadline | deadline nas próximas `ALERTA_DEADLINE_HORAS` (24 h) |
| Gate aberto | gate dry ou reefer abriu nas últimas 24 h |
| Data mudou | mudou deadline, chegada, atracação, abertura de gate prevista, saída ou liberação, com diferença de pelo menos `ALERTA_MUDANCA_MIN_HORAS` (1 h) |

Os alertas se juntam num e-mail só, enviado a cada `ALERTA_MINUTOS` (15 min) quando há novidade. O mesmo alerta nunca é enviado duas vezes. Com `DATABASE_URL`, os alertas enviados ficam gravados (tabela `alertas_enviados`); sem ela, a primeira consulta depois de reiniciar só serve de base, para não repetir alertas a cada deploy.

O plano gratuito do Render bloqueia SMTP (portas 25, 465 e 587), então o envio é pela API HTTPS do **Resend** (`RESEND_API_KEY`) ou do **Brevo** (`BREVO_API_KEY` + `ALERTA_DE` com o remetente verificado). No Resend sem domínio verificado, o remetente é `onboarding@resend.dev` e só é possível enviar para o e-mail da própria conta.

## Desempenho

- **Atualização em segundo plano:** o servidor consulta o DSS a cada `CACHE_SEGUNDOS` (600 s = 10 min) e já guarda o resultado normalizado. As páginas nunca esperam pelo DSS. Se ele falhar, o painel mostra a última resposta válida com um aviso.
- **Compressão gzip** em todas as respostas acima de 1 KB, e **ETag**: quando nada mudou, o navegador recebe `304` sem corpo.
- **Uma chamada por carga de página** (`/api/painel`).
- **Janela padrão de 7 dias sem encerrados**, em vez de todas as atracações.
- **Sem hibernação:** no plano gratuito, o Render desliga o serviço após 15 min sem acesso. O servidor faz um ping no próprio endereço público (`RENDER_EXTERNAL_URL`, definido pelo Render) a cada 10 min. As 750 h mensais do plano gratuito cobrem o mês inteiro de um serviço.

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
| `CACHE_SEGUNDOS` | Intervalo da consulta ao DSS em segundo plano (600 s = 10 min). A tela confere a cada minuto e mostra os dados novos logo depois da busca |
| `MANTER_ACORDADO` | `false` desliga o ping contra a hibernação |
| `PING_MINUTOS` | Intervalo do ping (10 min; tem de ser menor que os 15 min do Render) |
| `DATABASE_URL` | PostgreSQL do histórico de mudanças (no Render: *Internal Database URL* do `portal-de-navios-db`) |
| `ALERTA_PARA` | Destinatários dos alertas (vários separados por vírgula) |
| `RESEND_API_KEY` ou `BREVO_API_KEY` | Chave da API de e-mail; sem ela, os alertas ficam desligados |
| `ALERTA_DE` | Remetente (obrigatório no Brevo; no Resend, só com domínio verificado) |
| `ALERTA_MINUTOS`, `ALERTA_DEADLINE_HORAS`, `ALERTA_MUDANCA_MIN_HORAS` | Intervalo do e-mail (15), janela do deadline (24) e mudança mínima em horas (1) |
| `ALERTA_FILTRO` | Restringe os alertas, com os mesmos filtros da API (ex.: `terminal=btp&armador=MSC`) |
| `URL_PUBLICA` | Endereço para o ping, se não estiver no Render (lá é automático) |

Ao iniciar, o servidor escreve no log o endpoint (sem senha), o tipo de login e o resultado de uma consulta de teste ao DSS.

## Rodar localmente

```bash
cp .env.example .env   # preencha DSS_USUARIO e DSS_SENHA
npm start              # http://localhost:3000
npm test
```

Requer Node 20+. O único pacote é o `pg`, usado só quando há `DATABASE_URL` (`npm install`).

## Estrutura

```
src/dss.js         cliente da API do DSS, normalização, situações, filtros e resumo
src/historico.js   histórico de mudanças (PostgreSQL ou memória)
src/alertas.js     alertas por e-mail (regras, fila, Resend/Brevo)
src/qualidade.js   qualidade dos dados por terminal
src/armazem.js     observações e tabela de armadores (PostgreSQL ou memória)
src/confiabilidade.js  quanto cada terminal/armador muda as previsões
src/ics.js         calendário .ics para o Outlook
src/etracking.js   integração com o eTracking (desligada até ter ETRACKING_URL)
src/xlsx.js        gerador de .xlsx sem dependências
src/server.js      rotas HTTP e página
public/index.html  painel, detalhe do navio e ferramentas da equipe
public/tv.html     modo TV
public/imprimir.html  agenda do dia para imprimir ou salvar em PDF
test/              testes com o DSS simulado (PG_TESTE_URL=... testa também com PostgreSQL)
```
