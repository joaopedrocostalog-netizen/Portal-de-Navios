'use strict';

// Dados de demonstração usados quando a chave de uma fonte ainda não foi configurada.
// Tudo que sai daqui vem marcado com "fonte": "demo" e nomes com "DEMO", para nunca
// ser confundido com dado real.

const HORA = 3600 * 1000;

// Base de tempo arredondada para a hora cheia, para o demo devolver as mesmas datas em consultas seguidas.
const agoraArredondado = () => Math.floor(Date.now() / HORA) * HORA;

const NAVIOS = [
  { mmsi: '710000001', imo: '9000001', nome: 'DEMO ATLANTICO', horas: 18, tipo: 'Cargo', bandeira: 'BR' },
  { mmsi: '710000002', imo: '9000002', nome: 'DEMO SANTOS EXPRESS', horas: 46, tipo: 'Cargo', bandeira: 'LR' },
  { mmsi: '710000003', imo: '9000003', nome: 'DEMO PACIFIC BRIDGE', horas: 90, tipo: 'Cargo', bandeira: 'PA' },
];

// Contêineres de exemplo (com dígito verificador ISO 6346 válido).
const CONTEINERES = [
  { numero: 'MSCU1234566', armador: 'MSCU', navio: 0, descricao: 'Peças automotivas' },
  { numero: 'MAEU7654320', armador: 'MAEU', navio: 0, descricao: 'Resina plástica' },
  { numero: 'CMAU5550004', armador: 'CMDU', navio: 1, descricao: 'Produto químico', perigoso: true, classeRisco: 'Classe 8' },
  { numero: 'HLXU8001005', armador: 'HLCU', navio: 2, descricao: 'Eletrônicos' },
];

function navioDemo(indice, porto, agora = agoraArredondado()) {
  const n = NAVIOS[indice % NAVIOS.length];
  return {
    mmsi: n.mmsi,
    imo: n.imo,
    nome: n.nome,
    tipo: n.tipo,
    bandeira: n.bandeira,
    comprimento: 300,
    largura: 48,
    calado: 13.5,
    dwt: null,
    posicao: { lat: -24.2 - indice, lon: -45.9 + indice, velocidade: 14.2, rumo: 40, atualizadoEm: new Date(agora).toISOString() },
    destino: porto,
    codigoDestino: porto,
    eta: new Date(agora + n.horas * HORA).toISOString(),
    portoAnterior: 'DEMO PORTO ANTERIOR',
    statusNavegacao: 'Em navegação',
  };
}

function chegadasDemo(porto, inicio, fim) {
  const agora = agoraArredondado();
  return NAVIOS.map((_, i) => navioDemo(i, porto, agora)).filter((n) => {
    const eta = new Date(n.eta).getTime();
    return eta >= inicio.getTime() && eta <= fim.getTime();
  });
}

function navioPorMmsiDemo(mmsi) {
  const indice = NAVIOS.findIndex((n) => n.mmsi === String(mmsi));
  return indice >= 0 ? navioDemo(indice, 'BRSSZ') : { ...navioDemo(0, 'BRSSZ'), mmsi: String(mmsi), nome: 'DEMO NAVIO DESCONHECIDO' };
}

/** Rastreio de demonstração no mesmo formato da resposta normalizada do eTracking. */
function rastreioDemo(numero, armador, porto = 'BRSSZ', navioMmsi = null) {
  const conhecido = CONTEINERES.find((c) => c.numero === numero);
  // Respeita o navio informado no cadastro, se for um dos navios de demonstração.
  const informado = NAVIOS.findIndex((n) => n.mmsi === String(navioMmsi));
  let indice;
  if (informado >= 0) indice = informado;
  else if (conhecido) indice = conhecido.navio;
  else indice = [...numero].reduce((s, c) => s + c.charCodeAt(0), 0) % NAVIOS.length;
  const navio = navioDemo(indice, porto);
  // O eTracking costuma divergir um pouco do AIS; aqui o último contêiner diverge 30 h para demonstrar o alerta.
  const desvioHoras = numero === 'HLXU8001005' ? 30 : 2;
  const eta = new Date(new Date(navio.eta).getTime() + desvioHoras * HORA).toISOString();
  return {
    numero,
    armador: conhecido ? conhecido.armador : armador,
    scac: conhecido ? conhecido.armador : armador,
    origem: 'DEMO SHANGHAI (CNSHA)',
    destino: `DEMO SANTOS (${porto})`,
    progresso: 70,
    localAtual: 'Em trânsito (demo)',
    navio: { nome: navio.nome, imo: navio.imo, mmsi: navio.mmsi, posicao: { lat: navio.posicao.lat, lon: navio.posicao.lon }, velocidade: 14.2, rumo: 40 },
    eventos: [
      { porto: 'DEMO SHANGHAI', locode: 'CNSHA', evento: 'Embarcado no navio', dataHora: new Date(agoraArredondado() - 20 * 24 * HORA).toISOString(), realizado: true, navio: navio.nome },
      { porto: 'DEMO SANTOS', locode: porto, evento: 'Descarga prevista', dataHora: eta, realizado: false, navio: navio.nome },
    ],
    etaDestino: eta,
    locodeDestino: porto,
  };
}

/** Atracações de demonstração no formato normalizado do DSS (Portal de Navios). */
function atracacoesDemo() {
  const agora = agoraArredondado();
  const iso = (horas) => new Date(agora + horas * HORA).toISOString();
  return NAVIOS.map((n, i) => {
    // O último navio tem previsão no DSS 30 h depois do ETA pelo AIS, para demonstrar a divergência.
    const chegada = n.horas + (i === 2 ? 30 : 1);
    return {
      navio: n.nome,
      viagem: `DEMO${String(i + 1).padStart(3, '0')}`,
      armador: ['MSC', 'MAERSK', 'CMA CGM'][i],
      terminal: 'btp',
      situacao: 'previsto',
      referencia: iso(chegada + 4),
      datas: {
        deadline: iso(chegada - 48),
        prevChegada: iso(chegada),
        prevAtracacao: iso(chegada + 4),
        atracacao: null,
        prevSaida: iso(chegada + 28),
        prevAberturaGate: iso(chegada - 120),
        aberturaGate: i === 0 ? iso(chegada - 118) : null,
        prevLiberacaoDry: iso(chegada + 30),
        liberacaoDry: null,
        prevLiberacaoReefer: iso(chegada + 26),
        liberacaoReefer: null,
      },
    };
  });
}

module.exports = { NAVIOS, CONTEINERES, chegadasDemo, navioPorMmsiDemo, rastreioDemo, atracacoesDemo };
