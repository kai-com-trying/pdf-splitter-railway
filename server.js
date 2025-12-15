import express from 'express';
import { PDFDocument } from 'pdf-lib';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- HELPER: FLATTEN FORM DATA ---
async function flattenPdfForm(pdfDoc) {
  try {
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    
    if (fields.length === 0) {
      return false;
    }
    
    form.flatten();
    console.log(`Flattened ${fields.length} form fields`);
    return true;
  } catch (err) {
    console.log('Form flattening skipped:', err.message);
    return false;
  }
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

// CONVERT TO IMAGES ENDPOINT (Using pdftoppm for better text rendering)
app.post('/api/convert-to-images', async (req, res) => {
  const tempDir = path.join(__dirname, 'temp');
  let tempPdfPath = null;
  let outputPrefix = null;

  try {
    const { pdf, pages } = req.body;
    if (!pdf) return res.status(400).json({ error: 'PDF data is required' });

    // Ensure temp directory exists
    await fs.mkdir(tempDir, { recursive: true });

    let pdfBuffer = Buffer.from(pdf, 'base64');

    // 1. FLATTEN THE PDF FORM
    try {
      const doc = await PDFDocument.load(pdfBuffer, { 
        ignoreEncryption: true,
        updateMetadata: false 
      });
      
      const wasFlattened = await flattenPdfForm(doc);
      
      if (wasFlattened) {
        const flattenedBytes = await doc.save({
          useObjectStreams: false,
          addDefaultPage: false
        });
        pdfBuffer = Buffer.from(flattenedBytes);
        console.log('PDF form flattened successfully');
      }
    } catch (e) {
      console.log('Flattening skipped/failed:', e.message);
    }

    // 2. SAVE TEMP PDF
    const timestamp = Date.now();
    tempPdfPath = path.join(tempDir, `input_${timestamp}.pdf`);
    outputPrefix = path.join(tempDir, `output_${timestamp}`);
    
    await fs.writeFile(tempPdfPath, pdfBuffer);

    // 3. CONVERT USING pdftoppm (part of poppler-utils)
    // -png: output as PNG
    // -r 150: 150 DPI (good quality for OCR)
    // -f and -l: first and last page to convert
    let command = `pdftoppm -png -r 150 "${tempPdfPath}" "${outputPrefix}"`;
    
    if (pages && Array.isArray(pages) && pages.length > 0) {
      // For specific pages, we need multiple commands
      const pageCommands = pages.map(pageNum => 
        `pdftoppm -png -r 150 -f ${pageNum} -l ${pageNum} "${tempPdfPath}" "${outputPrefix}_page${pageNum}"`
      );
      command = pageCommands.join(' && ');
    }

    console.log('Converting PDF to images using pdftoppm...');
    await execAsync(command);

    // 4. READ THE GENERATED IMAGES
    const files = await fs.readdir(tempDir);
    const imageFiles = files
      .filter(f => f.startsWith(`output_${timestamp}`) && f.endsWith('.png'))
      .sort();

    const responseImages = [];
    
    for (const file of imageFiles) {
      const filePath = path.join(tempDir, file);
      const imageBuffer = await fs.readFile(filePath);
      const base64Image = imageBuffer.toString('base64');
      
      // Extract page number from filename (format: output_timestamp-N.png)
      const match = file.match(/-(\d+)\.png$/);
      const pageNum = match ? parseInt(match[1]) : responseImages.length + 1;
      
      responseImages.push({ page: pageNum, base64: base64Image });
      
      // Clean up the image file
      await fs.unlink(filePath);
    }

    // Clean up temp PDF
    if (tempPdfPath) {
      await fs.unlink(tempPdfPath);
    }

    return res.status(200).json({ 
      count: responseImages.length, 
      images: responseImages 
    });

  } catch (error) {
    console.error('Error in convert-to-images:', error);
    
    // Cleanup on error
    try {
      if (tempPdfPath) await fs.unlink(tempPdfPath);
      if (outputPrefix) {
        const files = await fs.readdir(tempDir);
        const cleanupFiles = files.filter(f => f.startsWith(`output_${Date.now()}`));
        await Promise.all(cleanupFiles.map(f => fs.unlink(path.join(tempDir, f))));
      }
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError);
    }
    
    return res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({ 
    message: 'PDF Splitter API', 
    endpoints: { 
      health: 'GET /health', 
      splitPdf: 'POST /api/split-pdf',
      convertToImages: 'POST /api/convert-to-images'
    } 
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});