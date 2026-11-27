// 生成测试固定数据：带文字层的多页 PDF（确定性日期，内容含标题、段落、表格与图形）。
// 运行：npm run fixtures
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const outDir = path.resolve('tests/fixtures');
fs.mkdirSync(outDir, { recursive: true });

const CREATED = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
const PAGE = { width: 595.28, height: 841.89 };
const marginX = 56;

function wrapText(text, font, size, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawParagraph(page, text, { x, y, width, font, size = 11, lineHeight = 16, color = rgb(0.12, 0.14, 0.2) }) {
  let cursorY = y;
  for (const line of wrapText(text, font, size, width)) {
    page.drawText(line, { x, y: cursorY, size, font, color });
    cursorY -= lineHeight;
  }
  return cursorY;
}

function drawFooter(page, font, label, pageNo, total) {
  page.drawLine({
    start: { x: marginX, y: 60 },
    end: { x: PAGE.width - marginX, y: 60 },
    thickness: 0.6,
    color: rgb(0.7, 0.72, 0.8),
  });
  page.drawText(`${label} — fixture generated for Readeva tests`, {
    x: marginX, y: 46, size: 8, font, color: rgb(0.45, 0.48, 0.58),
  });
  page.drawText(`${pageNo} / ${total}`, {
    x: PAGE.width - marginX - 32, y: 46, size: 8, font, color: rgb(0.45, 0.48, 0.58),
  });
}

function drawTable(page, { x, y, font, bold, rows }) {
  const colWidths = [220, 110, 130];
  const rowHeight = 22;
  const height = rowHeight * (rows.length + 1);

  page.drawRectangle({
    x, y: y - height, width: colWidths.reduce((a, b) => a + b, 0), height,
    borderColor: rgb(0.35, 0.38, 0.5), borderWidth: 0.8,
  });
  rows[0].forEach((cell, i) => {
    page.drawText(cell, {
      x: x + 6 + colWidths.slice(0, i).reduce((a, b) => a + b, 0),
      y: y - rowHeight + 6, size: 10, font: bold, color: rgb(0.1, 0.12, 0.2),
    });
  });
  for (let r = 1; r < rows.length; r += 1) {
    rows[r].forEach((cell, i) => {
      page.drawText(cell, {
        x: x + 6 + colWidths.slice(0, i).reduce((a, b) => a + b, 0),
        y: y - rowHeight * (r + 1) + 6, size: 10, font, color: rgb(0.15, 0.17, 0.24),
      });
    });
  }
  // 列分隔线
  let cx = x;
  for (const w of colWidths.slice(0, -1)) {
    cx += w;
    page.drawLine({
      start: { x: cx, y }, end: { x: cx, y: y - height },
      thickness: 0.6, color: rgb(0.55, 0.58, 0.68),
    });
  }
  // 行分隔线
  for (let r = 1; r < rows.length; r += 1) {
    const ry = y - rowHeight * r;
    page.drawLine({
      start: { x, y: ry }, end: { x: x + colWidths.reduce((a, b) => a + b, 0), y: ry },
      thickness: 0.6, color: rgb(0.55, 0.58, 0.68),
    });
  }
}

async function makeDocument({ title, label, pages, file }) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setAuthor('Readeva fixtures');
  doc.setCreator('Readeva make-fixtures');
  doc.setProducer('pdf-lib');
  doc.setCreationDate(CREATED);
  doc.setModificationDate(CREATED);

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  for (let i = 1; i <= pages; i += 1) {
    const page = doc.addPage([PAGE.width, PAGE.height]);

    page.drawText(`${label} · Chapter ${Math.ceil(i / 2)}`, {
      x: marginX, y: 780, size: 20, font: bold, color: rgb(0.1, 0.15, 0.4),
    });
    page.drawText(`Page ${i} of ${pages}`, {
      x: PAGE.width - marginX - 70, y: 784, size: 10, font, color: rgb(0.4, 0.43, 0.52),
    });

    drawParagraph(
      page,
      `${label} page ${i}: this fixture PDF carries a real text layer so browser tests can verify that the original layout is rendered. Paragraphs keep their position, size and order exactly as embedded.`,
      { x: marginX, y: 740, width: PAGE.width - marginX * 2, font },
    );

    drawParagraph(
      page,
      `Section ${i}.1 Inflight service procedures must follow the ordered checklist. Each step references the chapter table and the figure printed on the facing page of the manual.`,
      { x: marginX, y: 660, width: PAGE.width - marginX * 2, font },
    );

    if (i === 3) {
      drawTable(page, {
        x: marginX, y: 560, font, bold,
        rows: [
          ['Item', 'Qty', 'Location'],
          ['Service manual', '1', 'Chapter 3'],
          ['Checklist card', '2', 'Cabin rack'],
          ['Spare label set', '4', 'Storage bin'],
        ],
      });
    }

    if (i === 6) {
      // 矢量图形（模拟插页图示）
      page.drawRectangle({
        x: marginX, y: 380, width: 220, height: 140,
        color: rgb(0.9, 0.92, 1), borderColor: rgb(0.3, 0.34, 0.55), borderWidth: 1,
      });
      page.drawCircle({ x: marginX + 110, y: 450, size: 48, color: rgb(0.35, 0.42, 0.9) });
      page.drawRectangle({
        x: marginX + 300, y: 400, width: 160, height: 100,
        color: rgb(1, 0.85, 0.6), borderColor: rgb(0.75, 0.5, 0.2), borderWidth: 1,
      });
      page.drawText('Figure 6-1 layout diagram', {
        x: marginX, y: 356, size: 10, font: bold, color: rgb(0.2, 0.24, 0.4),
      });
    }

    drawParagraph(
      page,
      `Note ${i}: the reading position of this document is stored per content identity, so renaming the file does not change its identity in the library.`,
      { x: marginX, y: 120, width: PAGE.width - marginX * 2, font, size: 10, color: rgb(0.35, 0.38, 0.48) },
    );

    drawFooter(page, font, label, i, pages);
  }

  const bytes = await doc.save();
  fs.writeFileSync(path.join(outDir, file), bytes);
  console.log(`written ${file} (${bytes.length} bytes, ${pages} pages)`);
}

await makeDocument({
  title: 'Sample A — Inflight Service Manual (fixture)',
  label: 'Sample A',
  pages: 8,
  file: 'sample-a.pdf',
});
await makeDocument({
  title: 'Sample B — Quick Reference Card (fixture)',
  label: 'Sample B',
  pages: 4,
  file: 'sample-b.pdf',
});
