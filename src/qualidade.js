'use strict';

// Qualidade dos dados por terminal: o que o DSS preenche, o que precisou ser corrigido e o que muda.
//
// Dois tipos de preenchimento:
//   previstas  % dos registros com a data prevista preenchida
//   reais      entre os registros em que a data real já deveria existir (a prevista passou há mais de
//              24 h), % com a data real informada. É o que mostra se o terminal fecha o ciclo.

const HORA = 36e5;
const dssMs = (v) => (v && String(v).trim() ? Date.parse(`${String(v).trim().replace(' ', 'T')}Z`) : null);
const tem = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const sem = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const PREVISTAS = [
  ['data_prev_chegada', 'Chegada prevista'],
  ['data_prev_atracacao', 'Atracação prevista'],
  ['data_prev_saida', 'Saída prevista'],
  ['data_prev_abertura_gate', 'Abertura do gate prevista'],
  ['data_deadline', 'Deadline'],
  ['data_prev_lib_dry', 'Liberação dry prevista'],
  ['data_prev_lib_reefer', 'Liberação reefer prevista'],
];
// [real, datas que dizem quando a real já deveria existir (usa a primeira preenchida), rótulo]
// Quando a prevista não vem, o deadline serve de referência para o gate (o gate abre antes dele)
// e a saída prevista para as liberações.
const REAIS = [
  ['data_atracacao', ['data_prev_atracacao', 'data_prev_chegada'], 'Atracação'],
  ['data_abertura_gate', ['data_prev_abertura_gate', 'data_deadline'], 'Abertura do gate'],
  ['data_lib_dry', ['data_prev_lib_dry', 'data_prev_saida'], 'Liberação dry'],
  ['data_lib_reefer', ['data_prev_lib_reefer', 'data_prev_saida'], 'Liberação reefer'],
];
const REFERENCIA_GATE_REEFER = ['data_prev_lib_reefer', 'data_deadline'];
const PROBLEMAS = {
  data_real_no_futuro: 'data "real" no futuro (tratada como prevista)',
  reefer_e_abertura_de_gate: 'liberação reefer que é abertura de gate reefer',
  armador_igual_viagem: 'armador igual à viagem',
  armador_invalido: 'armador inválido',
  data_suspeita: 'data a mais de 1 ano (descartada)',
  saida_sem_atracacao: 'saída prevista passou sem atracação informada',
};
const NOME = { btp: 'BTP', santos_brasil: 'Santos Brasil', embraport: 'Embraport (DPW)' };

const pct = (n, total) => (total ? Math.round((n / total) * 100) : null);
// Na BTP e na Santos Brasil, os campos de liberação reefer trazem a abertura do gate reefer.
const REEFER_E_GATE = new Set(['btp', 'santos_brasil']);
const GATE_REEFER = { data_lib_reefer: 'Abertura do gate reefer', data_prev_lib_reefer: 'Abertura do gate reefer prevista' };
const rotuloNoTerminal = (campo, rotulo, terminal) => (REEFER_E_GATE.has(terminal) && GATE_REEFER[campo]) || rotulo;

/**
 * brutos: registros como vieram do DSS; normalizados: os mesmos depois de normalizar (mesma ordem não é exigida);
 * mudancas: histórico do período (para contar quantas datas mudaram por terminal).
 */
function avaliarQualidade(brutos, normalizados, mudancas = [], { agora = Date.now(), diasMudancas = 7 } = {}) {
  const terminais = [...new Set(brutos.map((r) => String(r.terminal ?? '').trim()).filter(Boolean))].sort();
  return terminais.map((terminal) => {
    const regs = brutos.filter((r) => String(r.terminal ?? '').trim() === terminal);
    const norm = normalizados.filter((r) => r.terminal === terminal);
    const total = regs.length;

    const previstas = PREVISTAS.map(([campo, rotulo]) => {
      const n = regs.filter((r) => tem(r[campo])).length;
      return { campo, rotulo: rotuloNoTerminal(campo, rotulo, terminal), preenchidos: n, total, pct: pct(n, total) };
    });
    const reais = REAIS.map(([campo, refs, rotulo]) => {
      const referencias = campo === 'data_lib_reefer' && REEFER_E_GATE.has(terminal) ? REFERENCIA_GATE_REEFER : refs;
      const devidos = regs.filter((r) => {
        const ref = referencias.find((c) => tem(r[c]));
        const p = ref ? dssMs(r[ref]) : null;
        return p && p < agora - 24 * HORA;
      });
      const n = devidos.filter((r) => tem(r[campo])).length;
      return { campo, rotulo: rotuloNoTerminal(campo, rotulo, terminal), preenchidos: n, total: devidos.length, pct: pct(n, devidos.length) };
    });

    const armadorOk = regs.filter((r) => tem(r.armador) && sem(r.armador) !== sem(r.nro_viagem)).length;
    const semArmadorDeduzivel = norm.filter((r) => !r.armador).length;

    const problemas = {};
    for (const r of norm) for (const q of r.qualidade) if (PROBLEMAS[q.problema]) problemas[q.problema] = (problemas[q.problema] || 0) + 1;

    const desde = agora - diasMudancas * 24 * HORA;
    const mudDatas = mudancas.filter((m) => m.terminal === terminal && m.campo !== 'registro' && m.campo !== 'armador' && Date.parse(m.em) >= desde);
    const naviosComMudanca = new Set(mudDatas.map((m) => m.chave)).size;

    // Achados em linguagem simples, do mais grave para o menos.
    const achados = [];
    for (const r of reais) {
      if (r.total >= 3 && r.pct === 0) achados.push({ nivel: 'alto', texto: `${r.rotulo} real nunca é informada (0 de ${r.total} registros em que já deveria existir).` });
      else if (r.total >= 3 && r.pct < 50) achados.push({ nivel: 'medio', texto: `${r.rotulo} real informada em só ${r.pct}% dos registros em que já deveria existir (${r.preenchidos} de ${r.total}).` });
    }
    for (const p of previstas) {
      if (total >= 3 && p.pct === 0) achados.push({ nivel: 'medio', texto: `${p.rotulo} nunca vem preenchida.` });
      else if (total >= 3 && p.pct < 50) achados.push({ nivel: 'baixo', texto: `${p.rotulo} preenchida em só ${p.pct}% dos registros.` });
    }
    if (total - armadorOk > 0) {
      achados.push({
        nivel: pct(total - armadorOk, total) >= 20 ? 'medio' : 'baixo',
        texto: `${total - armadorOk} registro(s) com armador vazio ou igual à viagem${semArmadorDeduzivel ? `; ${semArmadorDeduzivel} sem como deduzir` : ''}.`,
      });
    }
    for (const [problema, n] of Object.entries(problemas)) {
      if (problema === 'armador_igual_viagem' || problema === 'armador_invalido') continue; // já contado acima
      achados.push({ nivel: problema === 'reefer_e_abertura_de_gate' ? 'baixo' : 'medio', texto: `${n} registro(s) com ${PROBLEMAS[problema]}.` });
    }
    const ordem = { alto: 0, medio: 1, baixo: 2 };
    achados.sort((a, b) => ordem[a.nivel] - ordem[b.nivel]);

    return {
      terminal,
      nome: NOME[terminal] || terminal,
      registros: total,
      previstas,
      reais,
      armador: { corretos: armadorOk, total, pct: pct(armadorOk, total), semDeducao: semArmadorDeduzivel },
      problemas,
      mudancas: { dias: diasMudancas, datas: mudDatas.length, navios: naviosComMudanca, porNavio: naviosComMudanca ? Math.round((mudDatas.length / naviosComMudanca) * 10) / 10 : 0 },
      achados,
    };
  });
}

/** Texto pronto para mandar ao DSS ou aos terminais. */
function textoQualidade(terminais) {
  return terminais
    .filter((t) => t.achados.length)
    .map((t) => `${t.nome} (${t.registros} registros):\n${t.achados.map((a) => `- ${a.texto}`).join('\n')}`)
    .join('\n\n');
}

module.exports = { avaliarQualidade, textoQualidade, PROBLEMAS, PREVISTAS, REAIS };
