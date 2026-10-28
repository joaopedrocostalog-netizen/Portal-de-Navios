'use strict';

// Calendário no formato iCalendar (.ics) para assinar no Outlook, Google Agenda ou Apple Calendário.
// O link é fixo: o programa de calendário volta a buscá-lo sozinho (o Outlook, em geral, a cada poucas horas).

const HORA = 36e5;
const TERMINAL = { btp: 'BTP', santos_brasil: 'Santos Brasil', embraport: 'Embraport' };

const utc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const texto = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Quebra linhas acima de 75 bytes, como manda a RFC 5545. */
function dobrar(linha) {
  const partes = [];
  let atual = '';
  for (const c of linha) {
    if (Buffer.byteLength(atual + c) > (partes.length ? 74 : 75)) {
      partes.push(atual);
      atual = c;
    } else atual += c;
  }
  partes.push(atual);
  return partes.join('\r\n ');
}

/**
 * navios: normalizados. tipos: Set de 'deadline' | 'gate' | 'chegada' | 'atracacao'.
 * Inclui eventos de até 2 dias atrás em diante (para o calendário não "apagar" o deadline de ontem na hora).
 */
function criarCalendario(navios, { tipos = new Set(['deadline', 'gate']), url = '', nome = 'Portal de Navios', lembreteMin = 120, agora = Date.now() } = {}) {
  const desde = agora - 2 * 24 * HORA;
  const eventos = [];
  const add = (n, tipo, iso, titulo, duracaoMin, extra = '') => {
    const t = iso ? Date.parse(iso) : NaN;
    if (Number.isNaN(t) || t < desde) return;
    const term = TERMINAL[n.terminal] || n.terminal;
    const descricao = [`${n.navio}, viagem ${n.viagem}`, `Terminal: ${term}`, n.armador ? `Armador: ${n.armador}` : '', extra, url ? `Portal: ${url}` : ''].filter(Boolean).join('\n');
    eventos.push(
      [
        'BEGIN:VEVENT',
        `UID:${tipo}-${n.chave.replace(/[^A-Za-z0-9|_-]/g, '')}@portal-de-navios`,
        `DTSTAMP:${utc(agora)}`,
        `DTSTART:${utc(t)}`,
        `DTEND:${utc(t + duracaoMin * 60e3)}`,
        `SUMMARY:${texto(`${titulo}: ${n.navio} (${term})`)}`,
        `DESCRIPTION:${texto(descricao)}`,
        `LOCATION:${texto(term)}`,
        `CATEGORIES:${texto(titulo)}`,
        'TRANSP:TRANSPARENT',
        ...(tipo === 'deadline' && lembreteMin > 0 ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${texto(`Deadline ${n.navio}`)}`, `TRIGGER:-PT${lembreteMin}M`, 'END:VALARM'] : []),
        'END:VEVENT',
      ].join('\r\n'),
    );
  };
  for (const n of navios) {
    if (n.situacao?.navio === 'encerrado') continue;
    const d = n.datas;
    if (tipos.has('deadline')) add(n, 'deadline', d.deadline, 'Deadline', 15, n.situacao.gate === 'aguardando' ? 'O gate ainda não abriu.' : '');
    if (tipos.has('gate')) {
      add(n, 'gate-dry', d.aberturaGate || d.prevAberturaGate, 'Abertura do gate dry', 15, d.aberturaGate ? 'Abertura confirmada.' : 'Abertura prevista.');
      add(n, 'gate-reefer', d.aberturaGateReefer || d.prevAberturaGateReefer, 'Abertura do gate reefer', 15, d.aberturaGateReefer ? 'Abertura confirmada.' : 'Abertura prevista.');
    }
    if (tipos.has('chegada') && !d.atracacao) add(n, 'chegada', d.prevChegada, 'Chegada prevista', 30);
    if (tipos.has('atracacao')) add(n, 'atracacao', d.atracacao || d.prevAtracacao, d.atracacao ? 'Atracou' : 'Atracação prevista', 30);
  }
  const linhas = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Costalog//Portal de Navios//PT-BR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${texto(nome)}`,
    'X-WR-TIMEZONE:America/Sao_Paulo',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...eventos,
    'END:VCALENDAR',
  ];
  return `${linhas.flatMap((l) => l.split('\r\n')).map(dobrar).join('\r\n')}\r\n`;
}

module.exports = { criarCalendario };
