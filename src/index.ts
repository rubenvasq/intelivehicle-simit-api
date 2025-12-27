import express from "express";
import { chromium } from "playwright";
import cors from "cors";

const app = express();

const PORT = Number(process.env.PORT) || 3333;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:8080";

app.use(
  cors({
    origin: FRONTEND_URL,
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json({ limit: "50kb" }));

function extractFirstMoney(raw: string | null | undefined): number {
  if (!raw) return 0;
  const match = raw.match(/\$?\s*([\d.]+)/);
  if (!match) return 0;
  const cleaned = match[1].replace(/\./g, "");
  if (!cleaned) return 0;
  return Number(cleaned);
}

function buildFinesFromSnapshot(snapshot: any) {
  if (!snapshot?.tables || !Array.isArray(snapshot.tables)) return [];

  const fines: any[] = [];

  for (const table of snapshot.tables) {
    const headers: string[] = table.headers || [];
    const rows: string[][] = table.rows || [];

    const upperHeaders = headers.map((h) => h.toUpperCase());

    const idxTipo = upperHeaders.findIndex((h) => h.includes("TIPO"));
    const idxPlaca = upperHeaders.findIndex((h) => h.includes("PLACA"));
    const idxSecretaria = upperHeaders.findIndex((h) => h.includes("SECRETAR"));
    const idxInfraccion = upperHeaders.findIndex((h) => h.includes("INFRAC"));
    const idxEstado = upperHeaders.findIndex((h) => h.includes("ESTADO"));
    const idxValor = upperHeaders.findIndex(
      (h) => h.includes("VALOR") && !h.includes("A PAGAR")
    );
    const idxValorPagar = upperHeaders.findIndex((h) =>
      h.includes("VALOR A PAGAR")
    );

    const isFineTable =
      idxTipo >= 0 &&
      idxPlaca >= 0 &&
      idxSecretaria >= 0 &&
      idxInfraccion >= 0 &&
      idxEstado >= 0 &&
      (idxValor >= 0 || idxValorPagar >= 0);

    if (!isFineTable) continue;

    for (const row of rows) {
      const tipoCell = idxTipo >= 0 ? row[idxTipo] || "" : "";
      const placa = idxPlaca >= 0 ? row[idxPlaca] || "" : "";
      const secretaria = idxSecretaria >= 0 ? row[idxSecretaria] || "" : "";
      const infraccion = idxInfraccion >= 0 ? row[idxInfraccion] || "" : "";
      const estado = idxEstado >= 0 ? row[idxEstado] || "" : "";
      const valorCell = idxValor >= 0 ? row[idxValor] || "" : "";
      const valorPagarCell =
        idxValorPagar >= 0 ? row[idxValorPagar] || "" : "";

      const numberMatch = tipoCell.match(/(\d{6,})/);
      const number = numberMatch ? numberMatch[1] : "";

      const dateMatch = tipoCell.match(/(\d{2}\/\d{2}\/\d{4})/);
      const dateCoactivo = dateMatch ? dateMatch[1] : null;

      const baseValue = extractFirstMoney(valorCell);
      const totalToPay = extractFirstMoney(valorPagarCell);

      const hasAny =
        number ||
        placa ||
        secretaria ||
        infraccion ||
        estado ||
        baseValue ||
        totalToPay;

      if (!hasAny) continue;

      fines.push({
        number,
        dateCoactivo,
        plate: placa,
        secretary: secretaria,
        infraction: infraccion,
        status: estado,
        baseValue,
        totalToPay,
      });
    }
  }

  return fines;
}

async function waitForResultsWithRetry(
  page: any,
  maxRetries = 3
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`   Intento ${attempt}/${maxRetries} esperando resultados...`);

    try {
      await page.waitForFunction(
        () => {
          const bodyText = document.body.textContent || "";
          const tableRows = document.querySelectorAll("table tbody tr");
          const hasTableData = Array.from(tableRows).some((row) => {
            const text = row.textContent || "";
            return (
              text.includes("Multa") ||
              text.includes("Comparendo") ||
              text.includes("$") ||
              text.length > 50
            );
          });
          const noDataMessages = [
            "Acuerdos de pago: 0",
            "no tiene comparendos",
            "sin comparendos",
          ];
          const hasNoData = noDataMessages.some((msg) => bodyText.includes(msg));
          return hasTableData || hasNoData;
        },
        { timeout: 10000 }
      );

      console.log(`   ✅ Resultados encontrados en intento ${attempt}`);
      return true;
    } catch (e) {
      console.log(`   ⚠️ Intento ${attempt} falló, esperando 2s...`);
      if (attempt < maxRetries) {
        await page.waitForTimeout(2000);
        try {
          const searchBtn = page
            .locator("button.btn-primary, button:has(i.fa-search)")
            .first();
          if ((await searchBtn.count()) > 0) {
            await searchBtn.click({ timeout: 2000 });
            console.log(`   🔄 Botón de búsqueda clickeado nuevamente`);
          }
        } catch {}
      }
    }
  }

  console.log(`   ⚠️ No se encontraron resultados después de ${maxRetries} intentos`);
  return false;
}

app.post("/api/simit", async (req, res) => {
  const placa = String(req.body?.placa ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");

  if (!placa) {
    return res.status(400).json({ ok: false, error: "placa_required" });
  }

  let browser: any;
  let context: any;
  const startTime = Date.now();

  try {
    console.log(`\n🔍 [${new Date().toISOString()}] Consultando placa: ${placa}`);

    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    console.log(`1️⃣ Navegando a SIMIT...`);

    let navigationSuccess = false;
    for (let i = 0; i < 2; i++) {
      try {
        await page.goto("https://www.fcm.org.co/simit/#/estado-cuenta", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        navigationSuccess = true;
        break;
      } catch (e) {
        console.log(`   ⚠️ Intento de navegación ${i + 1} falló`);
        if (i === 1) throw e;
        await page.waitForTimeout(2000);
      }
    }

    if (!navigationSuccess) {
      throw new Error("No se pudo cargar el sitio de SIMIT");
    }

    console.log(`2️⃣ Esperando input de búsqueda...`);
    await page.waitForSelector("#txtBusqueda", { timeout: 20000 });
    await page.waitForTimeout(2000);

    console.log(`3️⃣ Ingresando placa: ${placa}`);
    await page.fill("#txtBusqueda", placa);
    await page.waitForTimeout(800);

    console.log(`4️⃣ Ejecutando búsqueda...`);

    await page.press("#txtBusqueda", "Enter");
    await page.waitForTimeout(1000);

    try {
      const searchBtn = page
        .locator("button.btn-primary, button:has(i.fa-search)")
        .first();
      if ((await searchBtn.count()) > 0 && (await searchBtn.isVisible())) {
        await searchBtn.click({ timeout: 2000 });
        console.log(`   ✅ Botón de búsqueda clickeado adicional`);
      }
    } catch (e) {
      console.log(`   ℹ️ No se encontró botón adicional (normal)`);
    }

    console.log(`5️⃣ Esperando resultados...`);

    await waitForResultsWithRetry(page, 3);

    await page.waitForTimeout(3000);

    console.log(`6️⃣ Capturando datos de la página...`);

    const snapshot = await page.evaluate(() => {
      const txt = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

      const tables = Array.from(document.querySelectorAll("table"))
        .map((table, idx) => {
          const headers = Array.from(table.querySelectorAll("thead th, thead td"))
            .map((th) => txt(th))
            .filter((h) => h.length > 0);

          const rows = Array.from(table.querySelectorAll("tbody tr"))
            .map((tr) => Array.from(tr.querySelectorAll("td, th")).map((td) => txt(td)))
            .filter((row) => row.length > 0 && row.some((cell) => cell.length > 0));

          return { tableIndex: idx, headers, rows, rowCount: rows.length };
        })
        .filter((t) => t.rowCount > 0);

      const bodyText = txt(document.body);

      const acuerdosMatch = bodyText.match(/Acuerdos\s+de\s+pago:\s*(\d+)/i);
      const acuerdosDePago = acuerdosMatch ? parseInt(acuerdosMatch[1]) : null;

      const totalMatch = bodyText.match(/Total\s*\((\d+)\):\s*\$\s*([\d.,]+)/i);
      const totalValue = totalMatch ? totalMatch[2] : null;
      const totalCount = totalMatch ? parseInt(totalMatch[1]) : null;

      const noData = bodyText.includes("Acuerdos de pago: 0") && tables.length === 0;

      return {
        noData,
        tables,
        tablesFound: tables.length,
        acuerdosDePago,
        totalValue,
        totalCount,
        bodySnippet: bodyText.slice(0, 500),
      };
    });

    console.log(`7️⃣ Procesando datos...`);
    console.log(`   Tablas encontradas: ${snapshot.tablesFound}`);
    console.log(`   Acuerdos de pago: ${snapshot.acuerdosDePago}`);

    const fines = buildFinesFromSnapshot(snapshot);
    const totalValueNumber = snapshot.totalValue ? extractFirstMoney(snapshot.totalValue) : 0;

    const totalAmountFromFines = fines.reduce(
      (acc: number, f: any) => acc + (f.totalToPay || f.baseValue || 0),
      0
    );
    const totalAmount = totalAmountFromFines || totalValueNumber;

    const hasDebt =
      fines.length > 0 ||
      (totalAmount && totalAmount > 0) ||
      (snapshot.acuerdosDePago != null && snapshot.acuerdosDePago > 0);

    const duration = Date.now() - startTime;
    console.log(
      `✅ Consulta exitosa en ${duration}ms: ${fines.length} multas, Total: $${totalAmount}`
    );

    return res.json({
      ok: true,
      placa,
      hasDebt,
      count: fines.length,
      totalAmount,
      fines,
      metadata: {
        queryTime: duration,
        timestamp: new Date().toISOString(),
        tablesFound: snapshot.tablesFound,
      },
    });
  } catch (e: any) {
    const duration = Date.now() - startTime;
    console.error(`❌ Error después de ${duration}ms consultando ${placa}:`, e.message);

    let screenshotPath = null;
    try {
      if (context) {
        const page = context.pages()[0];
        if (page) {
          screenshotPath = `error-${placa}-${Date.now()}.png`;
          await page.screenshot({ path: screenshotPath, fullPage: true });
          console.log(`📸 Screenshot guardado: ${screenshotPath}`);
        }
      }
    } catch {}

    return res.json({
      ok: true,
      placa,
      hasDebt: false,
      count: 0,
      totalAmount: 0,
      fines: [],
      error: {
        message: "No se pudo consultar SIMIT en este momento",
        details: e?.message || "Error desconocido",
        screenshot: screenshotPath,
      },
      metadata: {
        queryTime: duration,
        timestamp: new Date().toISOString(),
        failed: true,
      },
    });
  } finally {
    try {
      await context?.close();
    } catch {}
    try {
      await browser?.close();
    } catch {}
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 SIMIT API running on port ${PORT}`);
  console.log(`🌐 CORS enabled for: ${FRONTEND_URL}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});
