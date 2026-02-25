import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import pdfParse from "pdf-parse";
import PDFDocument from "pdfkit";

export const config = {
  api: { bodyParser: false } // necesario para multipart/form-data
};

function parseForm(req) {
  const form = formidable({ multiples: false, maxFileSize: 30 * 1024 * 1024 });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

function cleanText(s) {
  return (s || "")
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function guessTickerFromText(text) {
  const m = text.match(/\bTicker\s*[:\-]?\s*([A-Z]{1,6})\b/i) || text.match(/\(([A-Z]{1,6})\)/);
  return m ? String(m[1]).toUpperCase() : "";
}

function drawH1(doc, text) {
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#111827").text(text, { align: "left" });
  doc.moveDown(0.3);
  doc.strokeColor("#e5e7eb").lineWidth(1).moveTo(doc.x, doc.y).lineTo(560, doc.y).stroke();
  doc.moveDown(0.8);
}

function drawSectionTitle(doc, text) {
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111827").text(text);
  doc.moveDown(0.3);
}

function drawPara(doc, text) {
  doc.font("Helvetica").fontSize(10.5).fillColor("#111827").text(text, { lineGap: 2 });
  doc.moveDown(0.8);
}

function drawBullets(doc, items) {
  doc.font("Helvetica").fontSize(10.5).fillColor("#111827");
  (items || []).forEach((it) => {
    doc.text(`• ${it}`, { indent: 12, lineGap: 2 });
  });
  doc.moveDown(0.8);
}

function drawKeyValueBullets(doc, kv) {
  doc.font("Helvetica").fontSize(10.5).fillColor("#111827");
  Object.entries(kv || {}).forEach(([k, v]) => {
    if (v === null || v === undefined || String(v).trim() === "") return;
    doc.text(`• ${k}: ${v}`, { indent: 12, lineGap: 2 });
  });
  doc.moveDown(0.8);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Use POST");

  try {
    const { fields, files } = await parseForm(req);

    const firm = String(fields.firm || "INVERNORD").trim();
    const clientName = String(fields.client || "").trim();
    const date = String(fields.date || "").trim();

    const uploaded = files.pdf;
    if (!uploaded) return res.status(400).send("Missing PDF file field 'pdf'.");

    const pdfBuffer = fs.readFileSync(uploaded.filepath);
    const parsed = await pdfParse(pdfBuffer);
    const pdfTextRaw = cleanText(parsed.text);

    if (!pdfTextRaw || pdfTextRaw.length < 300) {
      return res.status(400).send(
        "No pude extraer texto suficiente del PDF. Si el PDF es escaneado (imagen), necesitas OCR (fase 2)."
      );
    }

    const tickerFromUser = String(fields.ticker || "").trim().toUpperCase();
    const tickerDetected = guessTickerFromText(pdfTextRaw);
    const ticker = (tickerFromUser || tickerDetected || "TICKER").toUpperCase();

    // --- OpenAI: forzamos SALIDA ESTRUCTURADA (JSON) en tu FORMATO MAESTRO ---
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-5.2";

    const system = `
Eres un analista financiero de un RIA. Tu tarea: convertir TEXTO crudo (extraído de un PDF tipo LSEG) en un "Reporte Maestro" para cliente final.
Reglas:
- Español claro, profesional, sin hype, sin emojis.
- NO inventes números. Si un dato no viene en el texto, marca como "N/D".
- Estructura EXACTA: 
  1) titulo (EMPRESA (TICKER))
  2) perspectiva_general (párrafo)
  3) datos_clave (objeto con bullets: "Último cierre", "Fecha de referencia", "Capitalización de mercado", "Rango 52 semanas", "P/E (TTM)", "P/E (forward)", "ROE", "Ingresos anuales", "Propiedad institucional", "Dividend yield", "Retorno 1M/3M/1Y" si existe)
  4) analisis_comentarios (2-4 párrafos)
  5) positivos (3-6 bullets)
  6) negativos (3-6 bullets)
  7) conclusion_recomendacion (párrafo + postura: Mantener/Comprar/Vender + tipo de inversor)
  8) disclaimer (párrafo regulatorio genérico para INVERNORD; no prometas rendimiento)
- Usa el contenido del PDF como fuente principal.
`;

    const schema = {
      name: "reporte_maestro",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          titulo: { type: "string" },
          perspectiva_general: { type: "string" },
          datos_clave: {
            type: "object",
            additionalProperties: { type: "string" }
          },
          analisis_comentarios: { type: "string" },
          positivos: { type: "array", items: { type: "string" } },
          negativos: { type: "array", items: { type: "string" } },
          conclusion_recomendacion: { type: "string" },
          disclaimer: { type: "string" }
        },
        required: [
          "titulo",
          "perspectiva_general",
          "datos_clave",
          "analisis_comentarios",
          "positivos",
          "negativos",
          "conclusion_recomendacion",
          "disclaimer"
        ]
      }
    };

    const input = `
FIRMA: ${firm}
CLIENTE: ${clientName || "N/D"}
FECHA: ${date || "N/D"}
TICKER OBJETIVO: ${ticker}

TEXTO PDF (LSEG / fuente):
${pdfTextRaw}
`;

    // Nota: ejemplo oficial del SDK para Responses API (JS) aquí.  [oai_citation:0‡OpenAI Developers](https://developers.openai.com/api/docs/guides/prompt-engineering/)
    const response = await client.responses.create({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: input }
      ],
      text: {
        format: {
          type: "json_schema",
          json_schema: schema
        }
      }
    });

    const jsonText = response.output_text;
    let report;
    try {
      report = JSON.parse(jsonText);
    } catch {
      return res.status(500).send("El modelo no devolvió JSON válido. Reintenta.");
    }

    // --- Render PDF (cliente-ready) ---
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${ticker}-reporte-maestro.pdf"`);

    const doc = new PDFDocument({ size: "LETTER", margin: 48 });
    doc.pipe(res);

    // Header
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#6b7280").text(`${firm}`, { align: "left" });
    doc.font("Helvetica").fontSize(10).fillColor("#6b7280").text(`Fecha: ${date || "N/D"}${clientName ? ` • Cliente: ${clientName}` : ""}`, { align: "left" });
    doc.moveDown(0.6);

    drawH1(doc, report.titulo || `${ticker}`);

    drawSectionTitle(doc, "Perspectiva General");
    drawPara(doc, report.perspectiva_general || "N/D");

    drawSectionTitle(doc, "Datos Clave del Ticker");
    drawKeyValueBullets(doc, report.datos_clave);

    drawSectionTitle(doc, "Análisis y Comentarios");
    drawPara(doc, report.analisis_comentarios || "N/D");

    drawSectionTitle(doc, "Puntos Positivos");
    drawBullets(doc, report.positivos);

    drawSectionTitle(doc, "Puntos Negativos");
    drawBullets(doc, report.negativos);

    drawSectionTitle(doc, "Conclusión y Recomendación");
    drawPara(doc, report.conclusion_recomendacion || "N/D");

    drawSectionTitle(doc, "Disclaimer");
    drawPara(doc, report.disclaimer || "Este material es informativo y no constituye recomendación.");

    doc.end();
  } catch (err) {
    console.error(err);
    return res.status(500).send(err?.message || "Server error");
  }
}
