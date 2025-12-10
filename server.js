import express from 'express';
import { PDFDocument } from 'pdf-lib';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// Split PDF endpoint
app.post('/api/split-pdf', async (req, res) => {
  try {
    const { pdf, page } = req.body;

    if (!pdf) {
      return res.status(400).json({ error: 'PDF data is required' });
    }

    // Convert base64 to buffer
    const pdfBuffer = Buffer.from(pdf, 'base64');
    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });

    const pageCount = pdfDoc.getPageCount();

    // If page number specified, return single page
    if (page) {
      const pageNumber = parseInt(page);
      const pageIndex = pageNumber - 1;

      if (pageIndex < 0 || pageIndex >= pageCount) {
        return res.status(400).json({ 
          error: 'Invalid page number',
          totalPages: pageCount 
        });
      }

      const newPdf = await PDFDocument.create();
      const [copiedPage] = await newPdf.copyPages(pdfDoc, [pageIndex]);
      newPdf.addPage(copiedPage);

      const newPdfBytes = await newPdf.save();
      const base64Page = Buffer.from(newPdfBytes).toString('base64');

      return res.status(200).json({
        page: pageNumber,
        totalPages: pageCount,
        base64: base64Page
      });
    }

    // If no page number, split all pages
    const pages = [];
    for (let i = 0; i < pageCount; i++) {
      const newPdf = await PDFDocument.create();
      const [copiedPage] = await newPdf.copyPages(pdfDoc, [i]);
      newPdf.addPage(copiedPage);

      const newPdfBytes = await newPdf.save();
      const base64Page = Buffer.from(newPdfBytes).toString('base64');

      pages.push({
        page: i + 1,
        base64: base64Page
      });
    }

    return res.status(200).json({
      count: pageCount,
      pages: pages
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ 
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'PDF Splitter API',
    endpoints: {
      health: 'GET /health',
      splitPdf: 'POST /api/split-pdf'
    }
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});