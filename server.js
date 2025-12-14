import express from 'express';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import pdf2img from 'pdf-img-convert';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- HELPER: MANUALLY DRAW FORM DATA ONTO PAGES ---
async function forceFlatten(pdfDoc) {
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const black = rgb(0, 0, 0);

  for (const field of fields) {
    try {
      const type = field.constructor.name;
      const widgets = field.acroField.getWidgets();

      for (const widget of widgets) {
        // Find where this field is located
        const rect = widget.getRectangle();
        const page = pdfDoc.findPageForAnnotation(widget);

        if (!page || !rect) continue;

        // DRAW TEXT FIELDS
        if (type === 'PDFTextField') {
          const text = field.getText();
          if (text) {
            page.drawText(text, {
              x: rect.x + 2, // Slight padding
              y: rect.y + (rect.height / 2) - 4, // Center vertically
              size: 10, // Standard legible size
              font: font,
              color: black
            });
          }
        } 
        // DRAW CHECKBOXES
        else if (type === 'PDFCheckBox') {
          if (field.isChecked()) {
            page.drawText('X', {
              x: rect.x + (rect.width / 2) - 4, // Center horizontally
              y: rect.y + (rect.height / 2) - 4, // Center vertically
              size: 12,
              font: font,
              color: black
            });
          }
        }
      }
    } catch (err) {
      // If one field fails, skip it and keep going
      // console.log("Skipping field:", err.message);
    }
  }
  
  // Optional: Delete the form data now that we painted it, 
  // but keeping it doesn't hurt since we drew on top.
}

// SPLIT PDF ENDPOINT
app.post('/api/split-pdf', async (req, res) => {
  try {
    const { pdf, page } = req.body;
    if (!pdf) return res.status(400).json({ error: 'PDF data is required' });

    const pdfBuffer = Buffer.from(pdf, 'base64');
    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const pageCount = pdfDoc.getPageCount();

    if (page) {
      const pageNumber = parseInt(page);
      const pageIndex = pageNumber - 1;
      if (pageIndex < 0 || pageIndex >= pageCount) {
        return res.status(400).json({ error: 'Invalid page number', totalPages: pageCount });
      }
      const newPdf = await PDFDocument.create();
      const [copiedPage] = await newPdf.copyPages(pdfDoc, [pageIndex]);
      newPdf.addPage(copiedPage);
      const newPdfBytes = await newPdf.save();
      return res.status(200).json({
        page: pageNumber,
        totalPages: pageCount,
        base64: Buffer.from(newPdfBytes).toString('base64')
      });
    }

    const pages = [];
    for (let i = 0; i < pageCount; i++) {
      const newPdf = await PDFDocument.create();
      const [copiedPage] = await newPdf.copyPages(pdfDoc, [i]);
      newPdf.addPage(copiedPage);
      const newPdfBytes = await newPdf.save();
      pages.push({ page: i + 1, base64: Buffer.from(newPdfBytes).toString('base64') });
    }

    return res.status(200).json({ count: pageCount, pages: pages });
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// CONVERT TO IMAGES ENDPOINT (With Manual Flattening)
app.post('/api/convert-to-images', async (req, res) => {
  try {
    const { pdf, pages } = req.body;
    if (!pdf) return res.status(400).json({ error: 'PDF data is required' });

    let pdfBuffer = Buffer.from(pdf, 'base64');

    // 1. PERFORM MANUAL FLATTENING
    try {
      const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
      
      // Check if form exists
      const form = doc.getForm();
      if (form) {
        // Manually draw the text on top of the fields
        await forceFlatten(doc);
        
        // Save the modifications
        const flattenedBytes = await doc.save();
        pdfBuffer = Buffer.from(flattenedBytes);
        console.log('Manual flattening applied successfully.');
      }
    } catch (e) {
      console.log('Flattening skipped/failed:', e.message);
    }

    // 2. CONVERT TO IMAGES (Using pdf-img-convert)
    const config = {
      base64: true,
      scale: 2.0 
    };

    if (pages && Array.isArray(pages) && pages.length > 0) {
      config.page_numbers = pages;
    }

    console.log(`Converting PDF to images...`);
    const outputImages = await pdf2img.convert(pdfBuffer, config);

    const responseImages = outputImages.map((imgBase64, index) => {
      const pageNum = (pages && pages[index]) ? pages[index] : index + 1;
      return { page: pageNum, base64: imgBase64 };
    });

    return res.status(200).json({ count: responseImages.length, images: responseImages });

  } catch (error) {
    console.error('Error in convert-to-images:', error);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({ message: 'PDF Splitter API', endpoints: { health: 'GET /health', splitPdf: 'POST /api/split-pdf' } });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});