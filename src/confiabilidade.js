'use strict';

// Confiabilidade das previsões: quanto cada terminal e cada armador costuma mudar uma data depois de informá-la.
//
// Para cada navio e cada campo (chegada, deadline, saída), soma as mudanças do período: o deslocamento líquido é
// a última data informada menos a primeira (positivo = adiou, negativo = antecipou). Mudanças em que a data
// some ou aparece (sem valor de um dos lados) não entram no cálculo.

const HORA = 36e5;
const CAMPOS = {
  data_prev_chegada: 'chegada',
  data_deadline: 'deadline',
  data_prev_saida: 'saída',
};
const dssMs = (v) => (v && String(v).trim() ? Date.parse(`${String(v).trim().replace(' ', 'T')}Z`) : null);
const r1 = (v) => Math.round(v * 10) / 10;

function mediana(valores) {
  if (!valores.length) return null;
  const v = [...valores].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * mudancas: histórico do período (todas as campos). navios: [{ chave, terminal, armador, navio, viagem, campos: Set }]
 * — os navios vistos no período, para saber o total de cada grupo (inclusive os que nunca mudaram).
 */
function avaliarConfiabilidade(mudancas, navios, { campo = 'data_prev_chegada', agrupar = 'terminal', minimo = 3 } = {}) {
  const info = new Map(navios.map((n) => [n.chave, n]));
  // deslocamento líquido por navio
  const porNavio = new Map();
  for (const m of [...mudancas].filter((x) => x.campo === campo).sort((a, b) => a.em.localeCompare(b.em))) {
    const de = dssMs(m.de);
    const para = dssMs(m.para);
    if (de === null || para === null) continue;
    const p = porNavio.get(m.chave) || { primeira: de, ultima: para, vezes: 0, navio: m.navio, viagem: m.viagem, terminal: m.terminal };
    p.ultima = para;
    p.vezes += 1;
    porNavio.set(m.chave, p);
  }

  const grupoDe = (n) => (agrupar === 'armador' ? n.armador || 'Sem armador' : n.terminal || '—');
  const grupos = new Map();
  const garantir = (g) => {
    if (!grupos.has(g)) grupos.set(g, { grupo: g, navios: 0, mudaram: 0, deslocamentos: [], vezes: 0, maior: null });
    return grupos.get(g);
  };
  for (const n of navios) if (n.campos.has(campo)) garantir(grupoDe(n)).navios += 1;
  for (const [chave, p] of porNavio) {
    const n = info.get(chave) || { terminal: p.terminal, armador: null };
    const g = garantir(grupoDe(n));
    if (!(n.campos?.has(campo))) g.navios += 1; // navio que não está mais na lista, mas mudou no período
    const horas = (p.ultima - p.primeira) / HORA;
    g.vezes += p.vezes;
    if (Math.abs(horas) < 0.01) continue; // mudou e voltou ao valor inicial
    g.mudaram += 1;
    g.deslocamentos.push(horas);
    if (!g.maior || Math.abs(horas) > Math.abs(g.maior.horas)) g.maior = { navio: p.navio, viagem: p.viagem, chave, horas: r1(horas) };
  }

  const resultado = [...grupos.values()]
    .filter((g) => g.navios >= minimo || g.mudaram > 0)
    .map((g) => {
      const soma = g.deslocamentos.reduce((s, x) => s + x, 0);
      return {
        grupo: g.grupo,
        navios: g.navios,
        mudaram: g.mudaram,
        pctMudaram: g.navios ? Math.round((g.mudaram / g.navios) * 100) : null,
        mudancas: g.vezes,
        mediaQuandoMuda: g.mudaram ? r1(soma / g.mudaram) : null,
        medianaQuandoMuda: g.mudaram ? r1(mediana(g.deslocamentos)) : null,
        mediaAbsoluta: g.mudaram ? r1(g.deslocamentos.reduce((s, x) => s + Math.abs(x), 0) / g.mudaram) : null,
        mediaGeral: g.navios ? r1(soma / g.navios) : null,
        adiaram: g.deslocamentos.filter((x) => x > 0).length,
        anteciparam: g.deslocamentos.filter((x) => x < 0).length,
        maior: g.maior,
      };
    })
    .sort((a, b) => b.navios - a.navios || a.grupo.localeCompare(b.grupo));
  return resultado;
}

const NOME_T = { btp: 'a BTP', santos_brasil: 'a Santos Brasil', embraport: 'a Embraport' };
function horasTexto(h) {
  const a = Math.abs(h);
  return a >= 48 ? `${r1(a / 24).toLocaleString('pt-BR')} dias` : `${Math.round(a)} h`;
}

/** Frases do tipo "A Santos Brasil adia a chegada em média 14 h quando muda (9 de 40 navios)." */
function frases(grupos, { campo, agrupar }) {
  const nomeCampo = CAMPOS[campo] || campo;
  return grupos
    .filter((g) => g.mudaram >= 2)
    .map((g) => {
      const sujeito = agrupar === 'terminal' ? NOME_T[g.grupo] || g.grupo : `o armador ${g.grupo}`;
      const verbo = g.mediaQuandoMuda >= 0 ? 'adia' : 'antecipa';
      const texto = `${sujeito.charAt(0).toUpperCase()}${sujeito.slice(1)} ${verbo} ${nomeCampo === 'saída' ? 'a saída' : nomeCampo === 'deadline' ? 'o deadline' : 'a chegada'} em média ${horasTexto(g.mediaQuandoMuda)} quando muda (${g.mudaram} de ${g.navios} navios, ${g.pctMudaram}%).`;
      return { grupo: g.grupo, texto, peso: g.mudaram * Math.abs(g.mediaQuandoMuda) };
    })
    .sort((a, b) => b.peso - a.peso);
}

module.exports = { avaliarConfiabilidade, frases, CAMPOS };
