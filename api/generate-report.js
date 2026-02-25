import Busboy from "busboy";
import pdfParse from "pdf-parse";
import PDFDocument from "pdfkit";

// Vercel: necesitamos desactivar bodyParser para multipart (en Vercel Functions funciona así)
export const config = {
  api: { bodyParser: false }
};

function readMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB
    const result = { fields: {}, file: null };

    bb.on("file", (name, file, info) => {
      const { filename, mimeType } = info;
      if (mimeType !== "application/pdf") {
        file.resume();
        return reject(new Error("Solo PDFs (application/pdf)."));
      }
      const chunks = [];
      file.on("data", (d) => chunks.push(d));
      file.on("end", () => {
        result.file = { filename, buffer: Buffer.concat(chunks) };
      });
    });

    bb.on("field", (name, val) => {
      result.fields[name] = val;
    });

    bb.on("error", reject);
    bb.on("finish", () => resolve(result));

    req.pipe(bb);
  });
}

function defaultDisclaimer(firm = "INVERNORD") {
  return `Este reporte es únicamente informativo y no constituye una recomendación personalizada, oferta, invitación o solicitud para comprar o vender valores. El desempeño pasado no garantiza resultados futuros. Las opiniones y estimaciones reflejan el criterio de ${firm} a la fecha del reporte y pueden cambiar sin previo aviso. Antes de invertir, evalúe sus objetivos, horizonte y tolerancia al riesgo y, de ser necesario, consulte a un asesor financiero y fiscal.`;
}

// Heurísticas MVP (las afinamos con PDFs reales LSEG)
function extractTicker(text) {
  // Busca patrones tipo: "PLTR", "Ticker: PLTR", "RIC: PLTR.N", etc.
  const m1 = text.match(/\bTicker\s*[:\-]\s*([A-Z.\-]{1,10})\b/i);
  if (m1) return m1[1].toUpperCase();

  const m2 = text.match(/\bRIC\s*[:\-]\s*([A-Z0-9.\-]{1,15})\b/i);
  if (m2) return m2[1].toUpperCase();

  // fallback: primera palabra estilo ticker (muy básico)
  const m3 = text.match(/\b([A-Z]{1,5})\b/);
  return m3 ? m3[1].toUpperCase() : "TICKER";
}

function extractCompanyName(text) {
  // Muy común: encabezados en mayúsculas o “Company: …”
  const m1 = text.match(/\bCompany\s*[:\-]\s*(.{3,80})/i);
  if (m1) return m1[1].split("\n")[0].trim();

  const m2 = text.match(/\bName\s*[:\-]\s*(.{3,80})/i);
  if (m2) return m2[1].split("\n")[0].trim();

  // fallback: primera línea “larga” con letras
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const cand = lines.find(l => l.length >= 10 && /[A-Za-z]/.test(l)) || "Empresa";
  return cand.slice(0, 60);
}

function extractKeyMetrics(text) {
  // MVP: buscamos algunas etiquetas frecuentes. Si no están, devuelve vacío.
  const metrics = [];

  const pick = (label, regex) => {
    const m = text.match(regex);
    if (m && m[1]) metrics.push([label, m[1].trim()]);
  };

  pick("Último cierre", /\b(Last\s*Close|Close)\s*[:\-]?\s*\$?\s*([0-9.,]+)\b/i);
  pick("Market Cap", /\b(Market\s*Cap(italization)?)\s*[:\-]?\s*([A-Za-z$€£0-9.,\s]+)\b/i);
  pick("52W Range", /\b(52\s*Week\s*Range|52W\s*Range)\s*[:\-]?\s*([0-9.,\-\s]+)\b/i);
  pick("P/E", /\b(P\/E|PE\s*Ratio)\s*[:\-]?\s*([0-9.,x]+)\b/i);
  pick("ROE", /\b(ROE)\s*[:\-]?\s*([0-9.,%]+)\b/i);

  // Normaliza estructura [Métrica, Valor]
  return metrics.map(m => [m[0], m[1]]);
}

function buildReport({ firm, client, date, ticker, company, pdfName, keyMetrics, rawText }) {
  // Aquí después conectaremos a LLM/plantilla avanzada. Hoy: base sólida.
  const overview =
    `Reporte generado a partir de un PDF de referencia (${pdfName}). ` +
    `Este documento resume información clave del emisor y sirve como base para un análisis interno.`;

  const analysis =
    `MVP automático: extracción de texto + heurísticas. ` +
    `En la siguiente iteración, BILLION estructurará drivers, riesgos y lectura operativa usando plantillas RIA y validación humana.`;

  const pros = [
    "Automatización del flujo de reporte (menos tiempo operativo).",
    "Formato consistente para clientes (INVERNORD).",
    "Base escalable: parsing + QA + compliance."
  ];

  const cons = [
    "La extracción depende del formato del PDF (puede requerir ajustes).",
    "MVP no garantiza precisión del 100% sin validación humana.",
    "Se requiere fase de calibración con PDFs LSEG reales."
  ];

  const conclusion =
    "Recomendación (MVP): usar este reporte como borrador operativo, validar cifras contra fuente y luego enviar versión final al cliente.";

  return {
    firm, client, date, ticker, company,
    overview, analysis,
    pros, cons,
    conclusion,
    keyMetrics,
    disclaimer: defaultDisclaimer(firm),
    rawTextSnippet: rawText.slice(0, 1200)
  };
}

function renderPdf(report) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 54 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const pageW = doc.page.width;
    const rightX = pageW - doc.page.margins.right;

    // Header
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#111")
      .text(`${report.firm} — Reporte Maestro`, { align: "left" });
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(10).fillColor("#555")
      .text(`${report.ticker} · ${report.company} · ${report.client || "Cliente"} · ${report.date}`, { align: "left" });

    doc.moveDown(1);

    const section = (title) => {
      doc.font("Helvetica-Bold").fontSize(12).fillColor("#111").text(title);
      doc.moveDown(0.35);
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(rightX, doc.y).lineWidth(1).strokeColor("#e6e6e6").stroke();
      doc.moveDown(0.6);
    };

    const para = (txt) => {
      doc.font("Helvetica").fontSize(10.5).fillColor("#222").text(txt || "—", { lineGap: 3 });
      doc.moveDown(0.7);
    };

    section("1) Perspectiva General");
    para(report.overview);

    section("2) Datos Clave del Ticker");
    if (report.keyMetrics?.length) {
      report.keyMetrics.forEach(([k, v]) => {
        doc.font("Helvetica-Bold").fontSize(10.2).fillColor("#222").text(`${k}: `, { continued: true });
        doc.font("Helvetica").fontSize(10.2).fillColor("#222").text(v || "—");
      });
      doc.moveDown(0.7);
    } else {
      para("No se detectaron métricas en automático (MVP).");
    }

    section("3) Análisis y Comentarios");
    para(report.analysis);

    doc.addPage();

    doc.font("Helvetica-Bold").fontSize(18).fillColor("#111")
      .text(`${report.firm} — Reporte Maestro`, { align: "left" });
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(10).fillColor("#555")
      .text(`${report.ticker} · ${report.company} · ${report.client || "Cliente"} · ${report.date}`, { align: "left" });
    doc.moveDown(1);

    section("4) Puntos Positivos y Negativos");
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#111").text("Positivos:");
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(10.5).fillColor("#222").text(report.pros.map(p => `• ${p}`).join("\n"), { lineGap: 3 });
    doc.moveDown(0.7);

    doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#111").text("Negativos:");
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(10.5).fillColor("#222").text(report.cons.map(c => `• ${c}`).join("\n"), { lineGap: 3 });
    doc.moveDown(0.8);

    section("5) Conclusión y Recomendación");
    para(report.conclusion);

    section("Disclaimer");
    para(report.disclaimer);

    doc.font("Helvetica").fontSize(9).fillColor("#777")
      .text(`Referencia PDF: ${report.pdfName || "—"}`, doc.page.margins.left, doc.page.height - 54, { align: "left" });
    doc.font("Helvetica").fontSize(9).fillColor("#777")
      .text(`${report.firm}`, rightX - 100, doc.page.height - 54, { align: "right" });

    doc.end();
  });
}

export default async function handler(req, res) {
  try{
    if (req.method !== "POST") {
      res.status(405).json({ error: "Use POST" });
      return;
    }

    const { fields, file } = await readMultipart(req);
    if (!file?.buffer) {
      res.status(400).json({ error: "Falta archivo PDF en campo 'file'." });
      return;
    }

    const firm = (fields.firm || "INVERNORD").trim();
    const client = (fields.client || "").trim();
    const date = (fields.date || new Date().toLocaleDateString("es-MX")).trim();

    const parsed = await pdfParse(file.buffer);
    const text = (parsed.text || "").replace(/\r/g, "");

    const ticker = (fields.ticker || extractTicker(text)).toUpperCase();
    const company = (fields.company || extractCompanyName(text)).trim();
    const keyMetrics = extractKeyMetrics(text);

    const report = buildReport({
      firm, client, date,
      ticker, company,
      pdfName: file.filename,
      keyMetrics,
      rawText: text
    });

    const pdfBuffer = await renderPdf(report);

    const outName = `${firm}_${ticker}_${date.replace(/[^0-9A-Za-z_-]/g,"-")}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${outName}"`);
    res.status(200).send(pdfBuffer);
  }catch(err){
    res.status(500).json({ error: err.message || "Error" });
  }
}
