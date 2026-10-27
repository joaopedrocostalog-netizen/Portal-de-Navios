'use strict';

// Gerador mínimo de .xlsx (Office Open XML), sem dependências: planilhas com cabeçalho em negrito,
// datas em formato de data do Excel (horário de Brasília), filtro automático e primeira linha congelada.

const zlib = require('node:zlib');

// ------------------------------------------------------------------ zip
const TABELA_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = TABELA_CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(arquivos) {
  const locais = [];
  const centrais = [];
  let deslocamento = 0;
  for (const { nome, dados } of arquivos) {
    const bruto = Buffer.from(dados);
    const comprimido = zlib.deflateRawSync(bruto);
    const nomeBuf = Buffer.from(nome);
    const crc = crc32(bruto);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // nomes em UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // hora/data
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(bruto.length, 22);
    local.writeUInt16LE(nomeBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(bruto.length, 24);
    central.writeUInt16LE(nomeBuf.length, 28);
    central.writeUInt32LE(deslocamento, 42);
    locais.push(local, nomeBuf, comprimido);
    centrais.push(central, nomeBuf);
    deslocamento += 30 + nomeBuf.length + comprimido.length;
  }
  const diretorio = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(deslocamento, 16);
  return Buffer.concat([...locais, diretorio, fim]);
}

// ------------------------------------------------------------------ células
const xml = (v) =>
  String(v)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const letra = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const partes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
/** Data (ISO ou ms) -> número de série do Excel no horário de Brasília. */
function serialExcel(v) {
  const ms = typeof v === 'number' ? v : Date.parse(v);
  if (Number.isNaN(ms)) return null;
  const p = Object.fromEntries(partes.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 864e5 + 25569;
}

const ESTILO = { texto: 0, cabecalho: 1, data: 2, numero: 3 };

function celula(ref, valor, tipo) {
  if (valor === null || valor === undefined || valor === '') return '';
  if (tipo === 'data') {
    const s = serialExcel(valor);
    return s === null ? '' : `<c r="${ref}" s="${ESTILO.data}"><v>${s}</v></c>`;
  }
  if (tipo === 'numero' && Number.isFinite(Number(valor))) return `<c r="${ref}" s="${ESTILO.numero}"><v>${Number(valor)}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(valor)}</t></is></c>`;
}

function planilhaXml({ colunas, linhas }) {
  const ultima = letra(colunas.length - 1);
  const cabecalho = `<row r="1">${colunas.map((c, i) => `<c r="${letra(i)}1" t="inlineStr" s="${ESTILO.cabecalho}"><is><t>${xml(c.titulo)}</t></is></c>`).join('')}</row>`;
  const corpo = linhas.map((l, j) => `<row r="${j + 2}">${colunas.map((c, i) => celula(`${letra(i)}${j + 2}`, l[i], c.tipo)).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${colunas.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.largura || (c.tipo === 'data' ? 16 : 14)}" customWidth="1"/>`).join('')}</cols>
<sheetData>${cabecalho}${corpo}</sheetData>
<autoFilter ref="A1:${ultima}${Math.max(linhas.length + 1, 1)}"/>
</worksheet>`;
}

/** planilhas: [{ nome, colunas: [{ titulo, tipo: 'texto'|'data'|'numero', largura }], linhas: [[...]] }] */
function criarXlsx(planilhas) {
  const nomes = planilhas.map((p) => p.nome.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31));
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const arquivos = [
    {
      nome: '[Content_Types].xml',
      dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${planilhas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`,
    },
    {
      nome: '_rels/.rels',
      dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      nome: 'xl/workbook.xml',
      dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${ns}" xmlns:r="${rel}"><bookViews><workbookView/></bookViews><sheets>${nomes.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
<definedNames>${planilhas
        .map((p, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xml(nomes[i])}'!$A$1:$${letra(p.colunas.length - 1)}$${Math.max(p.linhas.length + 1, 1)}</definedName>`)
        .join('')}</definedNames></workbook>`,
    },
    {
      nome: 'xl/_rels/workbook.xml.rels',
      dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${planilhas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${planilhas.length + 1}" Type="${rel}/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      nome: 'xl/styles.xml',
      dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${ns}">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE3EDFB"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
    },
    ...planilhas.map((p, i) => ({ nome: `xl/worksheets/sheet${i + 1}.xml`, dados: planilhaXml(p) })),
  ];
  return zip(arquivos);
}

module.exports = { criarXlsx, serialExcel, crc32 };
