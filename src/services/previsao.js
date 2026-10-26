'use strict';

// Previsão de entrada de contêineres:
//   1. Shipxy diz quais navios chegam ao porto na janela (ETA pelo AIS).
//   2. Os contêineres monitorados são ligados a esses navios por MMSI, IMO ou nome.
//   3. O ETA do eTracking (VesselFinder) de cada contêiner é comparado com o ETA do navio;
//      diferenças acima da tolerância viram "divergências" para conferência.

const config = require('../config');
const shipxy = require('./shipxy');
const { semBruto } = require('./conteineres');

const HORA = 3600 * 1000;

function normalizarNome(nome) {
  return String(nome || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function pertenceAoNavio(conteiner, navio) {
  if (conteiner.navioMmsi && navio.mmsi && conteiner.navioMmsi === navio.mmsi) return true;
  if (conteiner.navioImo && navio.imo && conteiner.navioImo === navio.imo) return true;
  const a = normalizarNome(conteiner.navioNome);
  return Boolean(a) && a === normalizarNome(navio.nome);
}

function dia(iso) {
  return iso ? String(iso).slice(0, 10) : 'sem-data';
}

async function preverEntrada(store, { porto, dias, incluirBruto = false }) {
  const inicio = new Date();
  const fim = new Date(inicio.getTime() + dias * 24 * HORA);

  const chegadas = await shipxy.chegadasPrevistas(porto, inicio, fim);
  const monitorados = (await store.listarConteineres()).filter((c) => c.situacao === 'monitorando');

  const usados = new Set();
  const divergencias = [];

  const navios = chegadas.dados.map((navio) => {
    const conteineres = monitorados
      .filter((c) => pertenceAoNavio(c, navio))
      .map((c) => {
        usados.add(c.numero);
        let diferencaHoras = null;
        if (c.etaEtracking && navio.eta && !Number.isNaN(Date.parse(navio.eta))) {
          diferencaHoras = Math.round(((Date.parse(c.etaEtracking) - Date.parse(navio.eta)) / HORA) * 10) / 10;
          if (Math.abs(diferencaHoras) > config.toleranciaDivergenciaHoras) {
            divergencias.push({
              conteiner: c.numero,
              navio: navio.nome,
              etaNavioAis: navio.eta,
              etaEtracking: c.etaEtracking,
              diferencaHoras,
            });
          }
        }
        return {
          numero: c.numero,
          armador: c.armador,
          descricao: c.descricao,
          perigoso: c.perigoso,
          classeRisco: c.classeRisco,
          etaEtracking: c.etaEtracking,
          diferencaHorasParaEtaNavio: diferencaHoras,
          ultimoRastreioEm: c.ultimoRastreioEm,
        };
      });
    return { ...navio, totalConteineres: conteineres.length, conteineres };
  });

  // Contêineres que o eTracking diz que chegam a este porto na janela, mas cujo navio
  // não apareceu na lista da Shipxy (navio trocado, transbordo, ETA desatualizado...).
  const semNavioNaLista = monitorados
    .filter((c) => !usados.has(c.numero))
    .filter((c) => c.locodeDestino === porto && c.etaEtracking)
    .filter((c) => {
      const t = Date.parse(c.etaEtracking);
      return t >= inicio.getTime() && t <= fim.getTime();
    })
    .map((c) => ({ ...semBruto(c) }));

  const porDia = {};
  for (const navio of navios) {
    const d = dia(navio.eta);
    porDia[d] = porDia[d] || { navios: 0, conteineres: 0 };
    porDia[d].navios += 1;
    porDia[d].conteineres += navio.totalConteineres;
  }
  for (const c of semNavioNaLista) {
    const d = dia(c.etaEtracking);
    porDia[d] = porDia[d] || { navios: 0, conteineres: 0 };
    porDia[d].conteineres += 1;
  }

  return {
    porto,
    janela: { inicio: inicio.toISOString(), fim: fim.toISOString(), dias },
    fontes: { navios: chegadas.fonte },
    resumo: {
      totalNavios: navios.length,
      naviosComConteineresMonitorados: navios.filter((n) => n.totalConteineres > 0).length,
      totalConteineresPrevistos:
        navios.reduce((s, n) => s + n.totalConteineres, 0) + semNavioNaLista.length,
      totalDivergencias: divergencias.length,
      porDia,
    },
    navios,
    semNavioNaLista,
    divergencias,
    ...(incluirBruto ? { bruto: { shipxy: chegadas.bruto } } : {}),
  };
}

module.exports = { preverEntrada, pertenceAoNavio };
