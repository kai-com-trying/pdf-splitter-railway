import express from 'express';
import { PDFDocument } from 'pdf-lib';
import { fromPath } from 'pdf2pic';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Helper to generate random temp filename
const getTempFilePath = (ext) => path.join(os.tmpdir(), `pdf-${Date.now()}-${Math.random().toString(36).substring(7)}.${ext}`);

// SPLIT PDF ENDPOINT (Kept same as before, uses pdf-lib)
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
    return res.status(500).json({ 
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// NEW CONVERT ENDPOINT (Uses Ghostscript via pdf2pic)
app.post('/api/convert-to-images', async (req, res) => {
  let tempPdfPath = null;
  
  try {
    const { pdf, pages } = req.body;
    if (!pdf) return res.status(400).json({ error: 'PDF data is required' });

    console.log("Processing PDF conversion request with Ghostscript...");

    // 1. Write the base64 PDF to a temp file on disk
    // We MUST write to disk for Ghostscript to process it reliably
    const pdfBuffer = Buffer.from(pdf, 'base64');
    tempPdfPath = getTempFilePath('pdf');
    await fs.writeFile(tempPdfPath, pdfBuffer);

    // 2. Configure pdf2pic (The Virtual Printer)
    const options = {
      density: 200,           // Quality (DPI)
      saveFilename: "output", 
      savePath: os.tmpdir(),  
      format: "png",
      width: 1700,            // Standard width for legible text
      height: 2200
    };

    const convert = fromPath(tempPdfPath, options);
    
    // 3. Determine which pages to convert
    // Note: pdf2pic is 1-indexed
    let pagesToConvert = [];
    if (pages && Array.isArray(pages) && pages.length > 0) {
      pagesToConvert = pages;
    } else {
      // If no pages specified, we need to know page count to loop
      const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
      const count = doc.getPageCount();
      pagesToConvert = Array.from({ length: count }, (_, i) => i + 1);
    }

    // 4. Convert specific pages
    const responseImages = [];
    
    // We process sequentially to keep order
    for (const pageNum of pagesToConvert) {
      try {
        // convert(pageNum) returns details about the saved file
        const result = await convert(pageNum, { responseType: "base64" });
        
        // pdf2pic saves to disk, so we read it back
        if (result.path) {
            const imageBuffer = await fs.readFile(result.path);
            const base64Str = imageBuffer.toString('base64');
            
            responseImages.push({
                page: pageNum,
                base64: base64Str
            });

            // Cleanup the individual image file
            await fs.unlink(result.path).catch(() => {});
        }
      } catch (err) {
        console.error(`Error converting page ${pageNum}:`, err);
      }
    }

    // 5. Cleanup the source PDF
    if (tempPdfPath) {
        await fs.unlink(tempPdfPath).catch(() => {});
    }

    return res.status(200).json({
      count: responseImages.length,
      images: responseImages
    });

  } catch (error) {
    console.error('Error in convert-to-images:', error);
    // Try to cleanup if error occurred
    if (tempPdfPath) await fs.unlink(tempPdfPath).catch(() => {});
    
    return res.status(500).json({ 
      error: error.message 
    });
  }
});

app.get('/', (req, res) => {
  res.json({ message: 'PDF Splitter API', endpoints: { health: 'GET /health', splitPdf: 'POST /api/split-pdf' } });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});