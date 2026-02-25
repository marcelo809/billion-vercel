import fs from "fs";
import formidable from "formidable";
import PDFDocument from "pdfkit";

export const config = {
  api: { bodyParser: false }, // requerido para multipart/form-data
};

function parseForm(req) {
  const form = formidable({
    multiples: false,
    keepExtensions: true,
    maxFileSize: 25 * 1024 * 1024, // 25MB
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

function pickUploadedFile(files) {
  const candidate =
    files?.pdf ||
    files?.file ||
    files?.upload ||
    Object.values(files || {})[0];

  const uploaded = Array.isArray(candidate) ? candidate[0] : candidate;
  return uploaded || null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const { fields, files } = await parseForm(req);

    // Debug: qué llegó
    console.log("FIELDS keys:", Object.keys(fields || {}));
    console.log("FILES keys:", Object.keys(files || {}));

    const uploaded = pickUploadedFile(files);

    if (!uploaded) {
      return res
        .status(400)
        .send("No llegó el archivo. Asegúrate de enviar el campo 'pdf' (multipart/form-data).");
    }

    // Formidable: filepath (v3) o path (v2)
    const filePath = uploaded.filepath || uploaded.path;

    let pdfBuffer;
    if (filePath) {
      pdfBuffer = fs.readFileSync(filePath);
    } else if (uploaded.buffer) {
      pdfBuffer = uploaded.buffer;
    } else {
      console.log("Uploaded object keys:", Object.keys(uploaded || {}));
      return res
        .status(400)
        .send("No pude encontrar filepath/path del archivo. Revisa Logs en Vercel.");
    }

    // Metadata
    const firm = String(fields?.firm || "INVERNORD");
    const date = String(fields?.date || "");
    const client = String(fields?.client || "");
    const ticker = String(fields?.ticker || "").toUpperCase();

    // MVP: por ahora NO parseamos el PDF (solo verificamos que existe)
    // En fase 2: pdf-parse / OCR / extraction
    console.log("Uploaded bytes:", pdfBuffer?.length || 0);

    // ===== Generar PDF output =====
    const doc = new PDFDocument({ size: "LETTER", margin: 48 });

    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("error", (e) => console.error("PDFKit error:", e));

    // Header
    doc.fontSize(22).font("Helvetica-Bold").text(`${ticker || "REPORTE"} — ${firm}`, { align: "left" });
    doc.moveDown(0.3);
    doc.fontSize(11).font("Helvetica").fillColor("#333333")
      .text(`Fecha: ${date || "—"}   |   Cliente: ${client || "—"}`);
    doc.moveDown(1);

    // Body (placeholder de “reporte maestro”)
    doc.fillColor("#000000");
    doc.fontSize(14).font("Helvetica-Bold").text("Reporte Maestro (MVP)");
    doc.moveDown(0.4);
    doc.fontSize(11).font("Helvetica").text(
      "Este MVP confirma que el flujo Upload → API → PDF funciona. " +
      "En la siguiente fase: lectura del PDF (LSEG), extracción de datos clave, " +
      "y generación del reporte con el formato maestro listo para cliente."
    );

    doc.moveDown(1);
    doc.fontSize(12).font("Helvetica-Bold").text("Inputs recibidos");
    doc.fontSize(11).font("Helvetica").text(`• Ticker: ${ticker || "(vacío)"}`);
    doc.text(`• Firma: ${firm}`);
    doc.text(`• Cliente: ${client || "(vacío)"}`);
    doc.text(`• PDF bytes: ${pdfBuffer?.length || 0}`);

    doc.moveDown(1.2);
    doc.fontSize(10).fillColor("#444444").text(
      "Disclaimer: Este documento es solo informativo y no constituye recomendación de inversión. " +
      "Cualquier decisión debe evaluarse con base en objetivos, tolerancia al riesgo y situación financiera del cliente. " +
      "INVERNORD no garantiza resultados futuros."
    );

    doc.end();

    await new Promise((resolve) => doc.on("end", resolve));
    const out = Buffer.concat(chunks);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${ticker || "REPORT"}_INVERNORD_report.pdf"`);
    return res.status(200).send(out);
  } catch (err) {
    console.error("API error:", err);
    return res.status(500).send(err?.message || "Internal Server Error");
  }
}
