import express from 'express';
import { PDFDocument, StandardFonts } from 'pdf-lib'; // <--- ADDED StandardFonts
import pdf2img from 'pdf-img-convert';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

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

// FIXED ENDPOINT WITH APPEARANCE UPDATE + FLATTENING
app.post('/api/convert-to-images', async (req, res) => {
  try {
    const { pdf, pages } = req.body;
    if (!pdf) return res.status(400).json({ error: 'PDF data is required' });

    let pdfBuffer = Buffer.from(pdf, 'base64');

    // --- START FLATTENING FIX ---
    try {
      const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
      const form = doc.getForm();
      
      if (form) {
        // 1. Embed a standard font (required to draw the text)
        const helvetica = await doc.embedFont(StandardFonts.Helvetica);
        
        // 2. FORCE update the visual appearance of all fields using this font
        // This paints the text into the field box so it survives flattening
        form.updateFieldAppearances(helvetica);
        
        // 3. Now flatten (merge the painted text into the page layer)
        form.flatten();
        
        const flattenedBytes = await doc.save();
        pdfBuffer = Buffer.from(flattenedBytes);
        console.log('PDF form fields appearances updated & flattened successfully.');
      }
    } catch (e) {
      console.log('Flattening/Appearance update skipped:', e.message);
      // We continue even if flattening fails, using the original buffer
    }
    // --- END FLATTENING FIX ---

    const config = {
      base64: true,
      scale: 2.0 
    };

    if (pages && Array.isArray(pages) && pages.length > 0) {
      config.page_numbers = pages;
    }

    console.log(`Converting PDF to images.`);
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