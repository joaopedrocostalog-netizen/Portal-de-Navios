'use strict';

// Portal de Navios: API e páginas em cima da API Portal de Navios do DSS.
//
//   GET /api/painel?dias=7 (+ filtros)    tudo que a página precisa, numa chamada só (lista + resumo)
//   GET /api/navios?terminal=&armador=&navio=&viagem=&situacao=&gate=&de=&ate=&dias=&encerrados=&ordenar=
//   GET /api/resumo?horas=48 (+ os mesmos filtros)
//   GET /api/mudancas?horas=24&navio=&terminal=&campo=   histórico de mudanças das datas
//   GET /api/navio?chave=terminal|NAVIO|VIAGEM           detalhe: datas, mudanças, observações e contêineres
//   GET /api/navios.xlsx (+ filtros)                      Excel da visão filtrada e das mudanças de 7 dias
//   GET /api/viagens?navio=&terminal=&armador=&de=&ate=&todas=   viagens passadas (desde que o banco começou)
//   GET /api/confiabilidade?campo=&agrupar=&dias=         quanto cada terminal/armador muda as previsões
//   GET /api/calendario.ics?tipos=deadline,gate (+ filtros, chaves=)   calendário para assinar no Outlook
//   GET/POST/DELETE /api/observacoes                      observações da equipe por navio
//   GET/POST/DELETE /api/armadores                        tabela viagem/navio -> armador
//   GET /api/etracking                                    situação da integração com o eTracking
//   GET /api/qualidade, /api/alertas, /api/dss/bruto, /api/health
//   GET /, /tv, /imprimir                                 painel, modo TV e agenda para imprimir
//
// Desempenho: o DSS é consultado em segundo plano (as páginas nunca esperam por ele), as respostas vão
// comprimidas com gzip e com ETag (o navegador recebe 304 quando nada mudou), e no Render o servidor
// faz um ping no próprio endereço público para não hibernar.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { criarCliente, filtrar, resumir, normalizarTodos, ErroDss } = require('./dss');
const { iniciarHistorico, criarMemoria, chaveDe, rotuloCampo } = require('./historico');
const { criarAlertas, criarEnvio } = require('./alertas');
const { criarXlsx } = require('./xlsx');
const { avaliarQualidade, textoQualidade, PROBLEMAS } = require('./qualidade');
const { iniciarArmazem, criarMemoria: criarArmazemMemoria, criarMapa, ErroDado, so } = require('./armazem');
const { avaliarConfiabilidade, frases, CAMPOS: CAMPOS_CONFIABILIDADE } = require('./confiabilidade');
const { criarCalendario } = require('./ics');
const { criarEtracking, resumoNavio } = require('./etracking');

const env = process.env;
const config = {
  porta: Number(env.PORT) || 3000,
  dssUrl: [env.DSS_URL, env.NAVIOS_OF_DSS].map((v) => String(v || '').trim()).find((v) => /^https?:\/\//i.test(v)) || '',
  cacheSegundos: Number(env.CACHE_SEGUNDOS) || 60,
  // Render define RENDER_EXTERNAL_URL; o ping a cada 10 min evita a hibernação do plano gratuito (15 min sem acesso).
  urlPublica: env.URL_PUBLICA || env.RENDER_EXTERNAL_URL || '',
  manterAcordado: env.MANTER_ACORDADO !== 'false',
  pingMinutos: Number(env.PING_MINUTOS) || 10,
};

const pagina = (nome) => fs.readFileSync(path.join(__dirname, '..', 'public', nome));
const PAGINAS = { '/': pagina('index.html'), '/index.html': pagina('index.html'), '/tv': pagina('tv.html'), '/imprimir': pagina('imprimir.html') };
const ORDENS = {
  referencia: (r) => r.referencia,
  chegada: (r) => r.datas.prevChegada,
  atracacao: (r) => r.datas.atracacao || r.datas.prevAtracacao,
  deadline: (r) => r.datas.deadline,
  navio: (r) => r.navio,
};

function criarClientePadrao(aoAtualizar = null) {
  if (!config.dssUrl) return null;
  return criarCliente({ url: config.dssUrl, usuario: env.DSS_USUARIO, senha: env.DSS_SENHA, token: env.DSS_TOKEN, cacheSegundos: config.cacheSegundos, aoAtualizar });
}

const HORA = 36e5;
const DIA = 24 * HORA;
const comRotulo = (m) => ({ ...m, rotulo: rotuloCampo(m.campo, m.terminal) });

// ------------------------------------------------------------------ tabela de armadores
/** Aplica a tabela viagem/navio -> armador onde o DSS não traz um armador válido. Guarda o resultado por consulta. */
function criarAjusteArmadores(armazem) {
  let mapa = criarMapa([]);
  let versao = 0;
  const memo = new WeakMap();
  return {
    async recarregar() {
      mapa = criarMapa(await armazem.armadores.listar());
      versao += 1;
    },
    aplicar(registros) {
      if (!mapa.tamanho) return registros;
      const m = memo.get(registros);
      if (m && m.versao === versao) return m.resultado;
      const resultado = registros.map((n) => {
        if (n.armadorOrigem === 'dss') return n;
        const armador = mapa.viagem.get(so(n.viagem)) || mapa.navio.get(so(n.navio));
        return armador ? { ...n, armador, armadorOrigem: 'tabela de armadores' } : n;
      });
      memo.set(registros, { versao, resultado });
      return resultado;
    },
  };
}

// ------------------------------------------------------------------ exportação para Excel
const SITUACAO = {
  previsto: 'Previsto', aguardando_atracacao: 'Aguardando atracação', chegada_passou: 'Chegada passou', atracado: 'Atracado', encerrado: 'Encerrado',
  aguardando: 'Aguardando', aberto: 'Aberto', sem_dado: 'Sem dado', liberado: 'Liberado', atrasado: 'Atrasado',
};
const TERMINAL = { btp: 'BTP', santos_brasil: 'Santos Brasil', embraport: 'Embraport (DPW)' };
const sit = (v) => SITUACAO[v] || v || '';
const dssIso = (v) => (v ? `${String(v).replace(' ', 'T')}Z` : null);

function planilhaNavios(navios, observacoes = {}) {
  const colunas = [
    ['Navio', 'texto', 24], ['Viagem', 'texto', 12], ['Armador', 'texto', 10], ['Origem do armador', 'texto', 14], ['Terminal', 'texto', 16], ['Situação', 'texto', 20],
    ['Chegada prevista', 'data'], ['Atracação prevista', 'data'], ['Atracação', 'data'], ['Espera atracação (h)', 'numero', 12], ['Saída prevista', 'data'],
    ['Gate dry', 'texto', 12], ['Abertura gate prevista', 'data'], ['Abertura gate', 'data'],
    ['Gate reefer', 'texto', 12], ['Abertura gate reefer prevista', 'data'], ['Abertura gate reefer', 'data'],
    ['Deadline', 'data'], ['Horas até deadline', 'numero', 12],
    ['Liberação dry', 'texto', 12], ['Liberação dry prevista', 'data'], ['Liberação dry real', 'data'],
    ['Liberação reefer', 'texto', 12], ['Liberação reefer prevista', 'data'], ['Liberação reefer real', 'data'],
    ['Datas que mudaram (24 h)', 'numero', 12], ['Observações da equipe', 'texto', 40], ['Dados ajustados', 'texto', 40],
  ];
  return {
    nome: 'Navios',
    colunas: colunas.map(([titulo, tipo, largura]) => ({ titulo, tipo, largura })),
    linhas: navios.map((n) => [
      n.navio, n.viagem, n.armador, n.armadorOrigem && n.armadorOrigem !== 'dss' ? n.armadorOrigem : '', TERMINAL[n.terminal] || n.terminal, sit(n.situacao.navio),
      n.datas.prevChegada, n.datas.prevAtracacao, n.datas.atracacao, n.horas.esperaAtracacao === null ? null : Math.round(n.horas.esperaAtracacao), n.datas.prevSaida,
      sit(n.situacao.gate), n.datas.prevAberturaGate, n.datas.aberturaGate,
      sit(n.situacao.gateReefer), n.datas.prevAberturaGateReefer, n.datas.aberturaGateReefer,
      n.datas.deadline, n.horas.ateDeadline,
      sit(n.situacao.dry), n.datas.prevLiberacaoDry, n.datas.liberacaoDry,
      sit(n.situacao.reefer), n.datas.prevLiberacaoReefer, n.datas.liberacaoReefer,
      n.mudancas24h || 0,
      (observacoes[n.chave] || []).map((o) => `${o.texto} (${o.autor})`).join(' | '),
      n.qualidade.filter((q) => PROBLEMAS[q.problema]).map((q) => `${q.campo}: ${PROBLEMAS[q.problema]}`).join('; '),
    ]),
  };
}

function planilhaMudancas(mudancas) {
  return {
    nome: 'Mudanças (7 dias)',
    colunas: [
      { titulo: 'Quando', tipo: 'data' }, { titulo: 'Navio', largura: 24 }, { titulo: 'Viagem', largura: 12 }, { titulo: 'Terminal', largura: 16 },
      { titulo: 'Campo', largura: 26 }, { titulo: 'De', tipo: 'data' }, { titulo: 'Para', tipo: 'data' }, { titulo: 'Diferença (h)', tipo: 'numero', largura: 12 }, { titulo: 'Observação', largura: 22 },
    ],
    linhas: mudancas
      .filter((m) => m.campo !== 'armador')
      .map((m) => {
        const registro = m.campo === 'registro';
        const de = registro ? null : dssIso(m.de);
        const para = registro ? null : dssIso(m.para);
        const dif = de && para ? Math.round((Date.parse(para) - Date.parse(de)) / HORA) : null;
        const obs = registro ? { novo: 'entrou na lista do DSS', removido: 'saiu da lista do DSS', voltou: 'voltou à lista do DSS' }[m.para] : !de ? 'data informada' : !para ? 'data apagada' : '';
        return [m.em, m.navio, m.viagem, TERMINAL[m.terminal] || m.terminal, rotuloCampo(m.campo, m.terminal), de, para, dif, obs];
      }),
  };
}

// ------------------------------------------------------------------ servidor
async function lerCorpo(req) {
  if (!/application\/json/.test(req.headers['content-type'] || '')) throw new ErroDado('Envie os dados como JSON.');
  let tamanho = 0;
  const partes = [];
  for await (const p of req) {
    tamanho += p.length;
    if (tamanho > 16 * 1024) throw new ErroDado('Dados grandes demais.');
    partes.push(p);
  }
  try {
    return JSON.parse(Buffer.concat(partes).toString() || '{}');
  } catch {
    throw new ErroDado('JSON inválido.');
  }
}

function criarServidor(cliente = criarClientePadrao(), historico = criarMemoria(), alertas = null, armazem = criarArmazemMemoria(), etracking = null, ajuste = criarAjusteArmadores(armazem)) {
  const pronto = ajuste.recarregar().catch((e) => console.error('[armadores]', e.message));

  async function dados(q) {
    if (!cliente) throw new ErroDss('DSS não configurado: defina DSS_URL com o endereço do endpoint listarNavios.', 503);
    await pronto;
    const r = await cliente.listar({ forcar: q.atualizar === 'true' });
    return { ...r, registros: ajuste.aplicar(r.registros) };
  }

  /** Cada navio ganha a chave do histórico, quantas datas mudaram em 24 h, observações e contêineres do eTracking. */
  async function enriquecer(navios) {
    const contagem = historico.contarPorChave(new Date(Date.now() - DIA).toISOString());
    const obs = await armazem.observacoes.contar();
    const ct = etracking ? etracking.cruzar(navios.map((n) => ({ ...n, chave: chaveDe(n) }))).porChave : null;
    return navios.map((n) => {
      const chave = chaveDe(n);
      const extra = { chave };
      if (contagem[chave]) extra.mudancas24h = contagem[chave];
      if (obs[chave]) extra.observacoes = obs[chave];
      if (ct) extra.conteineres = resumoNavio(ct.get(chave));
      return { ...n, ...extra };
    });
  }

  async function lista(r, q) {
    const ordem = ORDENS[q.ordenar] || ORDENS.referencia;
    const navios = await enriquecer(filtrar(r.registros, q).sort((a, b) => String(ordem(a) ?? '~').localeCompare(String(ordem(b) ?? '~'))));
    return {
      consultadoEm: r.consultadoEm,
      aviso: r.aviso,
      apiVersion: r.apiVersion,
      timezone: r.timezone,
      qtdRegistrosDss: r.qtdRegistros,
      total: navios.length,
      terminais: [...new Set(r.registros.map((x) => x.terminal).filter(Boolean))].sort(),
      armadores: [...new Set(r.registros.map((x) => x.armador).filter(Boolean))].sort(),
      navios,
    };
  }

  /** Todas as viagens já vistas (banco), normalizadas e com a tabela de armadores aplicada. */
  function viagensConhecidas(agora = Date.now()) {
    const vs = historico.viagens ? historico.viagens() : [];
    const norm = ajuste.aplicar(normalizarTodos(vs.map((v) => v.bruto), agora));
    return vs.map((v, i) => ({ ...norm[i], chave: v.chave, removido: v.removido, primeiroEm: v.primeiroEm || null, vistoEm: v.vistoEm || null, removidoEm: v.removidoEm || null }));
  }

  const horasResumo = (q) => Math.min(Math.max(Number(q.horas) || 48, 1), 24 * 30);

  const rotas = {
    '/api/health': async () => {
      const r = cliente ? await cliente.listar().catch((e) => ({ erro: e.message })) : null;
      return {
        ok: true,
        dss: cliente ? 'configurado' : 'não configurado',
        cacheSegundos: config.cacheSegundos,
        historico: historico.tipo,
        armazem: armazem.tipo,
        etracking: etracking ? 'configurado' : 'não configurado',
        ...(r?.consultadoEm ? { consultadoEm: r.consultadoEm, idadeSegundos: Math.round((Date.now() - Date.parse(r.consultadoEm)) / 1000), registros: r.qtdRegistros } : {}),
        ...(r?.aviso || r?.erro ? { erro: r.aviso || r.erro } : {}),
      };
    },
    '/api/painel': async (q) => {
      const r = await dados(q);
      const l = await lista(r, q);
      // Mudanças das últimas 24 h, só dos navios que estão na visão filtrada.
      const chaves = new Set(l.navios.map((n) => n.chave));
      const mudancas = (await historico.listar({ desde: new Date(Date.now() - DIA).toISOString(), limite: 5000 }))
        .filter((m) => chaves.has(m.chave))
        .slice(0, 100)
        .map(comRotulo);
      const a = alertas?.estado();
      const resumoAlertas = a?.ativo ? { para: a.para, ultimoEnvio: a.ultimoEnvio?.em || null, erro: a.ultimoErro?.mensagem || null } : null;
      return { ...l, historico: historico.tipo, etracking: Boolean(etracking), alertas: resumoAlertas, mudancas, resumo: resumir(filtrar(r.registros, q), { horas: horasResumo(q) }) };
    },
    // Histórico: ?horas=24 (ou desde=ISO) &terminal= &navio= &campo= &chave= &limite=
    '/api/mudancas': async (q) => {
      const horas = Math.min(Math.max(Number(q.horas) || 24, 1), 24 * 365);
      const desde = q.desde || new Date(Date.now() - horas * HORA).toISOString();
      const mudancas = await historico.listar({ desde, chave: q.chave, terminal: q.terminal, navio: q.navio, campo: q.campo, limite: Math.min(Number(q.limite) || 500, 20000) });
      return { historico: historico.tipo, desde, total: mudancas.length, mudancas: mudancas.map(comRotulo) };
    },
    // Detalhe de um navio: ?chave=terminal|NAVIO|VIAGEM (ou terminal=&navio=&viagem=)
    '/api/navio': async (q) => {
      const chave = q.chave || chaveDe({ terminal: q.terminal, navio: q.navio, viagem: q.viagem });
      const r = await dados({});
      let navio = r.registros.find((n) => chaveDe(n) === chave);
      let passado = null;
      if (!navio) {
        const v = viagensConhecidas().find((x) => x.chave === chave);
        if (v) {
          navio = v;
          passado = { removido: v.removido, primeiroEm: v.primeiroEm, removidoEm: v.removidoEm };
        }
      }
      const mudancas = (await historico.listar({ chave, limite: 1000 })).map(comRotulo);
      if (!navio && !mudancas.length) throw new ErroDss(`Navio ${chave} não está na lista do DSS nem no histórico.`, 404);
      const observacoes = await armazem.observacoes.listar(chave);
      const conteineres = etracking && navio ? etracking.cruzar([{ ...navio, chave }]).porChave.get(chave) || [] : null;
      return { chave, consultadoEm: r.consultadoEm, historico: historico.tipo, navio: navio ? { ...navio, chave } : null, passado, mudancas, observacoes, conteineres };
    },
    '/api/navios': async (q) => lista(await dados(q), q),
    '/api/resumo': async (q) => {
      const r = await dados(q);
      return { consultadoEm: r.consultadoEm, aviso: r.aviso, ...resumir(filtrar(r.registros, q), { horas: horasResumo(q) }) };
    },
    // Excel da visão filtrada (mesmos filtros de /api/navios) + mudanças dos últimos 7 dias desses navios.
    '/api/navios.xlsx': async (q) => {
      const l = await lista(await dados(q), q);
      const chaves = new Set(l.navios.map((n) => n.chave));
      const mudancas = (await historico.listar({ desde: new Date(Date.now() - 7 * DIA).toISOString(), limite: 20000 })).filter((m) => chaves.has(m.chave));
      const obs = {};
      for (const o of await armazem.observacoes.listar()) if (chaves.has(o.chave)) (obs[o.chave] ||= []).push(o);
      const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      return { arquivo: criarXlsx([planilhaNavios(l.navios, obs), planilhaMudancas(mudancas)]), nome: `portal-de-navios-${hoje}.xlsx`, tipo: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    },
    // Viagens passadas: as que o banco guarda (encerradas ou que saíram da lista do DSS).
    '/api/viagens': async (q) => {
      const agora = Date.now();
      const r = await dados({});
      const atuais = new Map(r.registros.map((n) => [chaveDe(n), n]));
      const busca = so(q.navio);
      const de = q.de ? Date.parse(q.de) : null;
      const ate = q.ate ? Date.parse(q.ate) + DIA : null;
      const mud = await historico.listar({ desde: new Date(agora - 180 * DIA).toISOString(), limite: 50000 });
      const nMud = {};
      for (const m of mud) if (m.campo !== 'registro') nMud[m.chave] = (nMud[m.chave] || 0) + 1;
      const lista = viagensConhecidas(agora)
        .map((v) => (atuais.has(v.chave) && !v.removido ? { ...atuais.get(v.chave), chave: v.chave, removido: false, primeiroEm: v.primeiroEm, removidoEm: null } : v))
        .filter((v) => q.todas === 'true' || v.removido || v.situacao.navio === 'encerrado')
        .filter((v) => !busca || so(v.navio).includes(busca) || so(v.viagem).includes(busca))
        .filter((v) => !q.terminal || v.terminal === q.terminal)
        .filter((v) => !q.armador || so(v.armador) === so(q.armador))
        .filter((v) => {
          const ref = Date.parse(v.datas.atracacao || v.datas.prevSaida || v.referencia || v.datas.prevChegada || '');
          return (!de || ref >= de) && (!ate || ref < ate);
        })
        .sort((a, b) => String(b.datas.prevSaida || b.referencia || '').localeCompare(String(a.datas.prevSaida || a.referencia || '')));
      return {
        historico: historico.tipo,
        desde: viagensConhecidas(agora).reduce((min, v) => (v.primeiroEm && (!min || v.primeiroEm < min) ? v.primeiroEm : min), null),
        total: lista.length,
        viagens: lista.slice(0, Math.min(Number(q.limite) || 300, 2000)).map((v) => ({
          chave: v.chave, navio: v.navio, viagem: v.viagem, armador: v.armador, armadorOrigem: v.armadorOrigem, terminal: v.terminal, situacao: v.situacao, datas: v.datas, horas: v.horas,
          removido: v.removido, primeiroEm: v.primeiroEm, removidoEm: v.removidoEm, mudancas: nMud[v.chave] || 0,
        })),
      };
    },
    // Confiabilidade: ?campo=data_prev_chegada|data_deadline|data_prev_saida &agrupar=terminal|armador &dias=30
    '/api/confiabilidade': async (q) => {
      const campo = CAMPOS_CONFIABILIDADE[q.campo] ? q.campo : 'data_prev_chegada';
      const agrupar = q.agrupar === 'armador' ? 'armador' : 'terminal';
      const dias = Math.min(Math.max(Number(q.dias) || 30, 1), 180);
      const desde = Date.now() - dias * DIA;
      await dados({});
      const mudancas = await historico.listar({ desde: new Date(desde).toISOString(), limite: 50000 });
      const brutos = new Map(historico.viagens().map((v) => [v.chave, v.bruto]));
      const navios = viagensConhecidas()
        .filter((v) => !v.removido || Date.parse(v.removidoEm || v.vistoEm || 0) >= desde)
        .filter((v) => !q.terminal || v.terminal === q.terminal)
        .map((v) => {
          const b = brutos.get(v.chave) || {};
          return { chave: v.chave, terminal: v.terminal, armador: v.armador, navio: v.navio, viagem: v.viagem, campos: new Set(Object.keys(CAMPOS_CONFIABILIDADE).filter((c) => b[c] && String(b[c]).trim())) };
        });
      const filtradas = q.terminal ? mudancas.filter((m) => m.terminal === q.terminal) : mudancas;
      const grupos = avaliarConfiabilidade(filtradas, navios, { campo, agrupar });
      const primeiro = historico.viagens().reduce((min, v) => (v.primeiroEm && (!min || v.primeiroEm < min) ? v.primeiroEm : min), null);
      return { campo, agrupar, dias, desde: new Date(desde).toISOString(), historicoDesde: primeiro, historico: historico.tipo, grupos, frases: frases(grupos, { campo, agrupar }).slice(0, 5) };
    },
    // Calendário para o Outlook: ?tipos=deadline,gate,chegada,atracacao &chaves=a,b (+ filtros de /api/navios)
    '/api/calendario.ics': async (q) => {
      const r = await dados(q);
      const chaves = q.chaves ? new Set(String(q.chaves).split(',')) : null;
      const navios = filtrar(r.registros, { ...q, dias: undefined })
        .map((n) => ({ ...n, chave: chaveDe(n) }))
        .filter((n) => !chaves || chaves.has(n.chave));
      const tipos = new Set(String(q.tipos || 'deadline,gate').split(',').map((t) => t.trim()).filter(Boolean));
      const nome = q.nome ? String(q.nome).slice(0, 60) : `Portal de Navios${q.terminal ? ` - ${TERMINAL[q.terminal] || q.terminal}` : ''}${chaves ? ' - meus navios' : ''}`;
      const lembrete = q.lembrete === undefined ? 120 : Math.max(0, Math.min(Number(q.lembrete) || 0, 24 * 60));
      const ics = criarCalendario(navios, { tipos, url: config.urlPublica, nome, lembreteMin: lembrete });
      return { arquivo: Buffer.from(ics), nome: 'portal-de-navios.ics', tipo: 'text/calendar; charset=utf-8', inline: true };
    },
    '/api/observacoes': async (q) => ({ armazem: armazem.tipo, observacoes: await armazem.observacoes.listar(q.chave) }),
    // Tabela de armadores + os navios atuais sem armador válido.
    '/api/armadores': async () => {
      const r = await dados({});
      const regras = await armazem.armadores.listar();
      const semArmador = r.registros
        .filter((n) => n.armadorOrigem !== 'dss')
        .map((n) => ({ chave: chaveDe(n), navio: n.navio, viagem: n.viagem, terminal: n.terminal, armador: n.armador, armadorOrigem: n.armadorOrigem, referencia: n.referencia }))
        .sort((a, b) => (a.armador ? 1 : 0) - (b.armador ? 1 : 0) || a.navio.localeCompare(b.navio));
      const conhecidos = [...new Set(r.registros.filter((n) => n.armadorOrigem === 'dss').map((n) => n.armador).concat(regras.map((x) => x.armador)))].filter(Boolean).sort();
      return { armazem: armazem.tipo, regras, semArmador, conhecidos };
    },
    '/api/etracking': async () => {
      if (!etracking) {
        return { configurado: false, ajuda: 'Defina ETRACKING_URL (e, se precisar, ETRACKING_TOKEN ou ETRACKING_USUARIO/ETRACKING_SENHA, ETRACKING_LISTA e ETRACKING_CAMPOS). Veja o README.' };
      }
      const r = await dados({});
      return etracking.estado(r.registros.map((n) => ({ ...n, chave: chaveDe(n) })));
    },
    // Qualidade dos dados por terminal (sobre tudo o que o DSS enviou, sem filtros).
    '/api/qualidade': async () => {
      const r = await dados({});
      const mudancas = await historico.listar({ desde: new Date(Date.now() - 7 * DIA).toISOString(), limite: 50000 });
      const terminais = avaliarQualidade(r.bruto.registros, r.registros, mudancas);
      return { consultadoEm: r.consultadoEm, historico: historico.tipo, terminais, texto: textoQualidade(terminais) };
    },
    // Situação dos alertas por e-mail: regras, fila, último envio e último erro.
    '/api/alertas': async () => (alertas ? alertas.estado() : { ativo: false }),
    // Envia um e-mail de teste para ALERTA_PARA (no máximo um a cada 10 min).
    '/api/alertas/teste': async () => {
      if (!alertas) throw new ErroDss('Alertas não configurados.', 503);
      try {
        return await alertas.testar();
      } catch (e) {
        throw new ErroDss(e.message, 400);
      }
    },
    '/api/dss/bruto': async (q) => (await dados({ ...q, atualizar: 'true' })).bruto,
  };

  // Gravações. Só aceitam JSON: um formulário de outro site não consegue enviar JSON sem permissão (CORS).
  const escritas = {
    'POST /api/observacoes': async (q, corpo) => ({ observacao: await armazem.observacoes.adicionar(corpo) }),
    'DELETE /api/observacoes': async (q) => ({ removida: await armazem.observacoes.remover(q.id) }),
    'POST /api/armadores': async (q, corpo) => {
      const regra = await armazem.armadores.salvar(corpo);
      await ajuste.recarregar();
      return { regra };
    },
    'DELETE /api/armadores': async (q) => {
      const removida = await armazem.armadores.remover(q.id);
      await ajuste.recarregar();
      return { removida };
    },
  };

  /** Envia com ETag (304 quando o navegador já tem a mesma versão) e gzip quando o navegador aceita. */
  function enviar(req, res, status, corpo, tipo = 'application/json; charset=utf-8', extras = {}) {
    let buffer = Buffer.isBuffer(corpo) ? corpo : Buffer.from(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
    const etag = `W/"${crypto.createHash('sha1').update(buffer).digest('base64url').slice(0, 22)}"`;
    const cabecalhos = {
      ...extras,
      'content-type': tipo,
      'cache-control': 'no-cache',
      etag,
      vary: 'accept-encoding',
      'access-control-allow-origin': env.CORS_ORIGIN || '*',
    };
    if (status === 200 && req.method === 'GET' && req.headers['if-none-match'] === etag) {
      res.writeHead(304, cabecalhos);
      return res.end();
    }
    if (buffer.length > 1024 && !/zip|sheet/.test(tipo) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      buffer = zlib.gzipSync(buffer, { level: 6 });
      cabecalhos['content-encoding'] = 'gzip';
    }
    cabecalhos['content-length'] = buffer.length;
    res.writeHead(status, cabecalhos);
    return res.end(buffer);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const caminho = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;
    const q = Object.fromEntries(url.searchParams);
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (PAGINAS[caminho]) return enviar(req, res, 200, PAGINAS[caminho], 'text/html; charset=utf-8');
        const rota = rotas[caminho];
        if (!rota) return enviar(req, res, 404, { erro: `Rota ${url.pathname} não existe.` });
        const resultado = await rota(q);
        if (resultado?.arquivo) {
          const disp = resultado.inline ? `inline; filename="${resultado.nome}"` : `attachment; filename="${resultado.nome}"`;
          return enviar(req, res, 200, resultado.arquivo, resultado.tipo, { 'content-disposition': disp });
        }
        return enviar(req, res, 200, resultado);
      }
      const escrita = escritas[`${req.method} ${caminho}`];
      if (!escrita) return enviar(req, res, 405, { erro: 'Método não permitido.' });
      const corpo = req.method === 'POST' ? await lerCorpo(req) : {};
      return enviar(req, res, 200, await escrita(q, corpo));
    } catch (e) {
      if (e instanceof ErroDss || e instanceof ErroDado) return enviar(req, res, e.status, { erro: e.message, ...(e.detalhes ? { detalhes: e.detalhes } : {}) });
      console.error(e);
      return enviar(req, res, 500, { erro: 'Erro interno.' });
    }
  });
}

async function main() {
  const historico = await iniciarHistorico();
  const armazem = await iniciarArmazem();
  const ajuste = criarAjusteArmadores(armazem);
  await ajuste.recarregar().catch((e) => console.log(`[armadores] ${e.message}`));
  const etracking = criarEtracking();
  console.log(etracking ? '[etracking] ligado.' : '[etracking] desligado: defina ETRACKING_URL para ligar.');
  if (etracking) etracking.iniciar();

  let alertas = null;
  try {
    const envio = criarEnvio({ resendKey: env.RESEND_API_KEY, brevoKey: env.BREVO_API_KEY, de: env.ALERTA_DE, para: env.ALERTA_PARA });
    alertas = criarAlertas({
      envio,
      memoria: historico.memoriaAlertas,
      persistente: historico.tipo === 'postgres',
      filtro: Object.fromEntries(new URLSearchParams(env.ALERTA_FILTRO || '')),
      deadlineHoras: Number(env.ALERTA_DEADLINE_HORAS) || 24,
      mudancaMinHoras: env.ALERTA_MUDANCA_MIN_HORAS !== undefined && env.ALERTA_MUDANCA_MIN_HORAS !== '' ? Number(env.ALERTA_MUDANCA_MIN_HORAS) : 1,
      url: config.urlPublica,
    });
    console.log(envio ? `[alertas] e-mail via ${envio.provedor} para ${envio.para.join(', ')} a cada ${Number(env.ALERTA_MINUTOS) || 15} min.` : '[alertas] desligados: defina RESEND_API_KEY (ou BREVO_API_KEY) e ALERTA_PARA.');
    if (envio) setInterval(() => alertas.despachar(), (Number(env.ALERTA_MINUTOS) || 15) * 60e3).unref();
  } catch (e) {
    console.log(`[alertas] configuração inválida: ${e.message}`);
  }

  const cliente = criarClientePadrao(async (registros, em, normalizados) => {
    const novas = await historico.registrar(registros, em);
    if (novas.length) console.log(`[historico] ${novas.length} mudança(s) detectada(s).`);
    if (alertas) {
      const eventos = await alertas.avaliar(ajuste.aplicar(normalizados), novas);
      // A primeira consulta sai na hora (serve de confirmação de que os alertas funcionam); depois, no intervalo.
      if (eventos.length && !alertas.estado().ultimoEnvio && !alertas.estado().ultimoErro) await alertas.despachar();
    }
  });
  const servidor = criarServidor(cliente, historico, alertas, armazem, etracking, ajuste);
  servidor.listen(config.porta, () => {
    console.log(`Portal de Navios na porta ${config.porta}. Histórico: ${historico.tipo}. Observações e armadores: ${armazem.tipo}.`);
    if (!cliente) return console.log('[diagnóstico] DSS_URL não configurado.');
    const u = new URL(config.dssUrl);
    console.log(`[diagnóstico] DSS: ${u.host}${u.pathname} | login: ${env.DSS_TOKEN ? 'token' : env.DSS_USUARIO || u.username ? 'Basic' : 'nenhum'} | atualização a cada ${config.cacheSegundos} s`);

    // Atualização em segundo plano: a primeira consulta já serve de diagnóstico.
    let primeira = true;
    cliente.iniciarAtualizacao(config.cacheSegundos * 1000, (e) => console.log(`[dss] ${e.message}`));
    cliente
      .listar()
      .then((r) => {
        const terminais = [...new Set(r.registros.map((x) => x.terminal))].join(', ');
        console.log(`[diagnóstico] DSS OK: ${r.qtdRegistros} atracações (apiVersion ${r.apiVersion}). Terminais: ${terminais || '-'}.`);
      })
      .catch((e) => primeira && console.log(`[diagnóstico] ${e.message}`))
      .finally(() => {
        primeira = false;
      });

    // Contra a hibernação do plano gratuito do Render.
    if (config.manterAcordado && config.urlPublica) {
      const alvo = `${config.urlPublica.replace(/\/$/, '')}/api/health`;
      setInterval(() => fetch(alvo).catch((e) => console.log(`[ping] falhou: ${e.message}`)), config.pingMinutos * 60e3).unref();
      console.log(`[ping] mantendo o serviço acordado: ${alvo} a cada ${config.pingMinutos} min.`);
    }
  });
  process.on('SIGTERM', () => servidor.close(() => process.exit(0)));
}

if (require.main === module) main();

module.exports = { criarServidor, criarAjusteArmadores };
